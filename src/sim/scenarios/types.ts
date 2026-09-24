import type { OperatorCommand } from '../../core/operators.js';
import type { FailureReason, Resolution, Task } from '../../core/types.js';
import type { IvrScript } from '../engine.js';

export interface ScenarioOptions {
  cardId?: string;
  cvv?: string;
  maxAmount?: number;
  maxFee?: number;
}

export interface Scenario {
  id: string;
  business: string;
  phone: string;
  category: 'Bill pay' | 'Cancellation' | 'Reservation' | 'Reach a human';
  /** The button label, in the user's words. */
  title: string;
  /** What the user would otherwise have to do. */
  pain: string[];
  /** Whether the consumer demo features it up front. */
  featured: boolean;
  /** Eval: the outcome a correct agent produces. `warm` is the expected outcome once the map has seen the tree. */
  expect: { resolution: Resolution; reason?: FailureReason; warm?: Resolution };
  /** Eval: run this scenario on a map that already learned another one (e.g. a menu that changed). */
  warmWith?: string;
  /** A hard case: dead ends, loops, identity checks, closures. */
  hard?: boolean;
  /** What a human operator does when the AI escalates (the scripted stand-in follows this). */
  operatorPlaybook?: OperatorCommand[];
  /** What the simulated user answers when asked for missing information, by fact key. */
  userInputs?: Record<string, string>;
  script(): IvrScript;
  task(opts?: ScenarioOptions): { task: Task; secrets: Record<string, string> };
}
