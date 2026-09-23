import type { Task } from '../../core/types.js';
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
  script(): IvrScript;
  task(opts?: ScenarioOptions): { task: Task; secrets: Record<string, string> };
}
