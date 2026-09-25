// The Claude Code brain (`claude -p` on the local Claude login), with a stubbed CLI runner.
// (Live: npm run sim bedford -- --claude-code, with Claude Code installed and logged in.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrainState } from '../src/brains/brain.js';
import { ClaudeCodeBrain, type RunCli } from '../src/brains/claude-code.js';
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

const envelope = (result: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'result', is_error: false, result, ...extra });

function stub(reply: string | Error) {
  const calls: { bin: string; args: string[]; input: string }[] = [];
  const run: RunCli = async (bin, args, input) => {
    calls.push({ bin, args, input });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls };
}

const quiet = async (fn: () => Promise<unknown>) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
};

test('runs claude -p with no tools, MCP or settings, and parses the JSON action (fenced or not)', async () => {
  for (const text of ['{"tool": "press_keys", "digits": "2", "reason": "Billing is 2"}', '```json\n{"tool": "press_keys", "digits": "2", "reason": "Billing is 2"}\n```']) {
    const { run, calls } = stub(envelope(text));
    const d = await new ClaudeCodeBrain({ run }).decide(state(['For billing and payments, press 2.']));
    assert.deepEqual(d.action, { type: 'press', digits: '2' });
    assert.equal(d.source, 'llm');
    const { bin, args, input } = calls[0];
    assert.equal(bin, 'claude');
    assert.equal(args[0], '-p');
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
    for (const f of ['--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(f), f);
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.match(args[args.indexOf('--system-prompt') + 1], /You are Voiced/);
    assert.match(input, /Reply with ONLY one JSON object/);
    assert.ok(!input.includes('4242424242424242'), 'the vault holds the card: the CLI sees placeholders only');
  }
});

test('CLI errors, error results and answers without an action throw (the session falls back to rules)', async () => {
  const cases: [string | Error, RegExp][] = [
    [new Error('claude not found: install Claude Code'), /not found/],
    ['Not logged in', /something other than JSON/],
    [envelope('Invalid API key · Please run /login', { is_error: true }), /claude -p failed: Invalid API key/],
    [envelope('I would press 2.'), /without a JSON action/],
    [envelope('{"tool": "press_keys", "reason": "no digits"}'), /missing digits/],
  ];
  await quiet(async () => {
    for (const [reply, err] of cases) await assert.rejects(new ClaudeCodeBrain({ run: stub(reply).run }).decide(state(['Press 1.'])), err);
  });
});

test('brain selection: claude-code only when asked for', () => {
  assert.equal(brainKind({}, ['--claude-code']), 'claude-code');
  assert.equal(brainKind({ VOICED_BRAIN: 'claude-code' }), 'claude-code');
  assert.equal(brainKind({ GEMINI_API_KEY: 'x' }), 'gemini');
});
