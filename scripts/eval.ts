// Completion-rate eval: the headline metric. Runs every simulated phone tree
// several times, first cold (empty map) and then warm (shared map), and reports
// completion rate, call time, map hits and model calls per tree.
//
//   npm run eval                 # rules brain
//   npm run eval -- --claude     # Claude brain (needs ANTHROPIC_API_KEY; costs tokens)
//   npm run eval -- --runs 10

import type { Brain } from '../src/brains/brain.js';
import { ClaudeBrain } from '../src/brains/claude.js';
import { MapMemory } from '../src/core/memory.js';
import { formatDuration } from '../src/core/session.js';
import type { CallResult } from '../src/core/types.js';
import { simulate } from '../src/sim/run.js';
import { scenarios } from '../src/sim/scenarios/index.js';

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 3;
const brain = (): Brain | undefined => (args.includes('--claude') ? new ClaudeBrain() : undefined);

async function run(id: string, memory: MapMemory): Promise<CallResult> {
  const { session } = simulate(id, { memory, brain: brain() });
  let replies = 0;
  session.subscribe((e) => {
    if (e.type === 'user_request') queueMicrotask(() => session.respond(e.id, { approved: true, choice: e.request.kind === 'choose' ? e.request.options[0] : undefined }));
    if (e.type === 'bridge' && e.from === 'human' && e.text.trim().endsWith('?')) {
      const next = ['Yes, the $49.99 charge. I never signed up for it.', 'That’s all, thanks.'][replies++];
      if (next) setTimeout(() => void session.userSays(next), 0);
    }
  });
  return session.run();
}

const rows: string[][] = [['Phone tree', 'Mode', 'Completed', 'Avg call', 'Map hits/call', 'Model calls/call']];
let total = 0;
let done = 0;
for (const s of scenarios) {
  const memory = new MapMemory();
  for (const mode of ['cold', 'warm'] as const) {
    const results: CallResult[] = [];
    for (let i = 0; i < runs; i++) {
      // Cold runs each start from an empty map; warm runs share the map the first cold call built.
      const m = mode === 'cold' ? (i === 0 ? memory : new MapMemory()) : memory;
      results.push(await run(s.id, m));
    }
    const ok = results.filter((r) => r.outcome === 'success').length;
    total += results.length;
    done += ok;
    const avg = (f: (r: CallResult) => number) => results.reduce((a, r) => a + f(r), 0) / results.length;
    rows.push([
      s.business,
      mode,
      `${ok}/${results.length}`,
      formatDuration(avg((r) => r.callMs)),
      avg((r) => r.mapHits).toFixed(1),
      avg((r) => r.llmCalls).toFixed(1),
    ]);
  }
}

const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
for (const [i, r] of rows.entries()) {
  console.log(r.map((cell, c) => cell.padEnd(widths[c])).join('  '));
  if (i === 0) console.log(widths.map((w) => '─'.repeat(w)).join('  '));
}
console.log(`\nCompletion rate: ${((done / total) * 100).toFixed(1)}% (${done}/${total} calls, ${args.includes('--claude') ? 'Claude' : 'rules'} brain, simulated phone trees)`);
