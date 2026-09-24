// The UI talks to calls through this interface. LocalEngine runs the whole call
// engine in the browser (the published demo); RemoteEngine talks to a Voiced
// server over REST + SSE (npm start).

import type { Brain } from '../src/brains/brain.js';
import { RulesBrain } from '../src/brains/rules.js';
import { MapMemory, type IvrMap, type MapStore } from '../src/core/memory.js';
import { CallSession } from '../src/core/session.js';
import type { CallEvent, CallResult, UserResponse } from '../src/core/types.js';
import { Vault } from '../src/core/vault.js';
import { PacedClock, SimLine } from '../src/sim/engine.js';
import { getScenario, scenarios } from '../src/sim/scenarios/index.js';

export interface Business {
  id: string;
  business: string;
  phone: string;
  category: string;
  title: string;
  pain: string[];
  featured: boolean;
}

export interface MapView {
  phone: string;
  business: string;
  calls: number;
  screens: number;
}

export interface Stats {
  calls: number;
  completed: number;
  completionRate: number | null;
  holdMinutes: number;
  mapHits: number;
}

export interface StartOptions {
  businessId: string;
  maxAmount?: number;
  maxFee?: number;
  card?: string;
  speed: number;
}

export interface CallHandle {
  id: string;
  onEvent(fn: (e: CallEvent) => void): void;
  respond(requestId: string, response: UserResponse): void;
  say(text: string): void;
  hangup(): void;
  setSpeed(speed: number): void;
}

export interface Engine {
  mode: 'local' | 'server';
  brainLabel: string;
  businesses(): Business[];
  start(opts: StartOptions): Promise<CallHandle>;
  attach?(id: string, token: string): Promise<CallHandle>;
  maps(): Promise<MapView[]>;
  stats(): Promise<Stats>;
  resetMaps(): Promise<void>;
}

const BUSINESSES: Business[] = scenarios.map((s) => ({
  id: s.id,
  business: s.business,
  phone: s.phone,
  category: s.category,
  title: s.title,
  pain: s.pain,
  featured: s.featured,
}));

// --- In-browser engine -----------------------------------------------------------

class LocalStore implements MapStore {
  constructor(private key: string) {}
  load() {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '{}') as Record<string, IvrMap>;
    } catch {
      return {};
    }
  }
  save(maps: Record<string, IvrMap>) {
    try {
      localStorage.setItem(this.key, JSON.stringify(maps));
    } catch {
      /* storage unavailable: the map lives for this page view only */
    }
  }
}

const RECORDS_KEY = 'voiced.records.v1';

export class LocalEngine implements Engine {
  readonly mode = 'local' as const;
  private memory = new MapMemory(new LocalStore('voiced.maps.v1'));
  private records: CallResult[] = readRecords();

  constructor(private brain: () => Brain = () => new RulesBrain(), public brainLabel = 'Rules brain') {}

  setBrain(brain: () => Brain, label: string) {
    this.brain = brain;
    this.brainLabel = label;
  }

  businesses() {
    return BUSINESSES;
  }

  async start(opts: StartOptions): Promise<CallHandle> {
    const scenario = getScenario(opts.businessId)!;
    const { task, secrets } = scenario.task({ cardId: opts.card, maxAmount: opts.maxAmount, maxFee: opts.maxFee });
    const clock = new PacedClock(opts.speed);
    const line = new SimLine(scenario.script(), clock);
    const session = new CallSession({
      task,
      line,
      brain: this.brain(),
      fallback: new RulesBrain(),
      memory: this.memory,
      vault: new Vault(task.facts, secrets),
    });
    const listeners: ((e: CallEvent) => void)[] = [];
    session.subscribe((e) => {
      if (e.type === 'ended') {
        this.records.push(e.result);
        try {
          localStorage.setItem(RECORDS_KEY, JSON.stringify(this.records.slice(-200)));
        } catch {
          /* ignore */
        }
      }
      for (const fn of listeners) fn(e);
    });
    queueMicrotask(() => void session.run());
    return {
      id: session.id,
      onEvent: (fn) => listeners.push(fn),
      respond: (id, r) => session.respond(id, r),
      say: (text) => void session.userSays(text),
      hangup: () => void session.hangup(),
      setSpeed: (s) => (clock.speed = s),
    };
  }

  async maps(): Promise<MapView[]> {
    return this.memory.all().map((m) => ({ phone: m.phone, business: m.business, calls: m.calls, screens: m.screens.length }));
  }

  async stats(): Promise<Stats> {
    return summarize(this.records);
  }

  async resetMaps() {
    this.memory.reset();
    this.records = [];
    try {
      localStorage.removeItem(RECORDS_KEY);
    } catch {
      /* ignore */
    }
  }
}

function readRecords(): CallResult[] {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function summarize(records: CallResult[]): Stats {
  const done = records.filter((r) => r.outcome === 'success').length;
  return {
    calls: records.length,
    completed: done,
    completionRate: records.length ? done / records.length : null,
    holdMinutes: Math.round(records.reduce((a, r) => a + r.holdMs, 0) / 60_000),
    mapHits: records.reduce((a, r) => a + r.mapHits, 0),
  };
}

// --- Server engine ---------------------------------------------------------------

export class RemoteEngine implements Engine {
  readonly mode = 'server' as const;

  constructor(
    private apiKey: string,
    public brainLabel: string,
  ) {}

  businesses() {
    return BUSINESSES;
  }

  private async api(path: string, init: RequestInit = {}) {
    const res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json();
  }

  async start(opts: StartOptions): Promise<CallHandle> {
    const call = await this.api('/v1/calls', {
      method: 'POST',
      body: JSON.stringify({ business_id: opts.businessId, max_amount: opts.maxAmount, max_fee: opts.maxFee, card: opts.card, speed: opts.speed }),
    });
    return this.handle(call.id, new URL(call.watch_url).searchParams.get('t') ?? '');
  }

  async attach(id: string, token: string): Promise<CallHandle> {
    return this.handle(id, token);
  }

  private handle(id: string, token: string): CallHandle {
    const listeners: ((e: CallEvent) => void)[] = [];
    const q = `?t=${encodeURIComponent(token)}`;
    const source = new EventSource(`/v1/calls/${id}/events${q}`);
    source.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'hello' || e.type === 'map') return;
      for (const fn of listeners) fn(e);
      if (e.type === 'ended') source.close();
    };
    const post = (path: string, body: unknown) =>
      fetch(`/v1/calls/${id}/${path}${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return {
      id,
      onEvent: (fn) => listeners.push(fn),
      respond: (requestId, r) => void post('respond', { request_id: requestId, ...r }),
      say: (text) => void post('message', { text }),
      hangup: () => void post('hangup', {}),
      setSpeed: (speed) => void post('speed', { speed }),
    };
  }

  async maps(): Promise<MapView[]> {
    const maps = (await this.api('/v1/maps')) as { phone: string; business: string; calls: number; screens: unknown[] }[];
    return maps.map((m) => ({ phone: m.phone, business: m.business, calls: m.calls, screens: m.screens.length }));
  }

  async stats(): Promise<Stats> {
    const s = await this.api('/v1/stats');
    return { calls: s.calls, completed: s.completed, completionRate: s.completion_rate, holdMinutes: s.hold_minutes_absorbed, mapHits: s.map_hits };
  }

  async resetMaps() {
    await this.api('/v1/maps', { method: 'DELETE' });
  }
}
