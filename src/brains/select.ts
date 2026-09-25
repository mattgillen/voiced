// Which brain drives calls. VOICED_BRAIN picks explicitly (rules | claude | gemini);
// otherwise the first key present wins: ANTHROPIC_API_KEY, then GEMINI_API_KEY.
// Rules always stand behind the model, so a failed or rate-limited turn still gets an answer.

import type { Brain } from './brain.js';
import { ClaudeBrain } from './claude.js';
import { GEMINI_DEFAULT_MODEL, GeminiBrain, type GeminiBrainOptions } from './gemini.js';
import { RulesBrain } from './rules.js';

export type BrainKind = 'rules' | 'claude' | 'gemini';

export function brainKind(env: NodeJS.ProcessEnv = process.env, flags: string[] = []): BrainKind {
  if (flags.includes('--rules')) return 'rules';
  if (flags.includes('--claude')) return 'claude';
  if (flags.includes('--gemini')) return 'gemini';
  const pick = env.VOICED_BRAIN;
  if (pick === 'rules' || pick === 'claude' || pick === 'gemini') return pick;
  if (env.ANTHROPIC_API_KEY) return 'claude';
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'gemini';
  return 'rules';
}

export function makeBrain(kind: BrainKind, gemini: GeminiBrainOptions = {}): Brain {
  if (kind === 'claude') return new ClaudeBrain();
  if (kind === 'gemini') return new GeminiBrain(gemini);
  return new RulesBrain();
}

export function describeBrain(kind: BrainKind, env: NodeJS.ProcessEnv = process.env): string {
  if (kind === 'claude') return `Claude (${env.VOICED_MODEL ?? 'claude-opus-5'})`;
  if (kind === 'gemini') return `Gemini (${env.VOICED_GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL})`;
  return 'rules (set GEMINI_API_KEY or ANTHROPIC_API_KEY for a model)';
}
