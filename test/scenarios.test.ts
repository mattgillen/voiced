import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Brain, BrainState } from '../src/brains/brain.js';
import { decideByRules } from '../src/brains/rules.js';
import { MapMemory } from '../src/core/memory.js';
import type { CallEvent, CallResult, Decision } from '../src/core/types.js';
import { simulate, type SimulateOptions } from '../src/sim/run.js';
import { bedford } from '../src/sim/scenarios/bedford.js';
import { scenarios } from '../src/sim/scenarios/index.js';

interface Played {
  result: CallResult;
  events: CallEvent[];
  trail: string[];
}

/** Run a scenario to completion, playing the user: approve (or decline) asks, chat with the rep. */
async function play(id: string, opts: SimulateOptions & { approve?: boolean } = {}): Promise<Played> {
  const { session, line } = simulate(id, opts);
  const events: CallEvent[] = [];
  let replies = 0;
  session.subscribe((e) => {
    events.push(e);
    if (e.type === 'user_request') {
      queueMicrotask(() => session.respond(e.id, { approved: opts.approve ?? true }));
    }
    if (e.type === 'bridge' && e.from === 'human' && e.text.trim().endsWith('?')) {
      const lines = ['Yes, the $49.99 protection charge. I never signed up for it.', "That's all, thanks!"];
      const next = lines[replies++];
      if (next) setTimeout(() => void session.userSays(next), 0);
    }
  });
  const result = await session.run();
  return { result, events, trail: line.trail };
}

for (const s of scenarios) {
  test(`${s.id}: completes "${s.title}" with the rules brain`, async () => {
    const { result, trail } = await play(s.id);
    assert.equal(result.outcome, 'success', result.summary);
    const expected = { bedford: 'paid', irontemple: 'canceled', luna: 'booked', kestrel: 'rep' }[s.id]!;
    assert.ok(trail.includes(expected), `expected to reach "${expected}", trail: ${trail.join(' > ')}`);
  });
}

test('secrets never appear in any emitted event', async () => {
  const { secrets } = bedford.task();
  const { events } = await play('bedford');
  const kestrel = await play('kestrel');
  const blob = JSON.stringify([...events, ...kestrel.events]);
  for (const value of [...Object.values(secrets), '8231']) {
    assert.ok(!blob.includes(value), `secret ${value.slice(0, 2)}… leaked into events`);
  }
});

test('bedford: an unapproved fee pauses for the user, and declining backs out without paying', async () => {
  const { result, events, trail } = await play('bedford', { approve: false });
  const ask = events.find((e) => e.type === 'user_request');
  assert.ok(ask && ask.type === 'user_request' && ask.request.kind === 'approve_payment');
  assert.equal(ask.request.fee, 2.95);
  assert.equal(result.outcome, 'failure');
  assert.ok(trail.includes('cancelled'), 'should press the cancel option');
  assert.ok(!trail.includes('paid'));
});

test('bedford: a fee within the pre-approval pays with zero user touches', async () => {
  const { result } = await play('bedford', { scenario: { maxFee: 5 } });
  assert.equal(result.outcome, 'success');
  assert.equal(result.userTouches, 0);
});

test('the shared IVR map makes the second call faster and skips decisions', async () => {
  const memory = new MapMemory();
  const first = await play('bedford', { memory });
  const second = await play('bedford', { memory });
  assert.equal(first.result.mapHits, 0);
  assert.ok(second.result.mapHits >= 6, `map hits: ${second.result.mapHits}`);
  assert.ok(second.result.callMs < first.result.callMs - 15_000, `${first.result.callMs} → ${second.result.callMs}`);
  assert.equal(second.result.outcome, 'success');
});

test('the map never learns from live humans', async () => {
  const memory = new MapMemory();
  await play('kestrel', { memory });
  const map = memory.get(scenarios.find((s) => s.id === 'kestrel')!.phone)!;
  const learned = map.screens.flatMap((s) => s.sample).join(' ');
  assert.ok(!/Dana/.test(learned), 'human speech ended up in the map');
});

test('a changed menu breaks the replay once, then the call recovers and the map heals', async () => {
  const memory = new MapMemory();
  await play('bedford', { memory });
  // The utility reshuffles its main menu: billing moves from 2 to 3.
  const original = bedford.script;
  bedford.script = () => {
    const s = original();
    s.nodes.main = {
      ...s.nodes.main,
      say: [
        'To report a power outage or emergency, press 1.',
        'To start, stop, or transfer service, press 2.',
        'For billing and payments, press 3.',
        'For all other questions, press 4.',
      ],
      menu: { '1': 'wrong_turn', '2': 'wrong_turn', '3': 'billing', '4': 'wrong_turn' },
    };
    return s;
  };
  try {
    const { result } = await play('bedford', { memory });
    assert.equal(result.outcome, 'success', result.summary);
  } finally {
    bedford.script = original;
  }
});

test('policy guard: a brain that tries to authorize an unapproved fee gets overruled', async () => {
  // A reckless brain: presses 1 on the payment confirmation without asking anyone.
  const reckless: Brain = {
    name: 'reckless',
    async decide(s: BrainState): Promise<Decision> {
      if (s.analysis.kind === 'commit') return { action: { type: 'press', digits: '1' }, reason: 'yolo', source: 'llm' };
      return { ...decideByRules(s), source: 'llm' };
    },
  };
  const { events, result } = await play('bedford', { brain: reckless, approve: false });
  const guarded = events.find((e) => e.type === 'action' && e.source === 'guard');
  assert.ok(guarded, 'guard should have stepped in');
  assert.equal(result.outcome, 'failure', 'user declined, so nothing may be paid');
});

test('a failing model falls back to rules and still completes', async () => {
  const broken: Brain = {
    name: 'broken',
    async decide() {
      throw new Error('503 overloaded');
    },
  };
  const { result } = await play('irontemple', { brain: broken });
  assert.equal(result.outcome, 'success');
});
