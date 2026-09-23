// The Claude brain: one Messages API call per decision point, forced into a
// single tool call. Stateless per turn: the whole call context is rendered into
// one user message, so the static system prompt and tool list cache cleanly.

import Anthropic from '@anthropic-ai/sdk';
import type { Decision } from '../core/types.js';
import type { Brain, BrainState } from './brain.js';
import { renderContext, SYSTEM_PROMPT, toDecision, TOOL_SPECS } from './prompt.js';

export interface ClaudeBrainOptions {
  client?: Anthropic;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export class ClaudeBrain implements Brain {
  readonly name = 'claude';
  readonly model: string;
  private client: Anthropic;
  private effort: NonNullable<ClaudeBrainOptions['effort']>;

  constructor(opts: ClaudeBrainOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.VOICED_MODEL ?? 'claude-opus-5';
    // Phone trees punish slow callers; low effort keeps each turn quick.
    this.effort = opts.effort ?? (process.env.VOICED_EFFORT as ClaudeBrainOptions['effort']) ?? 'low';
  }

  async decide(s: BrainState): Promise<Decision> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: this.effort },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOL_SPECS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: `${renderContext(s)}\n\nCall exactly one tool now.` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('model refused this turn');
    if (response.stop_reason === 'max_tokens') throw new Error('model output was truncated');
    const call = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!call) throw new Error('model answered without a tool call');
    return toDecision(call.name, call.input as Record<string, unknown>, s);
  }
}
