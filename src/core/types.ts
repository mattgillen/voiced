// Shared types for the Voiced call engine. Nothing in src/core, src/brains or
// src/sim touches Node APIs, so the same engine runs on the server and in the browser.

export type TaskKind = 'pay_bill' | 'reservation' | 'reach_human' | 'cancel';

/** A piece of user context the agent may need to hand to an IVR. */
export interface Fact {
  key: string;
  label: string;
  /** Plain value, visible to the model. Omitted for secrets. */
  value?: string;
  /** Secret facts live only in the vault; the model sees `display` and uses {{key}}. */
  secret?: boolean;
  /** Redacted rendering, e.g. "•••• 4242". */
  display?: string;
  /** Phrases an IVR uses when asking for this fact, most specific first. */
  aliases: string[];
  /** How to answer a speech prompt, if different from `value`. */
  spoken?: string;
}

export interface PaymentAuthorization {
  cardId: string;
  cardLabel: string;
  /** Maximum amount (excluding fees) the user pre-approved. */
  maxAmount: number;
  /** Fees the user pre-approved. Anything above this triggers a mid-call approval. */
  maxFee: number;
}

export interface TaskPolicy {
  /** Tell live humans that they are talking to an AI assistant. */
  discloseAI: boolean;
  declineRetentionOffers?: boolean;
  /** Bridge the user in once a live human is on the line. */
  handoffToUser?: boolean;
  payment?: PaymentAuthorization;
  /** The user authorized an irreversible action such as a cancellation. */
  authorizedCommit?: boolean;
}

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  /** Natural-language goal handed to the model. */
  goal: string;
  business: string;
  phone: string;
  user: { name: string; firstName: string };
  /** Menu keywords with weights. Negative weights steer away from options. */
  navHints: Record<string, number>;
  /** What to say at open-ended "how can I help?" prompts. */
  intentPhrase: string;
  /** One-line purpose used when briefing a human. */
  purpose: string;
  facts: Fact[];
  policy: TaskPolicy;
  prefs?: {
    /** Acceptable reservation window, minutes since midnight. */
    timeWindow?: [number, number];
    specialRequests?: string;
  };
  /** What "done" looks like, used to decide when to hang up. */
  successNote: string;
}

// ---------------------------------------------------------------------------
// Telephony line abstraction (simulator and Twilio both implement it)

export type Speaker = 'ivr' | 'human' | 'hold';

export type LineEvent =
  | { kind: 'speech'; speaker: Speaker; text: string; durationMs: number }
  /** Far end stopped talking and is waiting for input. */
  | { kind: 'silence'; durationMs: number }
  | { kind: 'hangup'; by: 'remote' | 'local' };

export interface Line {
  readonly simulated: boolean;
  dial(): Promise<void>;
  next(): Promise<LineEvent>;
  sendDigits(digits: string): Promise<void>;
  say(text: string): Promise<void>;
  /** Warm transfer: connect the user to the far end. */
  bridge(): Promise<void>;
  /** Relay a message from the bridged user (simulator only; real calls carry audio). */
  userSays?(text: string): Promise<void>;
  hangup(): Promise<void>;
  /** Milliseconds of call time elapsed (simulated or wall clock). */
  now(): number;
  /** Advance call time by work done outside the line (model latency, user think time). */
  elapse(ms: number): void;
}

// ---------------------------------------------------------------------------
// Agent decisions

export type UserRequest =
  | {
      kind: 'approve_payment';
      title: string;
      detail: string;
      amount: number;
      fee: number;
      cardLabel: string;
    }
  | { kind: 'approve'; title: string; detail: string }
  | { kind: 'choose'; title: string; detail: string; options: string[] }
  | { kind: 'input'; title: string; detail: string; secret?: boolean; factKey?: string };

export interface UserResponse {
  approved: boolean;
  choice?: string;
  text?: string;
}

export type Action =
  /** DTMF. May contain {{fact.key}} placeholders, resolved from the vault at send time. */
  | { type: 'press'; digits: string }
  /** Speech. May contain {{fact.key}} placeholders for non-secret facts. */
  | { type: 'say'; text: string }
  | { type: 'wait' }
  | { type: 'ask_user'; request: UserRequest }
  | { type: 'handoff'; briefing: string }
  | { type: 'hangup'; outcome: 'success' | 'failure'; summary: string };

export type DecisionSource = 'map' | 'rules' | 'llm' | 'guard';

export interface Decision {
  action: Action;
  reason: string;
  source: DecisionSource;
  notes?: Record<string, string>;
  /** Whether this decision can be replayed from the IVR map on future calls. */
  cacheable?: boolean;
}

export interface MenuOption {
  key: string;
  label: string;
  via: 'dtmf' | 'speech';
}

export type TurnKind =
  | 'menu'
  | 'input'
  | 'question'
  | 'confirm'
  | 'commit'
  | 'hold'
  | 'human'
  | 'info'
  | 'goodbye';

export interface TurnAnalysis {
  kind: TurnKind;
  options: MenuOption[];
  title: string;
}

// ---------------------------------------------------------------------------
// Events streamed to UIs and API clients

export type CallStatus =
  | 'dialing'
  | 'navigating'
  | 'on_hold'
  | 'talking_to_human'
  | 'awaiting_user'
  | 'handing_off'
  | 'user_connected'
  | 'ended';

export interface CallResult {
  outcome: 'success' | 'failure';
  summary: string;
  notes: Record<string, string>;
  callMs: number;
  holdMs: number;
  userTouches: number;
  turns: number;
  mapHits: number;
  llmCalls: number;
}

export type CallEvent =
  | { type: 'status'; t: number; status: CallStatus; detail?: string }
  | { type: 'heard'; t: number; speaker: Speaker; text: string; turn: number }
  | { type: 'turn'; t: number; turn: number; analysis: TurnAnalysis; fingerprint: string; known: boolean }
  | {
      type: 'action';
      t: number;
      turn: number;
      action: Action;
      /** Redacted rendering of what went down the line. */
      display: string;
      source: DecisionSource;
      reason: string;
      latencyMs: number;
    }
  | { type: 'note'; t: number; key: string; value: string }
  | { type: 'user_request'; t: number; id: string; request: UserRequest }
  | { type: 'user_response'; t: number; id: string; response: UserResponse }
  | { type: 'handoff'; t: number; briefing: string }
  | { type: 'bridge'; t: number; from: 'user' | 'human'; text: string }
  | { type: 'ended'; t: number; result: CallResult };
