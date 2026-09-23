// A phone-tree simulator. Scenario scripts describe an IVR as a graph of
// nodes; SimLine plays them over the same Line interface a real phone call
// uses, with realistic timing, barge-in rules, timeouts, re-prompts, hold
// queues and a live human at the end of some trees.

import type { Line, LineEvent, Speaker } from '../core/types.js';

export interface SimCtx {
  vars: Record<string, string>;
  data: Record<string, any>;
  bridged: boolean;
  /** Free-form flags scripts may use (e.g. how many times a caller asked for a human). */
  flags: Record<string, number>;
}

export type Dyn<T> = T | ((ctx: SimCtx) => T);

export interface HumanReply {
  say: string[];
  end?: boolean;
}

export interface HumanBehavior {
  /** The agent said something to the human. */
  onAgent(text: string, ctx: SimCtx): HumanReply;
  /** The user was bridged in. */
  onBridge(ctx: SimCtx): HumanReply;
  /** The bridged user said something. */
  onUser(text: string, ctx: SimCtx): HumanReply;
}

export interface SpeechRoute {
  match: RegExp;
  to: Dyn<string>;
  set?: (ctx: SimCtx, text: string) => void;
}

export interface SimNode {
  say: Dyn<string[]>;
  speaker?: Speaker;
  /** Whether input is accepted while the prompt is still playing. Defaults to true for input nodes. */
  interruptible?: boolean;
  /** Auto-advance target when the node takes no input, or when an optional-input node times out. */
  next?: Dyn<string>;
  pauseMs?: number;
  menu?: Record<string, Dyn<string>>;
  speech?: SpeechRoute[];
  /** Free-form speech captured into a variable. */
  capture?: { store: string; parse: (text: string, ctx: SimCtx) => string | undefined; to: Dyn<string> };
  /** Keypad entry captured into a variable. */
  collect?: {
    min: number;
    max: number;
    terminator?: boolean;
    store: string;
    validate?: (value: string, ctx: SimCtx) => boolean;
    to: Dyn<string>;
    invalid?: string;
  };
  hold?: { ms: number; messages: string[]; every: number };
  human?: HumanBehavior;
  end?: boolean;
  invalid?: string;
  timeoutMs?: number;
  maxRetries?: number;
  onEnter?: (ctx: SimCtx) => void;
}

export interface IvrScript {
  id: string;
  business: string;
  phone: string;
  start: string;
  nodes: Record<string, SimNode>;
  data?: Record<string, any>;
}

export interface SimClock {
  /** Wait for `ms` of call time to pass. `hold` time is typically fast-forwarded harder. */
  sleep(ms: number, mode: 'talk' | 'hold'): Promise<void>;
}

export const instantClock: SimClock = { sleep: async () => {} };

/** A clock that plays call time back at `speed`x real time (hold at `speed * holdBoost`). */
export class PacedClock implements SimClock {
  constructor(public speed = 8, public holdBoost = 12) {}
  sleep(ms: number, mode: 'talk' | 'hold'): Promise<void> {
    if (!Number.isFinite(this.speed)) return Promise.resolve();
    const factor = mode === 'hold' ? this.speed * this.holdBoost : this.speed;
    const real = Math.min(ms / factor, 8000);
    return new Promise((r) => setTimeout(r, real));
  }
}

export const WORDS_PER_SECOND = 2.6;

export function speechMs(text: string, wps = WORDS_PER_SECOND): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round((words / wps) * 1000) + 280;
}

const HOLD_SEGMENT_MS = 30_000;

export class SimLine implements Line {
  readonly simulated = true;
  readonly ctx: SimCtx;
  private t = 0;
  private queue: LineEvent[] = [];
  private nodeId = '';
  private node!: SimNode;
  private awaiting = false;
  private idleMs = 0;
  private retries = 0;
  private ended = false;
  private collectBuf = '';
  private wake: (() => void) | undefined;
  /** Node ids in the order they were entered — handy for tests and debugging. */
  readonly trail: string[] = [];

  constructor(
    private script: IvrScript,
    private clock: SimClock = instantClock,
  ) {
    this.ctx = { vars: {}, data: structuredClone(script.data ?? {}), bridged: false, flags: {} };
  }

  get currentNode(): string {
    return this.nodeId;
  }

  now(): number {
    return this.t;
  }

  elapse(ms: number): void {
    this.t += Math.max(0, ms);
  }

  async dial(): Promise<void> {
    await this.pass(2400, 'talk'); // ring ring
    this.enter(this.script.start);
  }

  async next(): Promise<LineEvent> {
    for (;;) {
      const ev = this.queue.shift();
      if (ev) {
        if (ev.kind === 'hangup') {
          this.ended = true;
          return ev;
        }
        await this.pass(ev.durationMs, ev.kind === 'speech' && ev.speaker === 'hold' ? 'hold' : 'talk');
        return ev;
      }
      if (this.ended) return { kind: 'hangup', by: 'remote' };
      const node = this.node;
      if (node.end) {
        this.queue.push({ kind: 'hangup', by: 'remote' });
        continue;
      }
      if (!this.takesInput(node)) {
        await this.pass(node.pauseMs ?? 350, 'talk');
        this.enter(resolve(node.next!, this.ctx));
        continue;
      }
      if (this.ctx.bridged) {
        // The user is talking to the human; nothing happens until someone speaks.
        await new Promise<void>((r) => (this.wake = r));
        this.wake = undefined;
        continue;
      }
      if (!this.awaiting) {
        this.awaiting = true;
        this.idleMs = 0;
      }
      if (this.idleMs === 0) {
        // Endpointing: the caller notices the prompt is over.
        const d = 650;
        await this.pass(d, 'talk');
        this.idleMs = d;
        return { kind: 'silence', durationMs: d };
      }
      const timeout = Math.max(500, (node.timeoutMs ?? 6000) - this.idleMs);
      await this.pass(timeout, 'talk');
      this.onNoInput();
    }
  }

  async sendDigits(digits: string): Promise<void> {
    await this.pass(digits.length * 160 + 120, 'talk');
    if (this.ended || this.ctx.bridged) return;
    const node = this.node;
    if (!this.listening(node) || node.human) return; // tones while the IVR isn't listening are lost
    this.bargeIn();
    if (node.collect) return this.onCollect(node, digits);
    if (node.menu) {
      const target = node.menu[digits[0]];
      if (target) return this.enter(resolve(target, this.ctx));
    }
    this.onInvalid();
  }

  async say(text: string): Promise<void> {
    await this.pass(speechMs(text, 2.8), 'talk');
    if (this.ended || this.ctx.bridged) return;
    const node = this.node;
    if (node.human) {
      this.bargeIn();
      return this.human(node.human.onAgent(text, this.ctx));
    }
    if (!this.listening(node) || (!node.speech && !node.capture)) {
      if (this.listening(node) && (node.menu || node.collect)) this.onInvalid();
      return;
    }
    this.bargeIn();
    for (const route of node.speech ?? []) {
      if (route.match.test(text)) {
        route.set?.(this.ctx, text);
        return this.enter(resolve(route.to, this.ctx));
      }
    }
    if (node.capture) {
      const value = node.capture.parse(text, this.ctx);
      if (value !== undefined) {
        this.ctx.vars[node.capture.store] = value;
        return this.enter(resolve(node.capture.to, this.ctx));
      }
    }
    this.onInvalid();
  }

  async bridge(): Promise<void> {
    await this.pass(4500, 'talk'); // ringing the user, "press 1 to connect"
    if (this.ended || !this.node.human) return;
    this.ctx.bridged = true;
    this.human(this.node.human.onBridge(this.ctx));
  }

  async userSays(text: string): Promise<void> {
    await this.pass(speechMs(text, 2.8), 'talk');
    if (this.ended || !this.node.human || !this.ctx.bridged) return;
    this.human(this.node.human.onUser(text, this.ctx));
  }

  async hangup(): Promise<void> {
    this.ended = true;
    this.queue = [];
    this.wake?.();
  }

  // -------------------------------------------------------------------------

  private async pass(ms: number, mode: 'talk' | 'hold') {
    await this.clock.sleep(ms, mode);
    this.t += ms;
  }

  private enter(id: string) {
    const node = this.script.nodes[id];
    if (!node) throw new Error(`${this.script.id}: unknown node "${id}"`);
    if (id !== this.nodeId) this.retries = 0;
    this.nodeId = id;
    this.node = node;
    this.trail.push(id);
    this.awaiting = false;
    this.idleMs = 0;
    this.collectBuf = '';
    node.onEnter?.(this.ctx);
    this.speak(resolve(node.say, this.ctx), node.speaker ?? 'ivr');
    if (node.hold) this.queueHold(node.hold);
  }

  private queueHold(hold: NonNullable<SimNode['hold']>) {
    let left = hold.ms;
    let i = 0;
    while (left > 0) {
      const seg = Math.min(HOLD_SEGMENT_MS, left);
      this.queue.push({ kind: 'speech', speaker: 'hold', text: '♪ hold music ♪', durationMs: seg });
      left -= seg;
      i += 1;
      if (left > 0 && hold.messages.length && i % hold.every === 0) {
        const text = hold.messages[(i / hold.every - 1) % hold.messages.length];
        const d = speechMs(text);
        this.queue.push({ kind: 'speech', speaker: 'hold', text, durationMs: d });
        left -= d;
      }
    }
  }

  private speak(lines: (string | null | undefined)[], speaker: Speaker) {
    for (const text of lines) {
      if (!text) continue;
      this.queue.push({ kind: 'speech', speaker, text, durationMs: speechMs(text) });
    }
  }

  private human(reply: HumanReply) {
    this.speak(reply.say, 'human');
    if (reply.end) this.queue.push({ kind: 'hangup', by: 'remote' });
    this.awaiting = false;
    this.idleMs = 0;
    this.wake?.();
  }

  private takesInput(node: SimNode): boolean {
    return !!(node.menu || node.speech || node.capture || node.collect || node.human);
  }

  private listening(node: SimNode): boolean {
    if (!this.takesInput(node)) return false;
    const stillTalking = this.queue.some((e) => e.kind === 'speech');
    return !stillTalking || node.interruptible !== false;
  }

  private bargeIn() {
    this.queue = this.queue.filter((e) => e.kind !== 'speech');
  }

  private onCollect(node: SimNode, digits: string) {
    const c = node.collect!;
    this.collectBuf += digits;
    let value: string | undefined;
    if (c.terminator) {
      const at = this.collectBuf.indexOf('#');
      if (at === -1) {
        if (this.collectBuf.length < c.max + 4) return; // keep listening for more digits
        value = this.collectBuf;
      } else value = this.collectBuf.slice(0, at);
    } else {
      const clean = this.collectBuf.replace(/#/g, '');
      if (clean.length < c.max && !this.collectBuf.includes('#')) return;
      value = clean;
    }
    this.collectBuf = '';
    const ok = /^\d+$/.test(value) && value.length >= c.min && value.length <= c.max && (c.validate?.(value, this.ctx) ?? true);
    if (!ok) return this.onInvalid(c.invalid);
    this.ctx.vars[c.store] = value;
    this.enter(resolve(c.to, this.ctx));
  }

  private onInvalid(message?: string) {
    this.retries += 1;
    const node = this.node;
    if (this.retries > (node.maxRetries ?? 3)) return this.giveUp();
    const intro = message ?? node.invalid ?? (node.human ? "Sorry, I didn't catch that." : "I'm sorry, that's not a valid entry.");
    this.queue = this.queue.filter((e) => e.kind !== 'speech');
    this.speak([intro, ...(node.human ? [] : resolve(node.say, this.ctx))], node.speaker ?? 'ivr');
    this.awaiting = false;
    this.idleMs = 0;
  }

  private onNoInput() {
    const node = this.node;
    if (node.next && !node.human) {
      // Optional input (e.g. "para español, oprima nueve"): silence moves the call along.
      this.enter(resolve(node.next, this.ctx));
      return;
    }
    this.retries += 1;
    if (this.retries > (node.maxRetries ?? 3)) return this.giveUp();
    const intro = node.human ? 'Hello? Are you still there?' : "Sorry, I didn't hear a response.";
    this.speak([intro, ...(node.human ? [] : resolve(node.say, this.ctx))], node.speaker ?? 'ivr');
    this.awaiting = false;
    this.idleMs = 0;
  }

  private giveUp() {
    const speaker = this.node.speaker ?? 'ivr';
    this.speak(
      speaker === 'human'
        ? ["I'm not hearing anything, so I'm going to disconnect. Goodbye."]
        : ["We're sorry, we were unable to complete your request.", 'Goodbye.'],
      speaker,
    );
    this.queue.push({ kind: 'hangup', by: 'remote' });
  }
}

export function resolve<T>(v: Dyn<T>, ctx: SimCtx): T {
  return typeof v === 'function' ? (v as (c: SimCtx) => T)(ctx) : v;
}

/** "4 8 2 0 1 7" — how IVRs read out codes. */
export function spell(code: string): string {
  return code.split('').join(' ');
}

export function luhn(num: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
