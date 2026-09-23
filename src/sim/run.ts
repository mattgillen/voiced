// Wire a scenario into a live CallSession: simulated line, vault, brain, map.

import type { Brain } from '../brains/brain.js';
import { RulesBrain } from '../brains/rules.js';
import { MapMemory } from '../core/memory.js';
import { CallSession } from '../core/session.js';
import { Vault } from '../core/vault.js';
import { instantClock, SimLine, type SimClock } from './engine.js';
import { getScenario, type ScenarioOptions } from './scenarios/index.js';

export interface SimulateOptions {
  brain?: Brain;
  memory?: MapMemory;
  clock?: SimClock;
  scenario?: ScenarioOptions;
  id?: string;
}

export function simulate(scenarioId: string, opts: SimulateOptions = {}) {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error(`unknown scenario "${scenarioId}"`);
  const { task, secrets } = scenario.task(opts.scenario);
  const line = new SimLine(scenario.script(), opts.clock ?? instantClock);
  const vault = new Vault(task.facts, secrets);
  const session = new CallSession({
    id: opts.id,
    task,
    line,
    brain: opts.brain ?? new RulesBrain(),
    fallback: new RulesBrain(),
    memory: opts.memory ?? new MapMemory(),
    vault,
  });
  return { session, line, task, scenario };
}
