// The eval harness: replays every simulated phone tree (the demo trees plus the
// hard cases: loops, dead ends, identity checks, closures, changed menus) and
// scores the outcome of each call against what a correct agent should do.
//
// Top-line metric: share of calls resolved by AI with no human.
//
//   npm run eval                 # rules brain
//   npm run eval -- --gemini     # Gemini brain (needs GEMINI_API_KEY; free tier works, slowly)
//   npm run eval -- --claude     # Claude brain (needs ANTHROPIC_API_KEY; costs tokens)
//   npm run eval -- --json       # machine-readable

import '../src/env.js';
import { brainKind, makeBrain } from '../src/brains/select.js';
import { MapMemory } from '../src/core/memory.js';
import { OperatorQueue } from '../src/core/operators.js';
import { formatDuration } from '../src/core/session.js';
import type { CallResult, Resolution } from '../src/core/types.js';
import { attachScriptedOperator } from '../src/sim/operator.js';
import { simulate } from '../src/sim/run.js';
import { allScenarios, getScenario } from '../src/sim/scenarios/index.js';

const args = process.argv.slice(2);
const kind = brainKind({}, args);
// One shared model brain; free-tier rate limits are waited out rather than handed to rules.
const modelBrain = kind === 'rules' ? undefined : makeBrain(kind, { maxRetryWaitMs: 60_000 });
/** Model turns that failed and went to rules instead. A model eval with many of these is really a rules eval. */
let fallbacks = 0;

async function run(id: string, memory: MapMemory): Promise<CallResult> {
  const operators = new OperatorQueue();
  attachScriptedOperator(operators);
  const { session } = simulate(id, { memory, brain: modelBrain, operators });
  const inputs = getScenario(id)?.userInputs ?? {};
  let replies = 0;
  session.subscribe((e) => {
    if (e.type === 'action' && e.reason.includes('rules took over')) fallbacks += 1;
    if (e.type === 'user_request') {
      const r = e.request;
      const text = r.kind === 'input' ? inputs[r.factKey ?? ''] : undefined;
      queueMicrotask(() => session.respond(e.id, { approved: r.kind === 'input' ? !!text : true, text, choice: r.kind === 'choose' ? r.options[0] : undefined }));
    }
    if (e.type === 'bridge' && e.from === 'human' && e.text.trim().endsWith('?')) {
      const next = ['Yes, the $49.99 charge. I never signed up for it.', 'That’s all, thanks.'][replies++];
      if (next) setTimeout(() => void session.userSays(next), 0);
    }
  });
  return session.run();
}

interface Row {
  scenario: string;
  mode: 'cold' | 'warm';
  expected: Resolution;
  expectedReason?: string;
  got: CallResult;
  pass: boolean;
}

const rows: Row[] = [];
for (const s of allScenarios) {
  const memory = new MapMemory();
  if (s.warmWith) await run(s.warmWith, memory);
  const cold = await run(s.id, memory);
  const reasonOk = !s.expect.reason || cold.failure?.reason === s.expect.reason;
  rows.push({ scenario: s.id, mode: s.warmWith ? 'warm' : 'cold', expected: s.expect.resolution, expectedReason: s.expect.reason, got: cold, pass: cold.resolution === s.expect.resolution && reasonOk });
  // Every tree gets a second call on the same map: exceptions a person fixed should now be handled by the AI.
  const warm = await run(s.id, memory);
  const expectedWarm = s.expect.warm ?? s.expect.resolution;
  rows.push({ scenario: s.id, mode: 'warm', expected: expectedWarm, expectedReason: expectedWarm === 'failed' ? s.expect.reason : undefined, got: warm, pass: warm.resolution === expectedWarm && (expectedWarm !== 'failed' || !s.expect.reason || warm.failure?.reason === s.expect.reason) });
}

const count = (r: Resolution) => rows.filter((x) => x.got.resolution === r).length;
const pct = (n: number) => `${((n / rows.length) * 100).toFixed(0)}%`;
const summary = {
  calls: rows.length,
  resolved_by_ai: count('ai'),
  resolved_with_human: count('human_assisted'),
  failed: count('failed'),
  ai_resolution_rate: count('ai') / rows.length,
  completion_rate: (count('ai') + count('human_assisted')) / rows.length,
  outcome_matches_expected: rows.filter((r) => r.pass).length,
  brain: kind,
  model_turns_lost_to_rules: fallbacks,
};

if (args.includes('--json')) {
  console.log(JSON.stringify({ summary, rows: rows.map((r) => ({ ...r, got: { resolution: r.got.resolution, failure: r.got.failure, result: r.got.result, callMs: r.got.callMs, mapHits: r.got.mapHits, operatorTouches: r.got.operatorTouches, userTouches: r.got.userTouches } })) }, null, 2));
} else {
  const table = [['Phone tree', 'Map', 'Outcome', 'Expected', '', 'Reason · step', 'Call', 'Map hits', 'Operator']];
  for (const r of rows) {
    table.push([
      r.scenario,
      r.mode,
      r.got.resolution,
      r.expected + (r.expectedReason ? ` (${r.expectedReason})` : ''),
      r.pass ? '✓' : '✗',
      r.got.failure ? `${r.got.failure.reason} · ${r.got.failure.step}` : '',
      formatDuration(r.got.callMs),
      String(r.got.mapHits),
      String(r.got.operatorTouches),
    ]);
  }
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  for (const [i, row] of table.entries()) {
    console.log(row.map((cell, c) => cell.padEnd(widths[c])).join('  '));
    if (i === 0) console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  }
  console.log(
    `\nResolved by AI (no human): ${pct(summary.resolved_by_ai)} · with human help: ${pct(summary.resolved_with_human)} · failed: ${pct(summary.failed)}` +
      `\nOutcome matched the expected one on ${summary.outcome_matches_expected}/${rows.length} calls (${summary.brain} brain, simulated phone trees; operator is a scripted stand-in).` +
      (fallbacks ? `\n${fallbacks} model turns failed and were decided by rules instead.` : ''),
  );
}
if (rows.some((r) => !r.pass)) process.exitCode = 1;
