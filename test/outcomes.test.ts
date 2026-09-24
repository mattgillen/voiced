// AI-first with a human fallback: every call ends with an auditable outcome,
// stuck calls go to a person instead of failing, and what the person does
// becomes map data so the next call doesn't need them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MapMemory } from '../src/core/memory.js';
import { OperatorQueue, type EscalationTicket } from '../src/core/operators.js';
import type { CallEvent, CallResult } from '../src/core/types.js';
import { attachScriptedOperator } from '../src/sim/operator.js';
import { simulate, type SimulateOptions } from '../src/sim/run.js';
import { bedford } from '../src/sim/scenarios/bedford.js';
import { getScenario } from '../src/sim/scenarios/index.js';

async function play(id: string, opts: SimulateOptions & { inputs?: Record<string, string> } = {}) {
  const { session } = simulate(id, opts);
  const events: CallEvent[] = [];
  const inputs = opts.inputs ?? getScenario(id)?.userInputs ?? {};
  session.subscribe((e) => {
    events.push(e);
    if (e.type === 'user_request') {
      const r = e.request;
      const text = r.kind === 'input' ? inputs[r.factKey ?? ''] : undefined;
      queueMicrotask(() => session.respond(e.id, { approved: r.kind === 'input' ? !!text : true, text }));
    }
  });
  const result: CallResult = await session.run();
  return { result, events };
}

function desk() {
  const queue = new OperatorQueue();
  const tickets: EscalationTicket[] = [];
  queue.onOpen((t) => tickets.push(structuredClone(t)));
  attachScriptedOperator(queue);
  return { queue, tickets };
}

test('a paid bill records an auditable, billable result', async () => {
  const { result } = await play('bedford');
  assert.equal(result.resolution, 'ai');
  assert.equal(result.result?.kind, 'bill_paid');
  assert.equal(result.result?.amount, '$145.12');
  assert.equal(result.result?.confirmation, '4820177');
  assert.match(result.result?.evidence?.text ?? '', /confirmation number is 4 8 2 0 1 7 7/);
  assert.equal(result.failure, undefined);
});

test('a looping tree escalates to an operator, and the fix is learned for next time', async () => {
  const memory = new MapMemory();
  const { queue, tickets } = desk();
  const first = await play('irontemple-loop', { memory, operators: queue });
  assert.equal(first.result.resolution, 'human_assisted');
  assert.equal(first.result.failure?.reason, 'loop', 'the exception is kept as training data');
  assert.equal(first.result.escalations, 1);
  assert.ok(first.result.operatorTouches >= 1);
  assert.equal(tickets.length, 1);
  assert.equal(queue.list()[0].status, 'returned');

  const second = await play('irontemple-loop', { memory, operators: queue });
  assert.equal(second.result.resolution, 'ai', 'the map learned what the operator did');
  assert.equal(second.result.operatorTouches, 0);
  assert.equal(tickets.length, 1, 'no new escalation');
});

test('without an operator desk, a stuck call still ends with a reason, never silently', async () => {
  const { result, events } = await play('irontemple-loop');
  assert.equal(result.resolution, 'failed');
  assert.equal(result.failure?.reason, 'loop');
  assert.ok(result.failure?.step);
  assert.ok(events.some((e) => e.type === 'action' && e.action.type === 'escalate'), 'it tried to escalate');
  assert.ok(!events.some((e) => e.type === 'escalated'), 'no queue, so nothing claims a person took it');
});

test('operators get full context but never secrets', async () => {
  const { queue, tickets } = desk();
  await play('irontemple-loop', { operators: queue });
  const ticket = tickets[0];
  assert.equal(ticket.reason, 'loop');
  assert.ok(ticket.transcript.length > 5);
  const v = await play('bedford-verify', { operators: queue });
  assert.equal(v.result.resolution, 'ai');
  const { secrets } = bedford.task();
  const blob = JSON.stringify([tickets, queue.list(), v.events]);
  for (const s of [...Object.values(secrets), '6789']) assert.ok(!blob.includes(s), `secret ${s.slice(0, 2)}… leaked`);
});

test('an identity check the task can’t answer is asked of the user and keyed from the vault', async () => {
  const { result, events } = await play('bedford-verify');
  const ask = events.find((e) => e.type === 'user_request' && e.request.kind === 'input');
  assert.ok(ask && ask.type === 'user_request' && ask.request.kind === 'input' && ask.request.factKey === 'ssn4' && ask.request.secret);
  assert.equal(result.resolution, 'ai');
  const secretPresses = events.filter((e) => e.type === 'action' && e.action.type === 'press' && /\{\{(?:card\.number|card\.exp|card\.cvv|account|ssn4|pin)\}\}/.test(e.action.digits)).length;
  const pauses = events.filter((e) => e.type === 'recording' && e.paused).length;
  assert.equal(pauses, secretPresses, 'recording pauses for every vault entry');
});

test('if the user can’t pass the identity check, it escalates as identity_check', async () => {
  const { result } = await play('bedford-verify', { inputs: {} });
  assert.equal(result.resolution, 'failed');
  assert.equal(result.failure?.reason, 'identity_check');
});

test('closures fail honestly with the reason and the step where it broke', async () => {
  const down = await play('bedford-down');
  assert.equal(down.result.resolution, 'failed');
  assert.equal(down.result.failure?.reason, 'business_unavailable');
  assert.equal(down.result.failure?.step, 'Billing and payments menu');
  const closed = await play('kestrel-closed');
  assert.equal(closed.result.failure?.reason, 'business_unavailable');
});
