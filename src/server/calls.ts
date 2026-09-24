// CallManager owns every live call on this server: it starts sessions on the
// simulator (or a real telephony line), keeps their event streams, exposes
// agent-friendly views of them, and tracks the headline metric: completion rate.

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Brain } from '../brains/brain.js';
import { RulesBrain } from '../brains/rules.js';
import type { MapMemory } from '../core/memory.js';
import { money } from '../core/parse.js';
import { CallSession } from '../core/session.js';
import { buildCustomTask, type CustomTaskInput } from '../core/tasks.js';
import type { CallEvent, CallResult, Line, Task, UserRequest } from '../core/types.js';
import { Vault } from '../core/vault.js';
import { PacedClock, SimLine } from '../sim/engine.js';
import { getScenario, scenarios } from '../sim/scenarios/index.js';

export interface StartCallInput {
  /** A business from the directory (simulated phone trees in this build). */
  business_id?: string;
  /** Extra instructions for the agent. */
  instructions?: string;
  /** Payment pre-approval. */
  max_amount?: number;
  max_fee?: number;
  card?: string;
  /** Playback speed for simulated calls (1 = real time). */
  speed?: number;
  /** A real call to any number (requires a telephony provider). */
  custom?: CustomTaskInput;
}

export interface ManagedCall {
  id: string;
  owner: string;
  token: string;
  session: CallSession;
  task: Task;
  businessId?: string;
  createdAt: number;
  clock?: PacedClock;
  simulated: boolean;
}

export interface CallManagerOptions {
  memory: MapMemory;
  brain: () => Brain;
  baseUrl: string;
  /** Default playback speed for simulated calls started through the API. */
  apiSpeed?: number;
  /** Where to append finished-call records (for stats that survive restarts). */
  logPath?: string;
  /** Opens a real phone line. Undefined when no provider is configured. */
  realLine?: (task: Task) => Line;
}

interface CallRecord {
  id: string;
  business: string;
  kind: string;
  outcome: 'success' | 'failure';
  callMs: number;
  holdMs: number;
  mapHits: number;
  llmCalls: number;
  userTouches: number;
  simulated: boolean;
  at: number;
}

export class CallManager {
  private calls = new Map<string, ManagedCall>();
  private records: CallRecord[] = [];

  constructor(private opts: CallManagerOptions) {
    if (opts.logPath && existsSync(opts.logPath)) {
      for (const line of readFileSync(opts.logPath, 'utf8').split('\n')) {
        if (line.trim()) this.records.push(JSON.parse(line));
      }
    }
  }

  get baseUrl() {
    return this.opts.baseUrl;
  }

  set baseUrl(url: string) {
    this.opts.baseUrl = url;
  }

  get memory() {
    return this.opts.memory;
  }

  directory() {
    return scenarios.map((s) => {
      const map = this.opts.memory.get(s.phone);
      const recs = this.records.filter((r) => r.business === s.business);
      return {
        id: s.id,
        business: s.business,
        phone: s.phone,
        category: s.category,
        example_task: s.title,
        simulated: true,
        map: {
          screens: map?.screens.length ?? 0,
          calls: map?.calls ?? 0,
          completion_rate: recs.length ? round(recs.filter((r) => r.outcome === 'success').length / recs.length) : null,
        },
      };
    });
  }

  start(input: StartCallInput, owner: string): ManagedCall {
    let task: Task;
    let secrets: Record<string, string>;
    let line: Line;
    let clock: PacedClock | undefined;
    let businessId: string | undefined;
    if (input.custom) {
      if (!this.opts.realLine) throw new HttpError(400, 'Real calls need a telephony provider (set TWILIO_* env vars). Use business_id for the simulated directory.');
      ({ task, secrets } = buildCustomTask(input.custom));
      line = this.opts.realLine(task);
    } else {
      const scenario = getScenario(input.business_id ?? '');
      if (!scenario) throw new HttpError(404, `Unknown business_id "${input.business_id}". See GET /v1/businesses.`);
      businessId = scenario.id;
      ({ task, secrets } = scenario.task({ cardId: input.card, maxAmount: input.max_amount, maxFee: input.max_fee }));
      clock = new PacedClock(clamp(input.speed ?? this.opts.apiSpeed ?? 20, 1, 200));
      line = new SimLine(scenario.script(), clock);
    }
    if (input.instructions) task = { ...task, goal: `${task.goal} Additional instructions from the user: ${input.instructions}` };

    const id = `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const session = new CallSession({
      id,
      task,
      line,
      brain: this.opts.brain(),
      fallback: new RulesBrain(),
      memory: this.opts.memory,
      vault: new Vault(task.facts, secrets),
    });
    const call: ManagedCall = {
      id,
      owner,
      token: randomBytes(18).toString('base64url'),
      session,
      task,
      businessId,
      createdAt: Date.now(),
      clock,
      simulated: line.simulated,
    };
    this.calls.set(id, call);
    session.run().then((r) => this.record(call, r), (err) => console.error(`[${id}] crashed`, err));
    return call;
  }

  get(id: string): ManagedCall | undefined {
    return this.calls.get(id);
  }

  list(owner: string): ManagedCall[] {
    return [...this.calls.values()].filter((c) => c.owner === owner).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Resolve when the call changes (new request, new status, ended) or the timeout passes. */
  waitForChange(call: ManagedCall, timeoutMs: number): Promise<void> {
    if (call.session.result || call.session.pendingRequest) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const unsubscribe = call.session.subscribe((e) => {
        if (e.type === 'user_request' || e.type === 'ended' || e.type === 'handoff') done();
      });
      function done() {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  }

  view(call: ManagedCall, opts: { transcript?: number } = {}) {
    const s = call.session;
    const r = s.result;
    const pending = s.pendingRequest;
    return {
      id: call.id,
      business: call.task.business,
      phone: call.task.phone,
      task: call.task.title,
      simulated: call.simulated,
      status: s.status,
      created_at: new Date(call.createdAt).toISOString(),
      pending_request: pending ? this.requestView(call, pending.id, pending.request) : null,
      outcome: r?.outcome ?? null,
      summary: r?.summary ?? null,
      notes: s.notes,
      metrics: r ? metrics(r) : null,
      transcript: transcript(s.events, opts.transcript ?? 12),
      watch_url: `${this.opts.baseUrl}/?call=${call.id}&t=${call.token}`,
    };
  }

  private requestView(call: ManagedCall, id: string, request: UserRequest) {
    return {
      id,
      kind: request.kind,
      title: request.title,
      detail: request.detail,
      ...(request.kind === 'approve_payment'
        ? { amount: request.amount, fee: request.fee, total: round(request.amount + request.fee), card: request.cardLabel }
        : {}),
      ...(request.kind === 'choose' ? { options: request.options } : {}),
      approval_url: `${this.opts.baseUrl}/?call=${call.id}&t=${call.token}&approve=${id}`,
    };
  }

  stats() {
    const recs = this.records;
    const done = recs.filter((r) => r.outcome === 'success');
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    return {
      calls: recs.length,
      completed: done.length,
      completion_rate: recs.length ? round(done.length / recs.length) : null,
      avg_call_seconds: Math.round(avg(recs.map((r) => r.callMs)) / 1000),
      hold_minutes_absorbed: Math.round(recs.reduce((a, r) => a + r.holdMs, 0) / 60_000),
      map_hits: recs.reduce((a, r) => a + r.mapHits, 0),
      model_calls: recs.reduce((a, r) => a + r.llmCalls, 0),
      user_touches_per_call: recs.length ? round(recs.reduce((a, r) => a + r.userTouches, 0) / recs.length) : null,
      mapped_phone_trees: this.opts.memory.all().filter((m) => m.screens.length).length,
      mapped_screens: this.opts.memory.all().reduce((a, m) => a + m.screens.length, 0),
      live_calls: [...this.calls.values()].filter((c) => !c.session.result).length,
      note: 'Simulated phone trees only in this build; see README for what is and is not real.',
    };
  }

  private record(call: ManagedCall, r: CallResult) {
    const rec: CallRecord = {
      id: call.id,
      business: call.task.business,
      kind: call.task.kind,
      outcome: r.outcome,
      callMs: r.callMs,
      holdMs: r.holdMs,
      mapHits: r.mapHits,
      llmCalls: r.llmCalls,
      userTouches: r.userTouches,
      simulated: call.simulated,
      at: Date.now(),
    };
    this.records.push(rec);
    if (this.opts.logPath) {
      mkdirSync(dirname(this.opts.logPath), { recursive: true });
      appendFileSync(this.opts.logPath, JSON.stringify(rec) + '\n');
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function metrics(r: CallResult) {
  return {
    call_seconds: Math.round(r.callMs / 1000),
    hold_seconds: Math.round(r.holdMs / 1000),
    user_touches: r.userTouches,
    map_hits: r.mapHits,
    model_calls: r.llmCalls,
  };
}

function transcript(events: CallEvent[], n: number) {
  const lines: { t: number; who: string; text: string }[] = [];
  for (const e of events) {
    if (e.type === 'heard' && !(e.speaker === 'hold' && e.text.startsWith('♪'))) lines.push({ t: s(e.t), who: e.speaker, text: e.text });
    else if (e.type === 'action' && e.action.type !== 'wait') lines.push({ t: s(e.t), who: 'voiced', text: e.action.type === 'press' ? `[pressed ${e.display}]` : e.display });
    // After handoff the conversation belongs to the user; Voiced doesn't keep it.
    else if (e.type === 'user_response') lines.push({ t: s(e.t), who: 'you', text: e.response.approved ? '[approved]' : '[declined]' });
  }
  return lines.slice(-n);
}

const s = (ms: number) => Math.round(ms / 1000);

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export { money };
