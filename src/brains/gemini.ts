// The Gemini brain: same prompt, same seven tools and the same validation as the
// Claude brain, over the Gemini API's REST endpoint (no SDK). Function calling is
// forced (mode ANY), so every turn comes back as exactly one tool call.
//
// Free-tier keys work, with two caveats: rate limits (a 429 falls back to rules
// unless maxRetryWaitMs allows waiting it out), and Google's terms for unpaid
// use, which let Google use prompts and responses to improve its products.
// Secrets never reach any brain, but names, ZIPs and transcripts do.

import type { Decision } from '../core/types.js';
import type { Brain, BrainState } from './brain.js';
import { renderContext, SYSTEM_PROMPT, toDecision, TOOL_SPECS } from './prompt.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiBrainOptions {
  apiKey?: string;
  model?: string;
  /** "low" / "high" set thinkingLevel; a number sets thinkingBudget (0 turns thinking off on 2.5 models). */
  thinking?: string;
  /** How long to wait out a rate limit before giving the turn to rules. 0 = never wait (live calls). */
  maxRetryWaitMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code: number; message: string; status: string; details?: { '@type'?: string; retryDelay?: string }[] };
}

const DECLARATIONS = TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));

export class GeminiBrain implements Brain {
  readonly name = 'gemini';
  readonly model: string;
  private apiKey: string;
  private thinking?: string;
  private maxRetryWaitMs: number;
  private fetch: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private warned = new Set<string>();

  constructor(opts: GeminiBrainOptions = {}) {
    const key = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GeminiBrain needs GEMINI_API_KEY');
    this.apiKey = key;
    this.model = opts.model ?? process.env.VOICED_GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;
    this.thinking = opts.thinking ?? process.env.VOICED_GEMINI_THINKING;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 0;
    this.fetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async decide(s: BrainState): Promise<Decision> {
    try {
      return await this.attempt(s);
    } catch (err) {
      // The session falls back to rules; say why once, so a bad key or model name isn't silent.
      const msg = (err as Error).message;
      if (!this.warned.has(msg)) {
        this.warned.add(msg);
        console.warn(`[gemini] ${msg} (rules took this turn)`);
      }
      throw err;
    }
  }

  private async attempt(s: BrainState): Promise<Decision> {
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: `${renderContext(s)}\n\nCall exactly one tool now.` }] }],
      tools: [{ functionDeclarations: DECLARATIONS }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { temperature: 0, ...this.thinkingConfig() },
    };
    const url = `${ENDPOINT}/models/${encodeURIComponent(this.model)}:generateContent`;
    let waited = 0;
    for (;;) {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as GeminiResponse;
      if (res.status === 429) {
        const delay = retryDelayMs(json) ?? 10_000;
        if (waited + delay <= this.maxRetryWaitMs) {
          waited += delay;
          await this.sleep(delay);
          continue;
        }
        throw new Error(`rate limited by Gemini (${this.model}): ${json.error?.message ?? 'quota exceeded'}`);
      }
      if (!res.ok) throw new Error(`Gemini ${res.status} (${this.model}): ${json.error?.message ?? res.statusText}`);
      if (json.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}`);
      const candidate = json.candidates?.[0];
      const call = candidate?.content?.parts?.find((p) => p.functionCall)?.functionCall;
      if (!call) throw new Error(`Gemini answered without a tool call (finish: ${candidate?.finishReason ?? 'none'})`);
      return toDecision(call.name, call.args ?? {}, s);
    }
  }

  private thinkingConfig() {
    const t = this.thinking?.trim();
    if (!t) return {};
    return /^-?\d+$/.test(t) ? { thinkingConfig: { thinkingBudget: Number(t) } } : { thinkingConfig: { thinkingLevel: t } };
  }
}

/** Gemini's 429s carry a google.rpc.RetryInfo with retryDelay like "13s" or "0.5s". */
function retryDelayMs(json: GeminiResponse): number | undefined {
  const info = json.error?.details?.find((d) => d['@type']?.endsWith('RetryInfo'));
  const m = info?.retryDelay?.match(/^([\d.]+)s$/);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}
