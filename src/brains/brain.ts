import type { Decision, Fact, Speaker, Task, TurnAnalysis, UserRequest, UserResponse } from '../core/types.js';

export interface HistoryItem {
  who: 'ivr' | 'human' | 'hold' | 'agent' | 'user' | 'system';
  text: string;
}

export interface Grant {
  request: UserRequest;
  response: UserResponse;
}

/** Everything a brain may look at. All text is already scrubbed of secrets. */
export interface BrainState {
  task: Task;
  /** What the far end said since our last action. */
  turn: string[];
  speaker: Speaker;
  analysis: TurnAnalysis;
  history: HistoryItem[];
  notes: Record<string, string>;
  grants: Grant[];
  counters: {
    /** Times the current prompt has been heard without us acting. */
    silences: number;
    /** Times we've asked for a human. */
    escalations: number;
    /** Agent turns spent talking to a live human. */
    humanTurns: number;
    /** Invalid-input responses from the IVR, total. */
    invalids: number;
  };
  /** Screen hint from the IVR map, when this turn matches a known screen. */
  mapHint?: string;
  /** How many times each fact was entered on this call. */
  entered: Record<string, number>;
}

export interface Brain {
  readonly name: string;
  decide(state: BrainState): Promise<Decision>;
}

export function factByKey(task: Task, key: string): Fact | undefined {
  return task.facts.find((f) => f.key === key);
}
