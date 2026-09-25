// CallSession runs one phone call: it listens to the line, replays known
// screens from the IVR map, asks the brain when a prompt ends, enforces policy
// in code, pauses for the user when money or judgment is involved, hands the
// call to the user when a human picks up, and escalates to a human operator
// (never just fails) when it gets stuck. Every call ends with an auditable
// outcome: resolved by AI, resolved with human help, or failed (with why and where).

import type { Brain, BrainState, Grant, HistoryItem } from '../brains/brain.js';
import { decideByRules, summaryFor } from '../brains/rules.js';
import type { MapMemory } from './memory.js';
import type { EscalationTicket, OperatorCommand, OperatorQueue } from './operators.js';
import {
  analyzeTurn,
  extractConfirmation,
  fingerprint,
  looksHuman,
  looksLikeHold,
  looksLikeInvalid,
} from './parse.js';
import type {
  Action,
  CallEvent,
  CallResult,
  CallStatus,
  Decision,
  FailureReason,
  FailureRecord,
  Line,
  ResultKind,
  ResultRecord,
  Speaker,
  Task,
  TurnAnalysis,
  UserRequest,
  UserResponse,
} from './types.js';
import { keypadDigits } from './tasks.js';
import { Vault, VaultError } from './vault.js';

export interface SessionOptions {
  task: Task;
  line: Line;
  brain: Brain;
  /** Used when the primary brain fails (network, refusal, bad output). */
  fallback?: Brain;
  memory: MapMemory;
  vault: Vault;
  /** Call time charged for a non-model decision (STT endpointing + compute). */
  thinkMs?: number;
  /** Call time after which a stuck call is escalated (then ended 15 minutes later). */
  maxCallMs?: number;
  /** Human fallback. Without one, a stuck call ends as failed (with its reason recorded). */
  operators?: OperatorQueue;
  id?: string;
}

interface Turn {
  sentences: string[];
  speaker: Speaker;
  /** Index where the current screen starts (moves past prompts we let play out). */
  segmentStart: number;
  analyzedAt: number;
  mapTried: boolean;
}

const EPHEMERAL_SECRETS = ['card.cvv'];
const UNAVAILABLE = /\b(?:call (?:us )?back|are closed|office is closed|temporarily unavailable|is unavailable|high call volume|try again later|business hours|unable to take your call)\b/i;
const RESULT_KINDS: Record<Task['kind'], ResultKind> = {
  pay_bill: 'bill_paid',
  cancel: 'membership_canceled',
  reservation: 'reservation_booked',
  reach_human: 'human_reached',
};

export class CallSession {
  readonly id: string;
  readonly task: Task;
  readonly events: CallEvent[] = [];
  status: CallStatus = 'dialing';
  result?: CallResult;
  pendingRequest?: { id: string; request: UserRequest };

  private opts: SessionOptions;
  private listeners = new Set<(e: CallEvent) => void>();
  private pending = new Map<string, (r: UserResponse) => void>();
  private state: BrainState;
  private turn: Turn = newTurn('ivr');
  private turnNo = 0;
  private ended = false;
  private bridged = false;
  private holdStart?: number;
  private holdMs = 0;
  private mapHits = 0;
  private llmCalls = 0;
  private userTouches = 0;
  private decisions = 0;
  private lastScreen?: string;
  private replay?: { screenId: string; prev?: string };
  private replayed = new Set<string>();
  private done?: Promise<CallResult>;
  // Human fallback and outcome tracking
  private control: 'ai' | 'operator' = 'ai';
  private inbox: { command: OperatorCommand; operator: string; done: () => void }[] = [];
  private ticketId?: string;
  private escalations = 0;
  private operatorTouches = 0;
  private operatorJoined = false;
  private failure?: FailureRecord;
  private evidence?: { t: number; text: string };
  private visits = new Map<string, number>();
  private lastStep = 'Dialing';
  private recentIvr: string[] = [];
  private lastHuman?: { t: number; text: string };
  private deadline = 0;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.task = opts.task;
    this.id = opts.id ?? globalThis.crypto.randomUUID();
    this.state = {
      task: opts.task,
      turn: [],
      speaker: 'ivr',
      analysis: { kind: 'info', options: [], title: '' },
      history: [],
      notes: {},
      grants: [],
      counters: { silences: 0, escalations: 0, humanTurns: 0, invalids: 0 },
      entered: {},
    };
  }

  get notes(): Record<string, string> {
    return { ...this.state.notes };
  }

  subscribe(fn: (e: CallEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Start the call (idempotent). Resolves when the call ends. */
  run(): Promise<CallResult> {
    this.done ??= this.loop();
    return this.done;
  }

  /** Answer a pending user request. Returns false if the id is unknown. */
  respond(id: string, response: UserResponse): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(response);
    return true;
  }

  /** The bridged user speaks to the human on the line. */
  async userSays(text: string): Promise<void> {
    if (!this.bridged || this.ended) return;
    this.emit({ type: 'bridge', t: this.now(), from: 'user', text });
    await this.opts.line.userSays?.(text);
  }

  /** The user hangs up (or cancels the task). */
  async hangup(): Promise<void> {
    if (this.ended) return;
    const success = this.bridged;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ approved: false });
    }
    await this.opts.line.hangup();
    if (!success) this.failure ??= { reason: 'user_declined', detail: 'You ended the call', step: this.lastStep, t: this.now() };
    this.finish(success ? 'success' : 'failure', success ? this.handoffSummary() : 'You ended the call.');
  }

  // ---------------------------------------------------------------------------

  private async loop(): Promise<CallResult> {
    const { line, memory, task } = this.opts;
    memory.beginCall(task.phone, task.business);
    this.setStatus('dialing', `${task.business} · ${task.phone}`);
    await line.dial();
    this.setStatus('navigating');
    this.deadline = this.opts.maxCallMs ?? 90 * 60_000;

    while (!this.ended) {
      // With a person driving, let their commands land before the line moves on.
      if (this.control === 'operator') await new Promise((r) => setTimeout(r, 0));
      await this.drainOperator();
      if (this.ended) break;
      if (line.now() > this.deadline || this.decisions > 250) {
        if (this.opts.operators && this.control === 'ai' && this.decisions <= 250) {
          this.deadline = line.now() + 15 * 60_000;
          await this.execute({ action: { type: 'escalate', reason: 'timeout', detail: 'The call has run too long without finishing' }, reason: 'Taking too long. Getting a person to look.', source: 'guard' });
          continue;
        }
        await line.hangup();
        this.failure ??= { reason: 'timeout', detail: 'The call ran too long without finishing', step: this.lastStep, t: line.now() };
        this.finish('failure');
        break;
      }
      const ev = await line.next();
      if (this.ended) break;
      if (ev.kind === 'hangup') {
        this.finish();
        break;
      }
      if (ev.kind === 'speech') await this.onSpeech(ev.speaker, ev.text);
      else await this.onSilence();
    }
    return this.result!;
  }

  private async onSpeech(speaker: Speaker, raw: string) {
    const text = this.opts.vault.scrub(raw);
    if (this.bridged) {
      // The user owns this conversation now. Voiced relays audio but doesn't mine it.
      this.emit({ type: 'bridge', t: this.now(), from: 'human', text });
      return;
    }
    const effective: Speaker = speaker === 'ivr' && looksHuman(text) ? 'human' : speaker;
    if (effective !== this.turn.speaker && this.turn.sentences.length) this.closeTurn(effective);
    this.turn.speaker = effective;
    this.turn.sentences.push(text);
    this.state.history.push({ who: effective, text });
    this.emit({ type: 'heard', t: this.now(), speaker: effective, text, turn: this.turnNo });

    this.checkReplay(text);
    if (effective === 'ivr') this.recentIvr = [...this.recentIvr.slice(-3), text];
    if (effective === 'human') this.lastHuman ??= { t: this.now(), text };

    if (effective === 'hold' || looksLikeHold(text)) {
      if (this.holdStart === undefined) this.holdStart = this.now();
      if (this.status !== 'on_hold') this.setStatus('on_hold');
    } else if (effective === 'human') {
      this.endHold();
      if (this.status !== 'talking_to_human') this.setStatus('talking_to_human');
    }

    const code = extractConfirmation(text);
    if (code) {
      const key = /\b(?:case|ticket)\b/i.test(text) ? 'case' : 'confirmation';
      this.addNotes({ [key]: code });
      if (key === this.task.successNote) this.evidence ??= { t: this.now(), text };
      if (key === this.task.successNote && this.task.kind !== 'reach_human') {
        await this.execute({
          action: { type: 'hangup', outcome: 'success', summary: summaryFor(this.snapshot()) },
          reason: `Got confirmation ${code}. Hanging up.`,
          source: 'rules',
        });
        return;
      }
    }

    // Fast path: a screen we've seen before, replayed at the moment it accepts input.
    if (effective === 'ivr' && !this.turn.mapTried && this.control === 'ai') {
      const hit = this.opts.memory.lookup(this.task.phone, this.task.kind, this.segment());
      if (hit && this.replayed.has(hit.screen.id)) {
        // Back on a screen we already replayed: the map sent us in a circle. Stop trusting it.
        this.opts.memory.fail(this.task.phone, hit.screen.id, this.task.kind);
        this.turn.mapTried = true;
      } else if (hit) {
        this.replayed.add(hit.screen.id);
        this.turn.mapTried = true;
        this.mapHits += 1;
        this.analyzeSegment();
        this.replay = { screenId: hit.screen.id, prev: this.lastScreen };
        this.lastScreen = hit.screen.id;
        await this.execute({ action: hit.play.action, reason: hit.play.reason, source: 'map' });
      }
    }
  }

  private async onSilence() {
    if (this.turn.speaker === 'hold') return;
    this.state.counters.silences += 1;
    const analysis = this.analyzeSegment();
    if (this.control === 'operator') return; // a person is driving; the AI stays quiet
    if (this.turn.speaker === 'ivr' && (this.visits.get(this.screenKey()) ?? 0) >= 3) {
      await this.execute({
        action: { type: 'escalate', reason: 'loop', detail: `The phone tree keeps sending the call back to "${analysis.title}"` },
        reason: 'Going in circles. Getting a person to look.',
        source: 'guard',
      });
      return;
    }
    let decision = await this.decide(analysis);
    for (let asks = 0; decision.action.type === 'ask_user' && !this.ended; asks++) {
      if (asks >= 2) {
        decision = { action: { type: 'escalate', reason: 'dead_end', detail: 'Still stuck after asking you' }, reason: 'Still stuck after asking you. Getting a person to look.', source: 'guard' };
        break;
      }
      await this.execute(decision);
      if (this.ended) return;
      decision = await this.decide(analysis);
    }
    await this.execute(decision);
    if (decision.action.type === 'wait') this.turn.segmentStart = this.turn.sentences.length;
  }

  private async decide(analysis: TurnAnalysis): Promise<Decision> {
    const { brain, fallback, line } = this.opts;
    const s = this.snapshot(analysis);
    const t0 = Date.now();
    let d: Decision;
    try {
      d = await brain.decide(s);
    } catch (err) {
      if (!fallback) throw err;
      d = await fallback.decide(s);
      d = { ...d, reason: `${d.reason} (model unavailable, rules took over)` };
    }
    // Brains mutate counters (e.g. escalations) on the snapshot.
    this.state.counters = s.counters;
    const latency = Date.now() - t0;
    if (d.source === 'llm') {
      this.llmCalls += 1;
      line.elapse(latency);
    } else line.elapse(this.opts.thinkMs ?? 250);
    this.decisions += 1;
    return this.guard(d, s, latency);
  }

  /** Policy lives in code, not in the prompt. */
  private guard(d: Decision, s: BrainState, latencyMs: number): Decision {
    const out = { ...d, latencyMs } as Decision & { latencyMs: number };
    const a = d.action;
    if (d.source !== 'rules' && s.analysis.kind === 'commit' && a.type === 'press') {
      const policy = decideByRules(s);
      if (policy.action.type === 'ask_user') return { ...policy, source: 'guard', reason: `Guard: ${policy.reason}` };
      if (policy.action.type === 'press' && policy.action.digits !== a.digits) return { ...policy, source: 'guard', reason: `Guard: ${policy.reason}` };
    }
    if (a.type === 'press' && !/^[0-9*#w]*$/.test(a.digits.replace(/\{\{[^}]+\}\}/g, ''))) {
      return { action: { type: 'wait' }, reason: `Guard: refused to press "${a.digits}"`, source: 'guard' };
    }
    if (a.type === 'say' && s.speaker === 'human' && this.opts.vault.refs(a.text).some((k) => this.opts.vault.isSecret(k))) {
      return {
        action: { type: 'say', text: `${this.task.user.firstName} can provide that directly.` },
        reason: 'Guard: secrets are never read to a person',
        source: 'guard',
      };
    }
    return out;
  }

  private async execute(d: Decision) {
    if (this.ended) return;
    const { line, vault } = this.opts;
    const a = d.action;
    if (d.notes) this.addNotes(d.notes);
    const latencyMs = (d as Decision & { latencyMs?: number }).latencyMs ?? 0;
    const emitAction = (display: string) =>
      this.emit({ type: 'action', t: this.now(), turn: this.turnNo, action: a, display, source: d.source, reason: d.reason, latencyMs });

    switch (a.type) {
      case 'press': {
        let digits: string;
        try {
          digits = keypadDigits(vault.resolve(a.digits, { allowSecrets: true }));
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
          emitAction(`(blocked) ${err.message}`);
          return;
        }
        // Twilio rejects the whole entry if any character isn't a key (a letter in an account number, say).
        if (!/^[0-9*#w]*$/.test(digits)) {
          emitAction(`(blocked) ${vault.redact(a.digits)} has characters a keypad can't send`);
          return;
        }
        emitAction(vault.redact(a.digits));
        const secret = vault.refs(a.digits).some((k) => vault.isSecret(k));
        for (const k of vault.refs(a.digits)) this.state.entered[k] = (this.state.entered[k] ?? 0) + 1;
        this.state.history.push({ who: d.source === 'operator' ? 'system' : 'agent', text: `[${d.source === 'operator' ? 'operator ' : ''}pressed ${vault.redact(a.digits)}]` });
        this.learn(d);
        this.resetTurn();
        if (secret) await this.recording(false, 'Keying vault digits');
        await line.sendDigits(digits);
        if (secret) await this.recording(true, 'Vault entry done');
        return;
      }
      case 'say': {
        let text: string;
        try {
          text = vault.resolve(a.text, { allowSecrets: this.turn.speaker !== 'human' });
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
          emitAction(`(blocked) ${err.message}`);
          return;
        }
        emitAction(vault.redact(a.text));
        for (const k of vault.refs(a.text)) this.state.entered[k] = (this.state.entered[k] ?? 0) + 1;
        this.state.history.push({ who: 'agent', text: vault.redact(a.text) });
        this.learn(d);
        this.resetTurn();
        await line.say(text);
        return;
      }
      case 'wait':
        emitAction('');
        return;
      case 'ask_user':
        emitAction(a.request.title);
        await this.askUser(a.request);
        return;
      case 'handoff': {
        emitAction('Handing off to you');
        this.endHold();
        this.addNotes({ handoff: 'yes' });
        this.emit({ type: 'handoff', t: this.now(), briefing: a.briefing });
        this.setStatus('handing_off');
        this.resetTurn();
        await line.bridge();
        if (this.ended) return;
        this.bridged = true;
        this.setStatus('user_connected');
        return;
      }
      case 'escalate':
        emitAction(a.detail);
        await this.escalate(a.reason, a.detail);
        return;
      case 'hangup':
        emitAction(a.outcome === 'success' ? 'Hanging up: done' : 'Hanging up');
        await line.hangup();
        this.finish(a.outcome, a.summary);
        return;
    }
  }

  /** Hand the call and its full context to a person. */
  private async escalate(reason: FailureReason, detail: string) {
    this.escalations += 1;
    this.failure ??= { reason, detail, step: this.lastStep, t: this.now() };
    const desk = this.opts.operators;
    if (!desk) {
      await this.opts.line.hangup();
      this.finish('failure');
      return;
    }
    if (this.control === 'operator') return;
    const ticket: EscalationTicket = {
      id: `esc_${globalThis.crypto.randomUUID().slice(0, 8)}`,
      callId: this.id,
      business: this.task.business,
      phone: this.task.phone,
      task: this.task.title,
      goal: this.task.goal,
      reason,
      detail,
      step: this.lastStep,
      t: this.now(),
      transcript: this.state.history.slice(-30),
      facts: this.task.facts.map((f) => ({ key: f.key, label: f.label, display: f.secret ? (f.display ?? '••••') : (f.value ?? '') })),
      status: 'waiting',
      openedAt: Date.now(),
      log: [],
    };
    this.control = 'operator';
    this.ticketId = ticket.id;
    this.setStatus('with_operator', detail);
    this.emit({ type: 'escalated', t: this.now(), ticketId: ticket.id, reason, detail, step: this.lastStep });
    desk.open(ticket, {
      act: (command, operator) => new Promise<void>((done) => this.inbox.push({ command, operator, done })),
    });
  }

  /** Operator commands run between line events, never in the middle of one. */
  private async drainOperator() {
    while (this.inbox.length && !this.ended) {
      const { command, operator, done } = this.inbox.shift()!;
      this.operatorTouches += 1;
      if (!this.operatorJoined) {
        this.operatorJoined = true;
        this.emit({ type: 'operator', t: this.now(), ticketId: this.ticketId ?? '', state: 'joined', operator });
      }
      const reason = `Operator ${operator}`;
      switch (command.type) {
        case 'press':
          await this.execute({ action: { type: 'press', digits: command.digits }, reason, source: 'operator', cacheable: true });
          break;
        case 'say':
          await this.execute({ action: { type: 'say', text: command.text }, reason, source: 'operator', cacheable: true });
          break;
        case 'handoff':
          this.control = 'ai';
          await this.execute({ action: { type: 'handoff', briefing: command.briefing }, reason, source: 'operator' });
          break;
        case 'return':
          this.control = 'ai';
          this.operatorJoined = false;
          this.visits.clear();
          this.state.counters.silences = 0;
          this.emit({ type: 'operator', t: this.now(), ticketId: this.ticketId ?? '', state: 'returned', operator, note: command.note });
          if (!this.ended) this.setStatus('navigating');
          break;
        case 'hangup':
          this.emit({ type: 'operator', t: this.now(), ticketId: this.ticketId ?? '', state: 'closed', operator, note: command.summary });
          this.failure = { ...(this.failure ?? { reason: 'unresolved', detail: command.summary, step: this.lastStep, t: this.now() }) };
          await this.execute({ action: { type: 'hangup', outcome: 'failure', summary: command.summary }, reason, source: 'operator' });
          break;
      }
      done();
    }
  }

  private async recording(on: boolean, reason: string) {
    await this.opts.line.setRecording?.(on);
    this.emit({ type: 'recording', t: this.now(), paused: !on, reason });
  }

  private async askUser(request: UserRequest) {
    const id = globalThis.crypto.randomUUID();
    const previous = this.status;
    this.userTouches += 1;
    this.pendingRequest = { id, request };
    this.setStatus('awaiting_user', request.title);
    this.emit({ type: 'user_request', t: this.now(), id, request });
    const t0 = Date.now();
    const response = await new Promise<UserResponse>((resolve) => this.pending.set(id, resolve));
    this.opts.line.elapse(Date.now() - t0);
    this.pendingRequest = undefined;
    const grant: Grant = { request, response: redactResponse(response) };
    this.state.grants.push(grant);
    if (request.kind === 'input' && response.approved && response.text && request.factKey) this.addFact(request, response.text);
    this.state.history.push({
      who: 'user',
      text:
        request.kind === 'input'
          ? `${response.approved && response.text ? 'Provided' : 'Could not provide'}: ${request.factLabel ?? request.title}`
          : `${response.approved ? 'Approved' : 'Declined'}: ${request.title}${response.choice ? ` (${response.choice})` : ''}`,
    });
    this.emit({ type: 'user_response', t: this.now(), id, response: redactResponse(response) });
    if (!this.ended) this.setStatus(previous === 'awaiting_user' ? 'navigating' : previous);
  }

  /** Something the user told us mid-call (e.g. an identity check) becomes a fact; secrets go to the vault. */
  private addFact(request: Extract<UserRequest, { kind: 'input' }>, value: string) {
    const key = request.factKey!;
    const label = request.factLabel ?? request.title;
    const aliases = request.aliases ?? [label.toLowerCase()];
    const secret = request.secret !== false;
    const fact = secret
      ? { key, label, secret: true, display: '••••', aliases }
      : { key, label, value, aliases };
    this.task.facts = [...this.task.facts.filter((f) => f.key !== key), fact];
    this.state.task = this.task;
    this.opts.vault.addFact(fact);
    if (secret) this.opts.vault.set(key, value.replace(/\s+/g, ''));
    this.state.entered[key] = 0;
  }

  // ---------------------------------------------------------------------------

  private snapshot(analysis?: TurnAnalysis): BrainState {
    const segment = this.segment();
    const screen = this.opts.memory.match(this.task.phone, segment);
    const play = screen?.plays[this.task.kind];
    return {
      ...this.state,
      turn: segment,
      speaker: this.turn.speaker,
      analysis: analysis ?? analyzeTurn(segment.join(' '), this.turn.speaker),
      history: this.state.history.slice(-40),
      notes: { ...this.state.notes },
      counters: { ...this.state.counters },
      entered: { ...this.state.entered },
      mapHint: play ? `Known screen "${screen!.title}". Last time: ${describe(play.action)} (${play.reason}).` : undefined,
    };
  }

  private segment(): string[] {
    return this.turn.sentences.slice(this.turn.segmentStart);
  }

  /** Identifies the current screen for loop detection, skipping "sorry, I didn't get that" preambles. */
  private screenKey(): string {
    const first = this.segment().find((s) => !looksLikeInvalid(s) && !/\bdidn'?t hear\b/i.test(s)) ?? this.segment()[0] ?? '';
    return fingerprint(first);
  }

  private analyzeSegment(): TurnAnalysis {
    const segment = this.segment();
    const analysis = analyzeTurn(segment.join(' '), this.turn.speaker);
    if (this.turn.analyzedAt !== this.turn.sentences.length && segment.length) {
      this.turn.analyzedAt = this.turn.sentences.length;
      this.lastStep = analysis.kind === 'human' ? 'Live person' : analysis.kind === 'hold' ? 'Hold queue' : analysis.title;
      if (this.turn.speaker === 'ivr') this.visits.set(this.screenKey(), (this.visits.get(this.screenKey()) ?? 0) + 1);
      const known = !!this.opts.memory.match(this.task.phone, segment);
      this.emit({ type: 'turn', t: this.now(), turn: this.turnNo, analysis, fingerprint: fingerprint(segment[0]), known });
    }
    return analysis;
  }

  /** Remember what worked, so the next caller skips the listening. Never learns from humans. */
  private learn(d: Decision) {
    if (d.source === 'map' || !d.cacheable || this.turn.speaker !== 'ivr') return;
    // Key the screen by its own prompt, not by the "sorry, that option is unavailable" that preceded it.
    const raw = this.segment();
    const start = raw.findIndex((s) => !looksLikeInvalid(s) && !/^(?:returning to|sorry, i didn'?t hear)\b/i.test(s) && !/\bdidn'?t hear\b/i.test(s));
    const segment = start === -1 ? [] : raw.slice(start);
    if (!segment.length) return;
    const analysis = analyzeTurn(segment.join(' '), 'ivr');
    const prev = this.lastScreen;
    this.lastScreen = this.opts.memory.learn(
      this.task.phone,
      this.task.business,
      this.task.kind,
      segment,
      analysis,
      d.action,
      d.source === 'operator' ? 'Learned from a human operator on an earlier call' : d.reason,
      prev,
    );
  }

  /** After a replay, the next thing the IVR says tells us whether the map was right. */
  private checkReplay(text: string) {
    if (!this.replay) return;
    const { screenId, prev } = this.replay;
    this.replay = undefined;
    if (looksLikeInvalid(text)) this.opts.memory.fail(this.task.phone, screenId, this.task.kind);
    else this.opts.memory.confirm(this.task.phone, screenId, this.task.kind, prev);
  }

  private closeTurn(next: Speaker) {
    if (this.turn.sentences.length && this.turn.analyzedAt !== this.turn.sentences.length) this.analyzeSegment();
    this.turn = newTurn(next);
    this.turnNo += 1;
  }

  private resetTurn() {
    this.turn = newTurn(this.turn.speaker);
    this.turnNo += 1;
    this.state.counters.silences = 0;
  }

  private endHold() {
    if (this.holdStart === undefined) return;
    this.holdMs += this.now() - this.holdStart;
    this.holdStart = undefined;
    this.addNotes({ hold: formatDuration(this.holdMs) });
  }

  private addNotes(notes: Record<string, string>) {
    for (const [key, value] of Object.entries(notes)) {
      if (this.state.notes[key] === value) continue;
      this.state.notes[key] = value;
      this.emit({ type: 'note', t: this.now(), key, value });
    }
  }

  private handoffSummary(): string {
    const rep = this.state.notes.rep ?? 'a live rep';
    const hold = this.state.notes.hold ? ` after ${this.state.notes.hold} on hold` : '';
    return `Reached ${rep} at ${this.task.business}${hold} and handed the call to you.`;
  }

  private finish(outcome?: 'success' | 'failure', summary?: string) {
    if (this.ended) return;
    this.ended = true;
    this.endHold();
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ approved: false });
    }
    const succeeded = outcome ?? (this.state.notes[this.task.successNote] ? 'success' : 'failure');
    const unheard = this.turn.sentences.slice(this.turn.analyzedAt).find((s) => !looksLikeInvalid(s));
    if (unheard && this.turn.speaker === 'ivr' && !this.failure && !UNAVAILABLE.test(unheard)) this.lastStep = unheard.replace(/[.!?]$/, '');
    const declined = this.state.grants.find((g) => !g.response.approved && g.request.kind !== 'input');
    if (succeeded === 'failure' && !this.failure) {
      this.failure = declined
        ? { reason: 'user_declined', detail: `You declined "${declined.request.title}"`, step: this.lastStep, t: this.now() }
        : UNAVAILABLE.test(this.recentIvr.join(' '))
          ? { reason: 'business_unavailable', detail: this.recentIvr.find((l) => UNAVAILABLE.test(l)) ?? this.recentIvr.join(' '), step: this.lastStep, t: this.now() }
          : { reason: 'hung_up', detail: 'The business ended the call', step: this.lastStep, t: this.now() };
    }
    const resolution = succeeded === 'failure' ? 'failed' : this.operatorTouches > 0 ? 'human_assisted' : 'ai';
    const helped = resolution === 'human_assisted' && this.failure ? ` A Voiced operator stepped in at "${this.failure.step}".` : '';
    const text =
      (summary ??
        (succeeded === 'success'
          ? this.task.kind === 'reach_human'
            ? this.handoffSummary()
            : summaryFor(this.snapshot())
          : declined
            ? `Stopped: you declined "${declined.request.title}". Nothing was committed.`
            : `Couldn't finish: ${this.failure!.detail} (at "${this.failure!.step}").`)) + helped;
    this.opts.vault.wipe(EPHEMERAL_SECRETS);
    this.opts.operators?.close(this.id);
    this.result = {
      outcome: succeeded,
      resolution,
      result: succeeded === 'success' ? this.resultRecord() : undefined,
      failure: this.failure,
      summary: text,
      notes: { ...this.state.notes },
      callMs: this.now(),
      holdMs: this.holdMs,
      userTouches: this.userTouches,
      escalations: this.escalations,
      operatorTouches: this.operatorTouches,
      turns: this.turnNo,
      mapHits: this.mapHits,
      llmCalls: this.llmCalls,
    };
    this.setStatus('ended');
    this.emit({ type: 'ended', t: this.now(), result: this.result });
  }

  private resultRecord(): ResultRecord {
    const n = this.state.notes;
    return {
      kind: RESULT_KINDS[this.task.kind],
      confirmation: n.confirmation ?? n.case,
      amount: n.paid,
      evidence: this.task.kind === 'reach_human' ? this.lastHuman : this.evidence,
    };
  }

  private setStatus(status: CallStatus, detail?: string) {
    this.status = status;
    this.emit({ type: 'status', t: this.now(), status, detail });
  }

  private now(): number {
    return this.opts.line.now();
  }

  private emit(e: CallEvent) {
    this.events.push(e);
    for (const fn of this.listeners) fn(e);
  }
}

function newTurn(speaker: Speaker): Turn {
  return { sentences: [], speaker, segmentStart: 0, analyzedAt: 0, mapTried: false };
}

function redactResponse(r: UserResponse): UserResponse {
  return { approved: r.approved, choice: r.choice, text: r.text ? '•••' : undefined };
}

export const RESOLUTION_LABELS: Record<CallResult['resolution'], string> = {
  ai: 'Resolved by AI',
  human_assisted: 'Resolved with human help',
  failed: 'Not resolved',
};

export function describe(a: Action): string {
  switch (a.type) {
    case 'press':
      return `pressed ${a.digits}`;
    case 'say':
      return `said "${a.text}"`;
    default:
      return a.type;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export type { HistoryItem };
