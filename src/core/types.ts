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
  /** The call is being recorded: every person on it is told (all-party consent). */
  recorded?: boolean;
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
  /** Pause or resume call recording (PCI: nothing is recorded while card digits are keyed). */
  setRecording?(on: boolean): Promise<void>;
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
  /** Ask the user for something the task doesn't have (e.g. an identity check). Stored in the vault if secret. */
  | { kind: 'input'; title: string; detail: string; secret?: boolean; factKey?: string; factLabel?: string; aliases?: string[] };

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
  /** Stuck: hand the call and its context to a human operator. Never just fail. */
  | { type: 'escalate'; reason: FailureReason; detail: string }
  | { type: 'hangup'; outcome: 'success' | 'failure'; summary: string };

export type DecisionSource = 'map' | 'rules' | 'llm' | 'guard' | 'operator';

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
  | 'with_operator'
  | 'handing_off'
  | 'user_connected'
  | 'ended';

// ---------------------------------------------------------------------------
// Outcomes: every call ends as exactly one of these, with a reason and a step.

/** Top-line metric: share of calls with resolution "ai". */
export type Resolution = 'ai' | 'human_assisted' | 'failed';

export type FailureReason =
  /** Nothing on the tree leads to the goal. */
  | 'dead_end'
  /** The tree keeps sending the call back to the same screen. */
  | 'loop'
  /** A verification step the agent can't pass on its own. */
  | 'identity_check'
  /** Closed, system down, or the queue refuses callers. */
  | 'business_unavailable'
  /** The far end hung up unexpectedly. */
  | 'hung_up'
  /** The call was never placed (the carrier refused it: credentials, number, account). */
  | 'dial_failed'
  | 'user_declined'
  | 'timeout'
  /** A human operator couldn't fix it either. */
  | 'unresolved';

/** The billable, auditable thing the call achieved (pricing is per result, not per minute). */
export type ResultKind = 'bill_paid' | 'membership_canceled' | 'reservation_booked' | 'human_reached';

export interface ResultRecord {
  kind: ResultKind;
  confirmation?: string;
  amount?: string;
  /** The exact line on the call that proves it, with its call time. */
  evidence?: { t: number; text: string };
}

export interface FailureRecord {
  reason: FailureReason;
  detail: string;
  /** The screen or state where it broke. */
  step: string;
  t: number;
}

export interface CallResult {
  outcome: 'success' | 'failure';
  resolution: Resolution;
  /** Set when the goal was achieved. */
  result?: ResultRecord;
  /** Where and why it broke. Also kept when an operator rescued the call, so every exception becomes training data. */
  failure?: FailureRecord;
  summary: string;
  notes: Record<string, string>;
  callMs: number;
  holdMs: number;
  userTouches: number;
  escalations: number;
  operatorTouches: number;
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
  | { type: 'escalated'; t: number; ticketId: string; reason: FailureReason; detail: string; step: string }
  | { type: 'operator'; t: number; ticketId: string; state: 'joined' | 'returned' | 'closed'; operator: string; note?: string }
  | { type: 'recording'; t: number; paused: boolean; reason: string }
  | { type: 'bridge'; t: number; from: 'user' | 'human'; text: string }
  | { type: 'ended'; t: number; result: CallResult };
