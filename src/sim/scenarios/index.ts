import { bedford } from './bedford.js';
import { ironTemple } from './irontemple.js';
import { kestrel } from './kestrel.js';
import { luna } from './luna.js';
import type { Scenario } from './types.js';

export const scenarios: Scenario[] = [bedford, ironTemple, kestrel, luna];

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}

export { persona } from './persona.js';
export type { Scenario, ScenarioOptions } from './types.js';
