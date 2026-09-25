// Real phone calls over Twilio ConversationRelay. Twilio does the speech
// recognition and TTS; this module turns its WebSocket messages into the same
// Line interface the simulator implements, so CallSession doesn't know the
// difference.
//
// Status: written against Twilio's documented ConversationRelay protocol and
// its official SDK sources, but NOT yet exercised against a live Twilio account.
// See README → "Making real calls".
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER (caller ID),
//      VOICED_USER_PHONE (who to bridge in on handoff), PUBLIC_URL (https).

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { sentences } from '../core/parse.js';
import type { Line, LineEvent, Task } from '../core/types.js';

/** How long the far end must stay quiet before we treat its prompt as finished. */
const ENDPOINT_MS = 1400;
const API = 'https://api.twilio.com/2010-04-01';

interface TwilioConfig {
  sid: string;
  token: string;
  from: string;
  userPhone?: string;
  base: () => string;
}

export function twilioFromEnv(base: () => string) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_NUMBER: from, VOICED_USER_PHONE: userPhone } = process.env;
  if (!sid || !token || !from) return undefined;
  // Caller ID in E.164 whatever format the env uses ("(315) 555-0100" works too).
  const hub = new RelayHub({ sid, token, from: e164(from), userPhone, base });
  return {
    line: (task: Task): Line => new TwilioLine(hub, task),
    attach: (server: Server) => hub.attach(server),
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => hub.handle(req, res, url),
  };
}

class RelayHub {
  readonly lines = new Map<string, TwilioLine>();
  private wss = new WebSocketServer({ noServer: true });

  constructor(readonly cfg: TwilioConfig) {}

  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', this.cfg.base());
      if (url.pathname !== '/twilio/relay') return;
      const wssUrl = `${this.cfg.base().replace(/^http/, 'ws')}${req.url}`;
      if (!validSignature(this.cfg.token, String(req.headers['x-twilio-signature'] ?? ''), wssUrl, {})) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const line = this.lines.get(url.searchParams.get('job') ?? '');
        if (!line) return ws.close(1008, 'unknown job');
        line.connect(ws);
      });
    });
  }

  /** Twilio HTTP webhooks. Returns false if the path isn't ours. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/twilio/')) return false;
    const params = Object.fromEntries(new URLSearchParams(await body(req)));
    if (!validSignature(this.cfg.token, String(req.headers['x-twilio-signature'] ?? ''), `${this.cfg.base()}${req.url}`, params)) {
      res.writeHead(403).end();
      return true;
    }
    const line = this.lines.get(url.searchParams.get('job') ?? '');
    const twiml = (xml: string) => res.writeHead(200, { 'content-type': 'text/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`);
    switch (url.pathname) {
      case '/twilio/action': {
        // ConversationRelay ended. If it was a handoff, move the business leg into the user's room.
        const handoff = params.HandoffData ? safeJson(params.HandoffData) : undefined;
        if (params.SessionStatus !== 'failed' && handoff?.room) return twiml(conference(String(handoff.room))), true;
        line?.remoteHangup();
        return twiml('<Hangup/>'), true;
      }
      case '/twilio/user-accept': {
        if (params.Digits === '1' && line) {
          line.userAccepted();
          return twiml(conference(line.room)), true;
        }
        return twiml('<Say>Okay, Voiced will keep handling the call. Goodbye.</Say><Hangup/>'), true;
      }
      case '/twilio/status': {
        if (params.CallStatus && ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(params.CallStatus)) {
          if (url.searchParams.get('leg') === 'user') line?.userLegEnded(params.CallStatus);
          else line?.remoteHangup();
        }
        return res.writeHead(204).end(), true;
      }
    }
    res.writeHead(404).end();
    return true;
  }

  async rest(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`${API}/Accounts/${this.cfg.sid}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cfg.sid}:${this.cfg.token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${String(json.message ?? 'error')}`);
    return json;
  }
}

export class TwilioLine implements Line {
  readonly simulated = false;
  readonly job = randomUUID();
  readonly room = `voiced-${this.job}`;
  private ws?: WebSocket;
  private callSid?: string;
  private started = Date.now();
  private offset = 0;
  private queue: LineEvent[] = [];
  private waiter?: (e: LineEvent) => void;
  private quietTimer?: NodeJS.Timeout;
  private ended = false;
  private handedOff = false;
  private connected?: () => void;
  private accepted?: (ok: boolean) => void;
  /** Record the business leg (VOICED_RECORD=1). Recording pauses while vault digits are keyed. */
  private recorded = process.env.VOICED_RECORD === '1';

  constructor(
    private hub: RelayHub,
    private task: Task,
  ) {
    hub.lines.set(this.job, this);
  }

  now() {
    return Date.now() - this.started + this.offset;
  }

  elapse() {
    // Real time passes on its own.
  }

  async dial(): Promise<void> {
    const base = this.hub.cfg.base();
    const relay = `${base.replace(/^http/, 'ws')}/twilio/relay?job=${this.job}`;
    const hints = ['representative', 'operator', 'agent', 'billing', 'account number', this.task.business].join(',');
    const twiml =
      `<Response><Connect action="${xml(`${base}/twilio/action?job=${this.job}`)}" method="POST">` +
      `<ConversationRelay url="${xml(relay)}" transcriptionProvider="Deepgram" speechModel="nova-3-general" ttsProvider="ElevenLabs" language="en-US" interruptible="none" reportInputDuringAgentSpeech="speech" hints="${xml(hints)}">` +
      `<Parameter name="job" value="${this.job}"/></ConversationRelay></Connect></Response>`;
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Twilio never opened the ConversationRelay socket')), 90_000);
      this.connected = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const call = await this.hub.rest('/Calls.json', {
      To: e164(this.task.phone),
      From: this.hub.cfg.from,
      Twiml: twiml,
      StatusCallback: `${base}/twilio/status?job=${this.job}`,
      StatusCallbackEvent: 'completed',
      TimeLimit: String(3 * 3600),
      ...(this.recorded ? { Record: 'true' } : {}),
    });
    this.callSid = String(call.sid);
    this.started = Date.now();
    await connected;
  }

  connect(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => {
      const msg = safeJson(raw.toString());
      if (!msg) return;
      if (msg.type === 'setup') this.connected?.();
      if (msg.type === 'prompt' && msg.last !== false && typeof msg.voicePrompt === 'string') this.heard(msg.voicePrompt);
      if (msg.type === 'error') console.warn(`[twilio ${this.job}]`, msg.description);
    });
    ws.on('close', () => {
      clearTimeout(this.quietTimer);
      if (!this.handedOff) this.remoteHangup();
    });
  }

  private heard(text: string) {
    if (this.handedOff) return; // the user's conversation is theirs
    clearTimeout(this.quietTimer);
    for (const s of sentences(text)) this.push({ kind: 'speech', speaker: 'ivr', text: s, durationMs: 0 });
    this.quietTimer = setTimeout(() => this.push({ kind: 'silence', durationMs: ENDPOINT_MS }), ENDPOINT_MS);
  }

  private push(e: LineEvent) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(e);
    } else this.queue.push(e);
  }

  next(): Promise<LineEvent> {
    const e = this.queue.shift();
    if (e) return Promise.resolve(e);
    if (this.ended) return Promise.resolve({ kind: 'hangup', by: 'remote' });
    return new Promise((resolve) => (this.waiter = resolve));
  }

  async sendDigits(digits: string): Promise<void> {
    clearTimeout(this.quietTimer);
    this.send({ type: 'sendDigits', digits });
  }

  async say(text: string): Promise<void> {
    clearTimeout(this.quietTimer);
    // Not interruptible: speech-driven IVRs talk over callers and would cut us off.
    this.send({ type: 'text', token: text, last: true, interruptible: false });
  }

  /** Warm transfer: ring the user, wait for them to press 1, then move the business leg into their room. */
  async bridge(): Promise<void> {
    const { userPhone } = this.hub.cfg;
    if (!userPhone) throw new Error('VOICED_USER_PHONE is not set, so there is no one to hand the call to');
    const base = this.hub.cfg.base();
    const accepted = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 60_000);
      this.accepted = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
    });
    await this.hub.rest('/Calls.json', {
      To: e164(userPhone),
      From: this.hub.cfg.from,
      Twiml:
        `<Response><Gather numDigits="1" timeout="12" action="${xml(`${base}/twilio/user-accept?job=${this.job}`)}">` +
        `<Say>Voiced here. ${xml(this.task.business)} has a person on the line for you. Press 1 to connect.</Say></Gather>` +
        `<Say>No problem. Voiced will keep handling it.</Say></Response>`,
      StatusCallback: `${base}/twilio/status?job=${this.job}&leg=user`,
      StatusCallbackEvent: 'completed',
    });
    if (!(await accepted)) throw new Error('The user did not pick up to take the call');
    this.handedOff = true;
    this.send({ type: 'text', token: 'Connecting them now. Thank you!', last: true, interruptible: false });
    await new Promise((r) => setTimeout(r, 2200));
    this.send({ type: 'end', handoffData: JSON.stringify({ room: this.room }) });
  }

  /** PCI: pause the recording while card or account digits are keyed. Matches Twilio's spec for
   *  UpdateCallRecording (Twilio.CURRENT, paused/in-progress, PauseBehavior skip); not yet run on a live call. */
  async setRecording(on: boolean): Promise<void> {
    if (!this.recorded || !this.callSid || this.ended) return;
    await this.hub
      .rest(`/Calls/${this.callSid}/Recordings/Twilio.CURRENT.json`, on ? { Status: 'in-progress' } : { Status: 'paused', PauseBehavior: 'skip' })
      .catch((err) => console.warn(`[twilio ${this.job}] recording ${on ? 'resume' : 'pause'} failed`, err));
  }

  async hangup(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.send({ type: 'end' });
    if (this.callSid && !this.handedOff) await this.hub.rest(`/Calls/${this.callSid}.json`, { Status: 'completed' }).catch(() => {});
    this.push({ kind: 'hangup', by: 'local' });
    this.hub.lines.delete(this.job);
  }

  // Webhook callbacks -----------------------------------------------------------

  remoteHangup() {
    if (this.ended) return;
    this.ended = true;
    this.push({ kind: 'hangup', by: 'remote' });
    this.hub.lines.delete(this.job);
  }

  userAccepted() {
    this.accepted?.(true);
  }

  userLegEnded(status: string) {
    if (status !== 'completed') this.accepted?.(false);
    else if (this.handedOff) this.remoteHangup();
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}

function conference(room: string) {
  return `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${xml(room)}</Conference></Dial>`;
}

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function validSignature(token: string, signature: string, url: string, params: Record<string, string>): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', token).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function e164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

function xml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
