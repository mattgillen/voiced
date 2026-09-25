// The Gemini brain's request shape and response handling, with a stubbed fetch.
// (Live model behavior needs GEMINI_API_KEY: npm run eval -- --gemini.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainState } from '../src/brains/brain.js';
import { GeminiBrain } from '../src/brains/gemini.js';
import { brainKind } from '../src/brains/select.js';
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

function fakeFetch(replies: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const toolReply = (name: string, args: Record<string, unknown>) => ({
  status: 200,
  body: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] },
});

test('sends the shared prompt and seven tools, forces one function call, and parses it', async () => {
  const { fetch, calls } = fakeFetch([toolReply('press_keys', { digits: '2', reason: 'Billing is option 2' })]);
  const brain = new GeminiBrain({ apiKey: 'test-key', model: 'gemini-test', fetch });
  const d = await brain.decide(state(['For billing and payments, press 2. For outages, press 3.']));
  assert.deepEqual(d.action, { type: 'press', digits: '2' });
  assert.equal(d.source, 'llm');

  const { url, init } = calls[0];
  assert.match(url, /\/v1beta\/models\/gemini-test:generateContent$/);
  assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], 'test-key');
  assert.ok(!url.includes('test-key'), 'key goes in a header, not the URL (URLs end up in logs)');
  const body = JSON.parse(String(init.body));
  assert.deepEqual(
    body.tools[0].functionDeclarations.map((f: { name: string }) => f.name),
    ['press_keys', 'say', 'wait', 'ask_user', 'escalate_to_operator', 'handoff_to_user', 'end_call'],
  );
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.match(body.systemInstruction.parts[0].text, /You are Voiced/);
  // The vault holds the card: the model sees placeholders and redactions only.
  assert.ok(!JSON.stringify(body).includes('4242424242424242'));
});

test('thinking setting maps to thinkingBudget or thinkingLevel', async () => {
  for (const [thinking, expected] of [['0', { thinkingBudget: 0 }], ['low', { thinkingLevel: 'low' }]] as const) {
    const { fetch, calls } = fakeFetch([toolReply('wait', { reason: 'listening' })]);
    await new GeminiBrain({ apiKey: 'k', fetch, thinking }).decide(state(['Please hold.']));
    assert.deepEqual(JSON.parse(String(calls[0].init.body)).generationConfig.thinkingConfig, expected);
  }
});

test('rate limits: waits out a short retryDelay when allowed, otherwise throws so rules take the turn', async () => {
  const limited = {
    status: 429,
    body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }] } },
  };
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);

  const patient = fakeFetch([limited, toolReply('wait', { reason: 'hold music' })]);
  const d = await new GeminiBrain({ apiKey: 'k', fetch: patient.fetch, sleep, maxRetryWaitMs: 5000 }).decide(state(['Please hold.']));
  assert.equal(d.action.type, 'wait');
  assert.deepEqual(slept, [2000]);

  const live = fakeFetch([limited]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(new GeminiBrain({ apiKey: 'k', fetch: live.fetch, sleep }).decide(state(['Please hold.'])), /rate limited/);
  } finally {
    console.warn = warn;
  }
  assert.equal(live.calls.length, 1);
});

test('errors, blocks and non-tool answers throw (the session falls back to rules)', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const cases: [{ status: number; body: unknown }, RegExp][] = [
      [{ status: 400, body: { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } } }, /400.*API key not valid/],
      [{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }, /blocked/],
      [{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'I would press 2' }] }, finishReason: 'STOP' }] } }, /without a tool call/],
      [toolReply('press_keys', { reason: 'no digits' }), /missing digits/],
    ];
    for (const [reply, err] of cases) {
      await assert.rejects(new GeminiBrain({ apiKey: 'k', fetch: fakeFetch([reply]).fetch }).decide(state(['Press 1.'])), err);
    }
  } finally {
    console.warn = warn;
  }
});

test('brain selection: flags, then VOICED_BRAIN, then whichever key is present', () => {
  assert.equal(brainKind({}), 'rules');
  assert.equal(brainKind({ GEMINI_API_KEY: 'x' }), 'gemini');
  assert.equal(brainKind({ GOOGLE_API_KEY: 'x' }), 'gemini');
  assert.equal(brainKind({ GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }), 'claude');
  assert.equal(brainKind({ GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', VOICED_BRAIN: 'gemini' }), 'gemini');
  assert.equal(brainKind({ GEMINI_API_KEY: 'x', VOICED_BRAIN: 'rules' }), 'rules');
  assert.equal(brainKind({ GEMINI_API_KEY: 'x' }, ['--rules']), 'rules');
  // Scripts pass only their flags, so a key in the environment never turns a free eval into a paid one.
  assert.equal(brainKind({}, ['--gemini']), 'gemini');
});
