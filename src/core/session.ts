// CallSession runs one phone call: it listens to the line, replays known
// screens from the IVR map, asks the brain when a prompt ends, enforces policy
// in code, pauses for the user when money or judgment is involved, and hands
// the call to the user when a human picks up.

import type { Brain, BrainState, Grant, HistoryItem } from '../brains/brain.js';
import { decideByRules, summaryFor } from '../brains/rules.js';
import type { MapMemory } from './memory.js';
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
  Line,
  Speaker,
  Task,
  TurnAnalysis,
  UserRequest,
  UserResponse,
} from './types.js';
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
  /** Hard stop for runaway calls, in call-time milliseconds. */
  maxCallMs?: number;
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
    this.finish(success ? 'success' : 'failure', success ? this.handoffSummary() : 'You ended the call.');
  }

  // ---------------------------------------------------------------------------

  private async loop(): Promise<CallResult> {
    const { line, memory, task } = this.opts;
    memory.beginCall(task.phone, task.business);
    this.setStatus('dialing', `${task.business} · ${task.phone}`);
    await line.dial();
    this.setStatus('navigating');
    const maxMs = this.opts.maxCallMs ?? 90 * 60_000;

    while (!this.ended) {
      if (line.now() > maxMs || this.decisions > 250) {
        await line.hangup();
        this.finish('failure', 'Gave up: the call ran too long without finishing.');
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
    if (effective === 'ivr' && !this.turn.mapTried) {
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
    let decision = await this.decide(analysis);
    for (let asks = 0; decision.action.type === 'ask_user' && !this.ended; asks++) {
      if (asks >= 2) {
        decision = { action: { type: 'handoff', briefing: 'I got stuck and need you to take over.' }, reason: 'Still stuck after asking you. Handing the call over.', source: 'guard' };
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
          digits = vault.resolve(a.digits, { allowSecrets: true });
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
          emitAction(`(blocked) ${err.message}`);
          return;
        }
        emitAction(vault.redact(a.digits));
        for (const k of vault.refs(a.digits)) this.state.entered[k] = (this.state.entered[k] ?? 0) + 1;
        this.state.history.push({ who: 'agent', text: `[pressed ${vault.redact(a.digits)}]` });
        this.learn(d);
        this.resetTurn();
        await line.sendDigits(digits);
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
      case 'hangup':
        emitAction(a.outcome === 'success' ? 'Hanging up: done' : 'Hanging up');
        await line.hangup();
        this.finish(a.outcome, a.summary);
        return;
    }
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
    const grant: Grant = { request, response };
    this.state.grants.push(grant);
    this.state.history.push({ who: 'user', text: `${response.approved ? 'Approved' : 'Declined'}: ${request.title}${response.choice ? ` (${response.choice})` : ''}` });
    this.emit({ type: 'user_response', t: this.now(), id, response: redactResponse(response) });
    if (!this.ended) this.setStatus(previous === 'awaiting_user' ? 'navigating' : previous);
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

  private analyzeSegment(): TurnAnalysis {
    const segment = this.segment();
    const analysis = analyzeTurn(segment.join(' '), this.turn.speaker);
    if (this.turn.analyzedAt !== this.turn.sentences.length && segment.length) {
      this.turn.analyzedAt = this.turn.sentences.length;
      const known = !!this.opts.memory.match(this.task.phone, segment);
      this.emit({ type: 'turn', t: this.now(), turn: this.turnNo, analysis, fingerprint: fingerprint(segment[0]), known });
    }
    return analysis;
  }

  /** Remember what worked, so the next caller skips the listening. Never learns from humans. */
  private learn(d: Decision) {
    if (d.source === 'map' || !d.cacheable || this.turn.speaker !== 'ivr') return;
    const segment = this.segment();
    if (!segment.length || looksLikeInvalid(segment[0])) return;
    const analysis = analyzeTurn(segment.join(' '), 'ivr');
    const prev = this.lastScreen;
    this.lastScreen = this.opts.memory.learn(
      this.task.phone,
      this.task.business,
      this.task.kind,
      segment,
      analysis,
      d.action,
      d.reason,
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
    const declined = this.state.grants.find((g) => !g.response.approved);
    const text =
      summary ??
      (succeeded === 'success'
        ? this.task.kind === 'reach_human'
          ? this.handoffSummary()
          : summaryFor(this.snapshot())
        : declined
          ? `Stopped: you declined "${declined.request.title}". Nothing was committed.`
          : 'The call ended before the task was finished.');
    this.opts.vault.wipe(EPHEMERAL_SECRETS);
    this.result = {
      outcome: succeeded,
      summary: text,
      notes: { ...this.state.notes },
      callMs: this.now(),
      holdMs: this.holdMs,
      userTouches: this.userTouches,
      turns: this.turnNo,
      mapHits: this.mapHits,
      llmCalls: this.llmCalls,
    };
    this.setStatus('ended');
    this.emit({ type: 'ended', t: this.now(), result: this.result });
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
