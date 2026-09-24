import { bedford } from './bedford.js';
import { hardCases } from './hard.js';
import { ironTemple } from './irontemple.js';
import { kestrel } from './kestrel.js';
import { luna } from './luna.js';
import type { Scenario } from './types.js';

/** The demo trees. */
export const scenarios: Scenario[] = [bedford, ironTemple, kestrel, luna];

/** Demo trees plus the hard cases the eval harness scores. */
export const allScenarios: Scenario[] = [...scenarios, ...hardCases];

export function getScenario(id: string): Scenario | undefined {
  return allScenarios.find((s) => s.id === id);
}

export { persona } from './persona.js';
export type { Scenario, ScenarioOptions } from './types.js';
