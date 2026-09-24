import { formatDuration } from '../src/core/session.js';
import type { CallEvent, CallResult, UserRequest } from '../src/core/types.js';
import { RulesBrain } from '../src/brains/rules.js';
import { DTMF, speak, stopSpeech, tone, unlockAudio } from './audio.js';
import { LocalEngine, RemoteEngine, type Business, type CallHandle, type Engine, type StartOptions } from './engine.js';
import { SampleBrain, type SampleFn } from './sample-brain.js';

interface Config {
  mode: 'local' | 'server';
  apiKey?: string;
  brain?: 'claude' | 'rules';
}

const config: Config = (window as unknown as { VOICED_CONFIG?: Config }).VOICED_CONFIG ?? { mode: 'local' };
const engine: Engine =
  config.mode === 'server'
    ? new RemoteEngine(config.apiKey ?? '', config.brain === 'claude' ? 'Claude brain' : 'Rules brain')
    : new LocalEngine();

// --- DOM helpers ------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
/** replaceChildren that skips empty slots. */
function fill(el: Element, ...children: Child[]) {
  el.replaceChildren(...(children.filter((c) => c !== null && c !== undefined && c !== false) as (Node | string)[]));
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const money = (n: number) => `$${n.toFixed(2)}`;
const LOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 7V5a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>';

// --- State ---------------------------------------------------------------------------

interface Screen {
  el: HTMLLIElement;
  opts: HTMLElement;
  did: HTMLElement;
  options: { key: string; label: string; via: string }[];
}

interface Live {
  biz: Business;
  handle: CallHandle;
  opts: StartOptions;
  taps: number;
  screens: Map<number, Screen>;
  screenCount: number;
  firstLine: Map<number, string>;
  lastWho?: string;
  rep?: string;
  hold?: { row: HTMLElement; time: HTMLElement; start: number };
  lastWait?: string;
  pending: Map<string, HTMLElement[]>;
  ended: boolean;
  mapBefore: number;
}

let speed = 8;
let sound = false;
let live: Live | undefined;
const lastRun = new Map<string, CallResult>();
const businesses = engine.businesses();
const hero = businesses.find((b) => b.id === 'bedford')!;

const STATUS: Record<string, string> = {
  dialing: 'Dialing',
  navigating: 'Navigating',
  on_hold: 'On hold',
  talking_to_human: 'Person on the line',
  awaiting_user: 'Needs you',
  handing_off: 'Calling you in',
  user_connected: 'You’re on',
  ended: 'Ended',
};

const REPLIES: Record<string, string[]> = {
  kestrel: ['Hi Dana, yes. It’s the $49.99 device protection charge. I never signed up for it.', 'That’s all, thank you!'],
};

// --- Boot ------------------------------------------------------------------------------

function boot() {
  $('hero-eyebrow').textContent = `Simulated call · ${hero.business} · ${hero.phone}`;
  $('hero-lede').textContent =
    'Voiced dials, gets through the menus, keys in your account and card from the vault, pays, and hangs up with a confirmation number. It stops to ask you only if a fee or the amount goes past what you approved.';
  $('hero-pain').replaceChildren(...hero.pain.map((p) => h('li', {}, p)));
  $('hero-cta').addEventListener('click', () => request(hero, hero.title));
  $('task-list').replaceChildren(
    ...businesses
      .filter((b) => b.id !== hero.id)
      .map((b) => {
        const btn = h('button', { type: 'button', class: 'task' }, h('span', { class: 'cat' }, b.category), h('span', { class: 't' }, b.title), h('span', { class: 'b' }, b.business));
        btn.addEventListener('click', () => request(b, b.title));
        return btn;
      }),
  );
  renderSuggestions();
  renderKeypad();

  for (const btn of $('speed-seg').querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => {
      speed = Number(btn.dataset.speed);
      for (const b of $('speed-seg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
      live?.handle.setSpeed(speed);
      if (speed > 1) stopSpeech();
    });
  }
  $('sound-btn').addEventListener('click', () => {
    sound = !sound;
    if (sound) unlockAudio();
    else stopSpeech();
    $('sound-btn').setAttribute('aria-pressed', String(sound));
    $('sound-btn').textContent = sound ? 'Sound on' : 'Sound off';
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('composer-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onComposer(text);
  });
  $('talk').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('talk-input');
    if (input.value.trim()) talk(input.value.trim());
    input.value = '';
  });
  $('hangup').addEventListener('click', () => live?.handle.hangup());
  $('reset-map').addEventListener('click', async () => {
    await engine.resetMaps();
    lastRun.clear();
    await refreshNetwork();
    bot('Cleared the phone-tree map. The next call to each business starts from scratch.');
  });
  $('mode-chip').textContent = `Simulated phone trees · ${engine.brainLabel}`;

  bot(`Hi Jordan. I can call businesses for you and deal with the phone tree. Your Bedford utilities bill is due October 3rd. Want me to pay it?`);
  void refreshNetwork();
  void enableClaude();
  void watchFromUrl();
}

function renderSuggestions() {
  const box = $('suggestions');
  box.replaceChildren(
    ...businesses.map((b) => {
      const btn = h('button', { type: 'button', class: b.id === hero.id ? 'hero' : '' }, b.title);
      btn.addEventListener('click', () => request(b, b.title));
      return btn;
    }),
  );
}

function renderKeypad() {
  const letters: Record<string, string> = { '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ', '0': '+' };
  $('keypad').replaceChildren(
    ...'123456789*0#'.split('').map((k) => h('span', { class: 'key', 'data-key': k }, h('b', {}, k), h('small', {}, letters[k] ?? ' '))),
  );
}

// --- Assistant chat ------------------------------------------------------------------

function chatAdd(el: HTMLElement) {
  $('chat').append(el);
  el.scrollIntoView({ block: 'nearest' });
  return el;
}
function me(text: string) {
  return chatAdd(h('div', { class: 'msg me' }, text));
}
function bot(text: string, strong?: string) {
  const el = h('div', { class: 'msg bot' });
  if (strong) el.append(h('strong', {}, strong), ' ');
  el.append(text);
  return chatAdd(el);
}
function toolcall(name: string, args: Record<string, unknown>) {
  const el = h('div', { class: 'toolcall' }, 'voiced.', h('b', {}, name), `(${JSON.stringify(args).replace(/"(\w+)":/g, '$1: ')})`);
  return chatAdd(el);
}

function onComposer(text: string) {
  if (live && !live.ended && $('talk').hidden === false) return talk(text);
  me(text);
  const t = text.toLowerCase();
  const pick =
    /bedford|electric|utilit|water|power/.test(t) ? 'bedford'
    : /gym|iron|member/.test(t) ? 'irontemple'
    : /kestrel|wireless|dispute|charge|human|person|representative|agent/.test(t) ? 'kestrel'
    : /dinner|luna|reserv|table|book|restaurant/.test(t) ? 'luna'
    : /\bpay\b|bill/.test(t) ? 'bedford'
    : /cancel/.test(t) ? 'irontemple'
    : undefined;
  const biz = businesses.find((b) => b.id === pick);
  if (!biz) {
    bot(`In this demo I can call four simulated businesses: ${businesses.map((b) => b.business).join(', ')}. Try “pay my Bedford bill” or “cancel my gym”.`);
    return;
  }
  request(biz, undefined);
}

/** The user asked for a call. Show the one-tap authorization. */
function request(biz: Business, said: string | undefined) {
  if (live && !live.ended) {
    bot('I’m still on the other call. Hang up first or wait for it to finish.');
    return;
  }
  if (said) me(said);
  openSheet(biz);
}

// --- Authorization sheet --------------------------------------------------------------

function openSheet(biz: Business) {
  const form = $<HTMLFormElement>('sheet-form');
  const field = (label: string, id: string, control: HTMLElement, hint?: string) =>
    h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  let body: Child[] = [];
  let cta = 'Start the call';
  if (biz.id === 'bedford') {
    const card = h('select', { id: 'auth-card' }, h('option', { value: 'visa' }, 'Visa •• 4242'), h('option', { value: 'amex' }, 'Amex •• 0005'));
    const max = h('input', { id: 'auth-max', type: 'number', min: '1', step: '1', value: '200', inputmode: 'decimal' });
    const fee = h('select', { id: 'auth-fee' }, h('option', { value: '0' }, 'Ask me first'), h('option', { value: '5' }, 'Up to $5.00'));
    const cvv = h('input', { id: 'auth-cvv', type: 'password', value: '737', inputmode: 'numeric', maxlength: '4', autocomplete: 'off' });
    body = [
      h('p', {}, 'Voiced will call ', h('b', {}, biz.business), ' at ', h('span', { class: 'num' }, biz.phone), ' and pay your current balance.'),
      field('Card', 'auth-card', card),
      h('div', { class: 'fields' }, field('Pay up to', 'auth-max', max), field('Card fees', 'auth-fee', fee)),
      field('Security code', 'auth-cvv', cvv, 'Used on this call only, then wiped. The model never sees it.'),
    ];
    cta = 'Approve & call';
  } else if (biz.id === 'irontemple') {
    body = [
      h('p', {}, 'Voiced will call ', h('b', {}, biz.business), ' and cancel your membership.'),
      h('ul', {}, h('li', {}, 'Decline the retention offers (discounts, freezes)'), h('li', {}, 'Confirm the cancellation and get a confirmation number')),
    ];
    cta = 'Cancel my membership';
  } else if (biz.id === 'kestrel') {
    body = [
      h('p', {}, 'Voiced will get past the ', h('b', {}, biz.business), ' phone tree, wait on hold, brief the rep about the $49.99 charge, and bring you in when a person is ready.'),
      h('ul', {}, h('li', {}, 'You won’t hear the hold music'), h('li', {}, 'Voiced tells the rep it’s an AI assistant')),
    ];
    cta = 'Get me a human';
  } else {
    body = [
      h('p', {}, 'Voiced will call ', h('b', {}, biz.business), ' and book a table.'),
      h('ul', {}, h('li', {}, '4 people, Friday September 25th'), h('li', {}, 'Any time from 7:00 to 8:00 PM'), h('li', {}, 'Mention it’s a birthday')),
    ];
    cta = 'Book it';
  }
  const cancel = h('button', { type: 'button', class: 'secondary' }, 'Not now');
  cancel.addEventListener('click', () => {
    closeSheet();
    bot('No problem. I won’t call.');
  });
  fill(form, h('h3', { id: 'sheet-title' }, biz.title), ...body, h('div', { class: 'row' }, cancel, h('button', { type: 'submit', class: 'primary' }, cta)));
  form.onsubmit = (e) => {
    e.preventDefault();
    const opts: StartOptions = { businessId: biz.id, speed };
    if (biz.id === 'bedford') {
      opts.card = $<HTMLSelectElement>('auth-card').value;
      opts.maxAmount = Number($<HTMLInputElement>('auth-max').value) || 200;
      opts.maxFee = Number($<HTMLSelectElement>('auth-fee').value);
    }
    closeSheet();
    void start(biz, opts);
  };
  $('sheet').hidden = false;
  form.querySelector<HTMLElement>('button[type=submit]')?.focus();
}

function closeSheet() {
  $('sheet').hidden = true;
}

// --- Calls -----------------------------------------------------------------------------

async function start(biz: Business, opts: StartOptions) {
  if (sound) unlockAudio();
  const maps = await engine.maps().catch(() => []);
  const mapBefore = maps.find((m) => digits(m.phone) === digits(biz.phone))?.screens ?? 0;
  const args: Record<string, unknown> = { business_id: biz.id };
  if (opts.maxAmount !== undefined) Object.assign(args, { max_amount: opts.maxAmount, max_fee: opts.maxFee });
  toolcall('start_call', args);
  bot(
    biz.id === 'bedford'
      ? `Calling ${biz.business}. I’ll pay up to ${money(opts.maxAmount ?? 200)} on ${opts.card === 'amex' ? 'Amex •• 0005' : 'Visa •• 4242'}${opts.maxFee ? ` plus fees up to ${money(opts.maxFee)}` : ''} and only interrupt you if it costs more.`
      : `Calling ${biz.business}. I’ll handle the phone tree and only interrupt you if I need a yes.`,
  );
  if (mapBefore) bot(`I’ve mapped ${mapBefore} screens of this phone tree on earlier calls, so I can skip ahead on those.`);

  let handle: CallHandle;
  try {
    handle = await engine.start({ ...opts, speed });
  } catch (err) {
    bot(`I couldn’t start the call: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  begin(biz, handle, opts, mapBefore);
}

function begin(biz: Business, handle: CallHandle, opts: StartOptions, mapBefore: number) {
  live = { biz, handle, opts, taps: 1, screens: new Map(), screenCount: 0, firstLine: new Map(), pending: new Map(), ended: false, mapBefore };
  $('call-idle').hidden = true;
  $('call-live').hidden = false;
  $('result').hidden = true;
  $('call-biz').textContent = biz.business;
  $('call-num').textContent = biz.phone;
  $('transcript').replaceChildren();
  $('screens').replaceChildren();
  $('push').hidden = true;
  $('talk').hidden = true;
  $('replies').hidden = true;
  $('tones').textContent = 'No tones sent yet';
  $<HTMLButtonElement>('hangup').disabled = false;
  $('map-sub').textContent = `${biz.business} · ${mapBefore ? `${mapBefore} screens known` : 'first call, mapping now'}`;
  setTaps();
  const current = live;
  handle.onEvent((e) => {
    if (live === current) onEvent(e);
  });
}

function onEvent(e: CallEvent) {
  const L = live!;
  if ('t' in e) $('call-clock').textContent = clock(e.t);
  switch (e.type) {
    case 'status':
      setStatus(e.status);
      if (e.status === 'dialing') line(e.t, 'sys', null, `Dialing ${L.biz.phone}…`, 'muted');
      if (e.status === 'on_hold') bot(`I’m on hold with ${L.biz.business}. I’ll wait so you don’t have to.`);
      if (e.status === 'user_connected') {
        $('talk').hidden = false;
        const replies = REPLIES[L.biz.id] ?? [];
        if (replies.length) {
          $('replies').hidden = false;
          $('replies').replaceChildren(
            ...replies.map((r) => {
              const b = h('button', { type: 'button' }, r);
              b.addEventListener('click', () => talk(r));
              return b;
            }),
          );
        }
        $<HTMLInputElement>('talk-input').focus({ preventScroll: true });
      }
      break;
    case 'heard':
      onHeard(e);
      break;
    case 'turn':
      onTurn(e);
      break;
    case 'action':
      onAction(e);
      break;
    case 'note':
      if (e.key === 'confirmation' || e.key === 'case') line(e.t, 'sys', null, h('span', { class: 'conf' }, `${e.key === 'case' ? 'Case' : 'Confirmation'} ${e.value}`));
      if (e.key === 'rep') L.rep = e.value;
      break;
    case 'user_request':
      onRequest(e.id, e.request);
      break;
    case 'user_response':
      settle(e.id, e.response.approved ? 'You approved.' : 'You declined.');
      line(e.t, 'sys', null, e.response.approved ? 'You approved.' : 'You declined.', 'muted');
      break;
    case 'handoff':
      endHold(e.t);
      line(e.t, 'handoff-line', null, h('div', { class: 'handoff' }, h('b', {}, 'Handing the call to you'), e.briefing));
      bot(e.briefing, `${L.rep ?? 'A person'} is ready for you.`);
      break;
    case 'bridge': {
      const you = e.from === 'user';
      line(e.t, you ? 'you' : 'rep', you ? 'You' : (L.rep ?? 'Rep'), h('span', { class: 'bubble' }, e.text));
      if (!you && sound && speed <= 1) speak(e.text, 'human');
      break;
    }
    case 'ended':
      finish(e.result);
      break;
  }
}

function onHeard(e: Extract<CallEvent, { type: 'heard' }>) {
  const L = live!;
  if (!L.firstLine.has(e.turn)) L.firstLine.set(e.turn, e.text);
  if (e.speaker === 'hold' && e.text.startsWith('♪')) {
    if (!L.hold) {
      const time = h('span', { class: 'hm' }, '0:00');
      const row = h('div', { class: 'hold-row' }, h('span', { class: 'eq' }, h('i'), h('i'), h('i')), h('span', {}, 'On hold '), time, h('span', { class: 'note' }, 'Voiced is waiting so you don’t have to'));
      line(e.t, 'hold', null, row);
      L.hold = { row, time, start: e.t };
    }
    L.hold.time.textContent = formatDuration(e.t - L.hold.start);
    return;
  }
  if (e.speaker === 'human') {
    endHold(e.t);
    L.rep ??= /\b(?:this is|my name is)\s+([A-Z][a-z]+)/.exec(e.text)?.[1];
  }
  const who = e.speaker === 'human' ? (L.rep ?? 'Person') : e.speaker === 'hold' ? 'Hold' : 'IVR';
  line(e.t, e.speaker === 'human' ? 'human' : 'ivr', L.lastWho === who ? null : who, e.text, e.speaker === 'hold' ? 'muted' : undefined);
  L.lastWho = who;
  if (sound && speed <= 1) speak(e.text, e.speaker === 'human' ? 'human' : 'ivr');
}

function endHold(t: number) {
  const L = live!;
  if (!L.hold) return;
  L.hold.row.classList.add('done');
  L.hold.time.textContent = formatDuration(t - L.hold.start);
  L.hold = undefined;
}

function onTurn(e: Extract<CallEvent, { type: 'turn' }>) {
  const L = live!;
  const a = e.analysis;
  let s = L.screens.get(e.turn);
  if (!s) {
    L.screenCount += 1;
    const opts = h('div', { class: 'opts' });
    const did = h('div', { class: 'did' });
    const el = h('li', { class: `scr${e.known ? ' known' : ''}${a.kind === 'human' ? ' human' : ''}` }, h('span', { class: 'n' }, String(L.screenCount)));
    s = { el, opts, did, options: a.options };
    L.screens.set(e.turn, s);
    $('screens').append(el);
  }
  const tag =
    a.kind === 'hold' ? h('span', { class: 'tag hold' }, 'hold queue')
    : a.kind === 'human' ? h('span', { class: 'tag human' }, 'live person')
    : e.known ? h('span', { class: 'tag known' }, 'known')
    : h('span', { class: 'tag new' }, 'new');
  s.options = a.options;
  s.opts.replaceChildren(...a.options.slice(0, 6).map((o) => h('span', { class: 'opt', 'data-k': o.via === 'dtmf' ? o.key : o.label.toLowerCase() }, o.via === 'dtmf' ? `${o.key} · ${o.label}` : `“${o.label}”`)));
  fill(
    s.el,
    h('span', { class: 'n' }, s.el.querySelector('.n')?.textContent ?? ''),
    h('div', { class: 'h' }, h('span', { class: 'title' }, a.kind === 'human' && L.rep ? `${L.rep} (live person)` : a.title), tag),
    h('div', { class: 'sample' }, L.firstLine.get(e.turn) ?? ''),
    a.options.length ? s.opts : null,
    s.did,
  );
  s.el.scrollIntoView({ block: 'nearest' });
}

function onAction(e: Extract<CallEvent, { type: 'action' }>) {
  const L = live!;
  const a = e.action;
  const badge = e.source === 'map' ? h('span', { class: 'badge map' }, 'from map') : e.source === 'llm' ? h('span', { class: 'badge llm' }, 'Claude') : e.source === 'guard' ? h('span', { class: 'badge guard' }, 'guard') : null;
  const s = L.screens.get(e.turn);
  if (a.type === 'wait') {
    if (e.reason !== L.lastWait && !/^Listening/.test(e.reason)) line(e.t, 'wait', null, `· ${e.reason}`, 'wait');
    L.lastWait = e.reason;
    return;
  }
  L.lastWait = undefined;
  L.lastWho = 'Voiced';
  if (a.type === 'press') {
    const redacted = /[^0-9*#w]/.test(e.display);
    const keys = redacted
      ? h('span', { class: 'vault' }, svg(LOCK), e.display)
      : h('span', { class: 'keys' }, ...e.display.split('').map((k) => h('span', { class: 'kc' }, k)));
    line(e.t, 'act', 'Voiced', h('div', { class: 'act' }, keys, h('span', { class: 'reason' }, e.reason), badge));
    animateKeys(e.display, redacted);
    if (s) {
      s.el.querySelectorAll('.opt').forEach((o) => o.classList.toggle('on', o.getAttribute('data-k') === e.display));
      s.did.textContent = `${redacted ? 'Entered from vault' : `Pressed ${e.display}`}${e.source === 'map' ? ' · replayed from map' : ''}`;
      if (e.source === 'map') s.el.classList.add('known');
    }
  } else if (a.type === 'say') {
    line(e.t, 'act', 'Voiced', h('div', { class: 'act' }, h('span', { class: 'said' }, `“${e.display}”`), h('span', { class: 'reason' }, e.reason), badge));
    if (sound && speed <= 1) speak(e.display, 'agent');
    if (s) {
      s.el.querySelectorAll('.opt').forEach((o) => o.classList.toggle('on', o.getAttribute('data-k') === e.display.toLowerCase()));
      s.did.textContent = `Said “${e.display}”${e.source === 'map' ? ' · replayed from map' : ''}`;
      if (e.source === 'map') s.el.classList.add('known');
    }
  } else if (a.type === 'ask_user') {
    line(e.t, 'act', 'Voiced', h('div', { class: 'act' }, h('span', {}, `Asked you: ${a.request.title}`), badge));
    if (s) s.did.textContent = 'Asked you';
  } else if (a.type === 'hangup') {
    line(e.t, 'act', 'Voiced', h('div', { class: 'act' }, h('span', {}, 'Hung up'), h('span', { class: 'reason' }, e.reason)));
  } else if (a.type === 'handoff') {
    if (s) s.did.textContent = 'Handed off to you';
  }
}

function animateKeys(display: string, redacted: boolean) {
  const keys = redacted
    ? Array.from({ length: Math.min(12, Math.max(4, display.replace(/[^•\d]/g, '').length)) }, () => '0123456789'[Math.floor(Math.random() * 10)])
    : display.split('').filter((k) => DTMF[k]);
  if (display.endsWith('#') && redacted) keys.push('#');
  const gap = Math.max(45, 140 / Math.sqrt(speed));
  keys.forEach((k, i) =>
    setTimeout(() => {
      const el = $('keypad').querySelector(`[data-key="${CSS.escape(k)}"]`);
      el?.classList.add('hit');
      setTimeout(() => el?.classList.remove('hit'), gap * 0.8);
      if (sound) tone(k, Math.min(110, gap * 0.8));
    }, i * gap),
  );
  const pair = !redacted && display.length === 1 ? DTMF[display] : undefined;
  const readout = $('tones');
  readout.replaceChildren('Sent ', h('b', {}, display), pair ? ` · ${pair[0]} + ${pair[1]} Hz` : redacted ? ' · from the vault, never shown to the model' : ` · ${keys.length} tones`);
}

function onRequest(id: string, r: UserRequest) {
  const L = live!;
  const title = r.title;
  const detail = r.detail;
  const build = () => {
    const card = h('div', { class: 'row' });
    if (r.kind === 'choose') {
      for (const o of r.options) {
        const b = h('button', { type: 'button', class: 'primary' }, o);
        b.addEventListener('click', () => answer(id, true, o));
        card.append(b);
      }
    } else {
      const yes = h('button', { type: 'button', class: 'primary' }, r.kind === 'approve_payment' ? `Approve ${money(r.amount + r.fee)}` : 'Approve');
      const no = h('button', { type: 'button', class: 'decline' }, 'Decline');
      yes.addEventListener('click', () => answer(id, true));
      no.addEventListener('click', () => answer(id, false));
      card.append(yes, no);
    }
    return card;
  };
  const push = $('push');
  push.replaceChildren(h('h4', {}, title), h('p', {}, detail), build());
  push.hidden = false;
  const chatCard = chatAdd(h('div', { class: 'ask' }, h('h4', {}, title), h('p', {}, detail), build()));
  L.pending.set(id, [push, chatCard]);
  toolcall('get_call', { call_id: 'call_…', wait_seconds: 30 });
}

function answer(id: string, approved: boolean, choice?: string) {
  const L = live;
  if (!L) return;
  L.taps += 1;
  setTaps();
  L.handle.respond(id, { approved, choice });
  toolcall('respond_to_call', { request_id: '…', approved, ...(choice ? { choice } : {}) });
  settle(id, approved ? 'You approved.' : 'You declined.');
}

function settle(id: string, text: string) {
  const els = live?.pending.get(id);
  if (!els) return;
  live!.pending.delete(id);
  const [push, card] = els;
  push.hidden = true;
  card.querySelector('.row')?.replaceWith(h('p', { class: 'done' }, text));
}

function talk(text: string) {
  const L = live;
  if (!L || L.ended) return;
  L.taps += 1;
  setTaps();
  L.handle.say(text);
  const replies = $('replies');
  for (const b of replies.querySelectorAll('button')) if (b.textContent === text) b.remove();
  if (!replies.children.length) replies.hidden = true;
}

function finish(r: CallResult) {
  const L = live!;
  L.ended = true;
  endHold(r.callMs);
  setStatus('ended');
  $('talk').hidden = true;
  $('replies').hidden = true;
  $('push').hidden = true;
  $<HTMLButtonElement>('hangup').disabled = true;
  const prev = lastRun.get(L.biz.id);
  lastRun.set(L.biz.id, r);
  const ok = r.outcome === 'success';
  const stat = (value: string, label: string, win = false) => h('div', { class: `stat${win ? ' win' : ''}` }, h('b', {}, value), h('span', {}, label));
  const saved = prev ? prev.callMs - r.callMs : 0;
  const again = h('button', { type: 'button', class: 'primary' }, ok ? 'Call again with the map' : 'Try again');
  again.addEventListener('click', () => void start(L.biz, L.opts));
  const back = h('button', { type: 'button', class: 'secondary' }, 'Choose another call');
  back.addEventListener('click', idle);
  const box = $('result');
  box.className = `result${ok ? '' : ' fail'}`;
  fill(
    box,
    h('h3', {}, h('span', { class: 'dot' }), ok ? 'Done' : 'Stopped'),
    h('p', {}, r.summary),
    prev && saved > 0
      ? h('p', { class: 'compare' }, 'Last call ', h('b', {}, formatDuration(prev.callMs)), ' → this call ', h('b', {}, formatDuration(r.callMs)), `. The map replayed ${r.mapHits} screens${r.llmCalls === 0 && prev.llmCalls > 0 ? '' : ''}, so Voiced skipped the listening.`)
      : null,
    h(
      'div',
      { class: 'stats' },
      stat(formatDuration(r.callMs), 'on the phone for you'),
      stat(`${L.taps} ${L.taps === 1 ? 'tap' : 'taps'}`, 'from you'),
      r.holdMs ? stat(formatDuration(r.holdMs), 'hold absorbed') : null,
      stat(String(r.mapHits), 'screens replayed', r.mapHits > 0),
      stat(String(r.llmCalls), 'model calls'),
    ),
    h('div', { class: 'row' }, again, back),
  );
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
  toolcall('get_call', { call_id: 'call_…' });
  bot(r.summary, ok ? 'Done.' : 'Stopped.');
  void refreshNetwork(L.biz);
}

function idle() {
  live = undefined;
  $('call-live').hidden = true;
  $('call-idle').hidden = false;
  $('map-sub').textContent = 'Screens appear as Voiced hears them';
}

function setStatus(status: string) {
  const pill = $('call-status');
  pill.dataset.state = status;
  pill.textContent = STATUS[status] ?? status;
}

function setTaps() {
  const n = live?.taps ?? 0;
  $('call-you').textContent = `call time · you: ${n} ${n === 1 ? 'tap' : 'taps'}`;
}

function line(t: number, kind: string, who: string | null, body: Node | string, extra?: string) {
  const li = h('li', { class: `line ${kind}${extra ? ` ${extra}` : ''}` }, h('span', { class: 't' }, clock(t)), h('div', { class: 'body' }, who ? h('span', { class: 'who-label' }, who) : null, body));
  const list = $('transcript');
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.append(li);
  if (stick) list.scrollTop = list.scrollHeight;
  return li;
}

function svg(markup: string) {
  const span = h('span');
  span.innerHTML = markup;
  return span.firstElementChild as Element as HTMLElement;
}

// --- Shared map panel --------------------------------------------------------------

async function refreshNetwork(fresh?: Business) {
  try {
    const [maps, stats] = await Promise.all([engine.maps(), engine.stats()]);
    $('kpi-rate').textContent = stats.completionRate === null ? '–' : `${Math.round(stats.completionRate * 100)}%`;
    $('kpi-calls').textContent = String(stats.calls);
    $('kpi-hold').textContent = `${stats.holdMinutes}m`;
    $('net-rows').replaceChildren(
      ...businesses.map((b) => {
        const m = maps.find((x) => digits(x.phone) === digits(b.phone));
        const screens = m?.screens ?? 0;
        const isFresh = fresh?.id === b.id && live && screens > live.mapBefore;
        return h('tr', {}, h('td', {}, b.business), h('td', {}, isFresh ? h('span', { class: 'fresh' }, `${screens} (+${screens - live!.mapBefore})`) : String(screens)), h('td', {}, String(m?.calls ?? 0)));
      }),
    );
    if (fresh && live) {
      const now = maps.find((x) => digits(x.phone) === digits(fresh.phone))?.screens ?? 0;
      $('map-sub').textContent = `${fresh.business} · ${now} screens mapped`;
    }
  } catch {
    /* network panel is best-effort */
  }
}

const digits = (s: string) => s.replace(/\D/g, '');

// --- Optional Claude brain (published demo) and watch links (server) ------------------

async function enableClaude() {
  if (!(engine instanceof LocalEngine)) return;
  const local = engine;
  const use = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude?.use;
  if (!use) return;
  const sample = (await use('sample').catch(() => null)) as SampleFn | null;
  if (!sample) return;
  const seg = $('brain-seg');
  seg.hidden = false;
  for (const btn of seg.querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => {
      const claude = btn.dataset.brain === 'claude';
      local.setBrain(claude ? () => new SampleBrain(sample) : () => new RulesBrain(), claude ? 'Claude brain' : 'Rules brain');
      for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
      $('mode-chip').textContent = `Simulated phone trees · ${engine.brainLabel}`;
      if (claude) bot('Switched to Claude. I’ll ask Claude at each prompt (it uses your Claude account). Screens already on the map still skip the model.');
    });
  }
}

async function watchFromUrl() {
  if (!engine.attach) return;
  const q = new URLSearchParams(location.search);
  const id = q.get('call');
  const token = q.get('t');
  if (!id || !token) return;
  const res = await fetch(`/v1/calls/${id}?t=${encodeURIComponent(token)}`);
  if (!res.ok) return bot('That call link has expired.');
  const view = await res.json();
  const biz = businesses.find((b) => b.business === view.business) ?? hero;
  bot(`Watching your call to ${view.business}${q.get('approve') ? '. It needs your approval.' : '.'}`);
  const handle = await engine.attach(id, token);
  begin(biz, handle, { businessId: biz.id, speed }, 0);
}

boot();
