// A Claude brain for the published demo page: asks Claude through the artifact
// runtime's `sample` capability (on the viewer's own Claude account) and reads
// back one JSON action per decision point.

import type { Brain, BrainState } from '../src/brains/brain.js';
import { JSON_INSTRUCTIONS, renderContext, SYSTEM_PROMPT, toDecision } from '../src/brains/prompt.js';
import type { Decision } from '../src/core/types.js';

type SampleJson = (input: string, opts?: { modelTier?: 'quick' | 'default' | 'complex'; cache?: boolean }) => Promise<unknown>;

export interface SampleFn {
  json: SampleJson;
}

export class SampleBrain implements Brain {
  readonly name = 'claude';

  constructor(private sample: SampleFn) {}

  async decide(s: BrainState): Promise<Decision> {
    const prompt = `${SYSTEM_PROMPT}\n\n${renderContext(s)}\n\n${JSON_INSTRUCTIONS}`;
    const out = (await this.sample.json(prompt, { modelTier: 'quick', cache: false })) as Record<string, unknown> | null;
    if (!out || typeof out.tool !== 'string') throw new Error('no action in reply');
    return toDecision(out.tool, out, s);
  }
}
