// Run a simulated call in the terminal and print the transcript.
//   npx tsx scripts/sim.ts bedford            # rules brain
//   npx tsx scripts/sim.ts bedford --claude   # Claude brain (needs ANTHROPIC_API_KEY)
//   npx tsx scripts/sim.ts all --twice        # every scenario, twice, sharing one IVR map

import { ClaudeBrain } from '../src/brains/claude.js';
import { MapMemory } from '../src/core/memory.js';
import { formatDuration } from '../src/core/session.js';
import type { CallEvent } from '../src/core/types.js';
import { simulate } from '../src/sim/run.js';
import { scenarios } from '../src/sim/scenarios/index.js';

const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith('--')) ?? 'bedford';
const twice = args.includes('--twice');
const quiet = args.includes('--quiet');
const useClaude = args.includes('--claude');
const decline = args.includes('--decline');
const memory = new MapMemory();

const ids = which === 'all' ? scenarios.map((s) => s.id) : [which];
const clock = (t: number) => formatDuration(t).padStart(7);

for (const id of ids) {
  for (let run = 1; run <= (twice ? 2 : 1); run++) {
    const { session, task } = simulate(id, { memory, brain: useClaude ? new ClaudeBrain() : undefined });
    let replies = 0;
    console.log(`\n━━ ${task.title} · ${task.business} · run ${run} ━━`);
    session.subscribe((e: CallEvent) => {
      if (!quiet) print(e);
      if (e.type === 'user_request') {
        setTimeout(() => session.respond(e.id, { approved: !decline, choice: e.request.kind === 'choose' ? e.request.options[0] : undefined }), 10);
      }
      // Play the user once they're bridged in: reply whenever the rep finishes a question.
      if (e.type === 'bridge' && e.from === 'human' && e.text.trim().endsWith('?')) {
        const lines = ['Hi Dana, yes. The $49.99 device protection charge. I never signed up for it.', "That's all, thank you!"];
        const next = lines[replies++];
        if (next) setTimeout(() => void session.userSays(next), 10);
      }
    });
    const r = await session.run();
    console.log(
      `→ ${r.outcome.toUpperCase()}: ${r.summary}\n  call ${formatDuration(r.callMs)} · hold ${formatDuration(r.holdMs)} · you tapped ${r.userTouches}× · map hits ${r.mapHits} · model calls ${r.llmCalls}`,
    );
  }
}

function print(e: CallEvent) {
  switch (e.type) {
    case 'heard':
      if (e.speaker === 'hold' && e.text.startsWith('♪')) return;
      console.log(`${clock(e.t)}  ${e.speaker.toUpperCase().padEnd(5)} ${e.text}`);
      break;
    case 'action':
      if (e.action.type === 'wait' && e.source !== 'map') console.log(`${clock(e.t)}  ·     (${e.reason})`);
      else console.log(`${clock(e.t)}  AGENT ${e.display ? `[${e.action.type}] ${e.display}` : `[${e.action.type}]`}  ← ${e.source}: ${e.reason}`);
      break;
    case 'user_request':
      console.log(`${clock(e.t)}  ⚠︎ ASK ${e.request.title}: ${e.request.detail}`);
      break;
    case 'handoff':
      console.log(`${clock(e.t)}  ⇄ HANDOFF ${e.briefing}`);
      break;
    case 'bridge':
      console.log(`${clock(e.t)}  ${e.from === 'user' ? 'YOU  ' : 'REP  '} ${e.text}`);
      break;
    case 'status':
      if (e.status === 'on_hold') console.log(`${clock(e.t)}  ♪ on hold`);
      break;
  }
}
