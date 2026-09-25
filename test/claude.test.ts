// The Claude brain's request shape and response handling, with a stubbed client.
// (Live model behavior needs ANTHROPIC_API_KEY: npm run eval -- --claude.)

import type Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainState } from '../src/brains/brain.js';
import { ClaudeBrain } from '../src/brains/claude.js';
import { renderContext, toDecision } from '../src/brains/prompt.js';
import { analyzeTurn } from '../src/core/parse.js';
import { bedford } from '../src/sim/scenarios/bedford.js';

function state(turn: string[]): BrainState {
  const { task } = bedford.task();
  return {
    task,
    turn,
    speaker: 'ivr',
    analysis: analyzeTurn(turn.join(' '), 'ivr'),
    history: turn.map((text) => ({ who: 'ivr' as const, text })),
    notes: {},
    grants: [],
    counters: { silences: 1, escalations: 0, humanTurns: 0, invalids: 0 },
    entered: {},
  };
}

function fakeClient(content: unknown[], stop_reason = 'tool_use') {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { content, stop_reason, stop_details: null };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

test('sends one cached, single-tool, fallback-enabled request and maps the tool call', async () => {
  const { client, calls } = fakeClient([{ type: 'tool_use', id: 't1', name: 'press_keys', input: { digits: '{{card.number}} #', reason: 'Card from the vault' } }]);
  const brain = new ClaudeBrain({ client, model: 'claude-opus-5' });
  const s = state(['Please enter your credit or debit card number, followed by the pound key.']);
  const d = await brain.decide(s);
  assert.deepEqual(d.action, { type: 'press', digits: '{{card.number}}#' });
  assert.equal(d.source, 'llm');
  assert.equal(d.cacheable, true);

  const req = calls[0];
  assert.equal(req.model, 'claude-opus-5');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.deepEqual((req.system as { cache_control: unknown }[])[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual((req.tools as { name: string }[]).map((t) => t.name), ['press_keys', 'say', 'wait', 'ask_user', 'escalate_to_operator', 'handoff_to_user', 'end_call']);
});

test('the model context never contains secret values', () => {
  const { secrets } = bedford.task();
  const ctx = renderContext(state(['Please enter your credit or debit card number, followed by the pound key.']));
  for (const v of Object.values(secrets)) assert.ok(!ctx.includes(v));
  assert.match(ctx, /card\.number: Card number = SECRET, use \{\{card\.number\}\}/);
});

test('refusals and tool-less answers throw so the session falls back to rules', async () => {
  const s = state(['For billing, press 2.']);
  await assert.rejects(new ClaudeBrain({ client: fakeClient([], 'refusal').client }).decide(s), /refused/);
  await assert.rejects(new ClaudeBrain({ client: fakeClient([{ type: 'text', text: 'I would press 2' }], 'end_turn').client }).decide(s), /without a tool call/);
  await assert.rejects(
    new ClaudeBrain({ client: fakeClient([{ type: 'tool_use', id: 't', name: 'press_keys', input: { reason: 'no digits' } }]).client }).decide(s),
    /missing digits/,
  );
});

test('payment approvals carry amount and fee', async () => {
  const { client } = fakeClient([
    { type: 'tool_use', id: 't', name: 'ask_user', input: { kind: 'approve_payment', title: 'Approve fee?', detail: '$2.95 fee', amount: 142.17, fee: 2.95, reason: 'Fee not approved' } },
  ]);
  const d = await new ClaudeBrain({ client }).decide(state(['To authorize this payment, press 1.']));
  assert.equal(d.action.type, 'ask_user');
  if (d.action.type === 'ask_user' && d.action.request.kind === 'approve_payment') {
    assert.equal(d.action.request.fee, 2.95);
    assert.equal(d.action.request.cardLabel, 'Visa •• 4242');
  } else assert.fail('expected approve_payment');
});

test('input requests for a standard fact use its key, so the answer lands where the vault and the map expect it', () => {
  const ask = (fact_label: string, turn: string) =>
    toDecision('ask_user', { kind: 'input', title: 'Identity check', detail: 'They want it', fact_label, reason: 'Not on file' }, state([turn])).action;
  const ssn = ask('last 4 of SSN', 'Please enter the last four digits of the Social Security number on the account.');
  assert.ok(ssn.type === 'ask_user' && ssn.request.kind === 'input');
  if (ssn.type === 'ask_user' && ssn.request.kind === 'input') {
    assert.equal(ssn.request.factKey, 'ssn4');
    assert.equal(ssn.request.factLabel, 'Last 4 of SSN');
  }
  // The IVR's wording decides when the label is the model's own phrasing.
  const dob = ask('verification', 'Please say or enter your date of birth.');
  assert.ok(dob.type === 'ask_user' && dob.request.kind === 'input' && dob.request.factKey === 'dob');
  // Whole words only ("shipping" is not "pin"), and unknown asks keep a private key.
  const other = ask('shipping reference', 'Enter the shipping reference from your receipt.');
  assert.ok(other.type === 'ask_user' && other.request.kind === 'input' && other.request.factKey === 'asked.shipping_reference');
});
