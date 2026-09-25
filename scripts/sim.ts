// Run a simulated call in the terminal and print the transcript.
//   npx tsx scripts/sim.ts bedford            # rules brain
//   npx tsx scripts/sim.ts bedford --gemini   # Gemini brain (needs GEMINI_API_KEY; free tier works)
//   npx tsx scripts/sim.ts bedford --claude   # Claude brain (needs ANTHROPIC_API_KEY)
//   npx tsx scripts/sim.ts all --twice        # every scenario, twice, sharing one IVR map

import '../src/env.js';
import { brainKind, makeBrain } from '../src/brains/select.js';
import { MapMemory } from '../src/core/memory.js';
import { OperatorQueue } from '../src/core/operators.js';
import { attachScriptedOperator } from '../src/sim/operator.js';
import { formatDuration } from '../src/core/session.js';
import type { CallEvent } from '../src/core/types.js';
import { printEvent } from './transcript.js';
import { simulate } from '../src/sim/run.js';
import { allScenarios, getScenario, scenarios } from '../src/sim/scenarios/index.js';

const args = process.argv.slice(2);
const which = args.find((a) => !a.startsWith('--')) ?? 'bedford';
const twice = args.includes('--twice');
const quiet = args.includes('--quiet');
const kind = brainKind({}, args);
// One shared model brain; free-tier rate limits are waited out rather than handed to rules.
const brain = kind === 'rules' ? undefined : makeBrain(kind, { maxRetryWaitMs: 60_000 });
const decline = args.includes('--decline');
const memory = new MapMemory();
const operators = new OperatorQueue();
attachScriptedOperator(operators);

const ids = which === 'all' ? scenarios.map((s) => s.id) : which === 'hard' ? allScenarios.filter((s) => s.hard).map((s) => s.id) : [which];

for (const id of ids) {
  for (let run = 1; run <= (twice ? 2 : 1); run++) {
    const { session, task } = simulate(id, { memory, operators, brain });
    const inputs = getScenario(id)?.userInputs ?? {};
    let replies = 0;
    console.log(`\n━━ ${task.title} · ${task.business} · run ${run} ━━`);
    session.subscribe((e: CallEvent) => {
      if (!quiet) printEvent(e);
      if (e.type === 'user_request') {
        const r = e.request;
        const text = r.kind === 'input' ? inputs[r.factKey ?? ''] : undefined;
        setTimeout(() => session.respond(e.id, { approved: r.kind === 'input' ? !!text : !decline, text, choice: r.kind === 'choose' ? r.options[0] : undefined }), 10);
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
      `→ ${r.resolution.toUpperCase()}: ${r.summary}\n  call ${formatDuration(r.callMs)} · hold ${formatDuration(r.holdMs)} · you tapped ${r.userTouches}× · operator ${r.operatorTouches}× · map hits ${r.mapHits} · model calls ${r.llmCalls}` +
        (r.result ? `\n  result: ${r.result.kind}${r.result.amount ? ` ${r.result.amount}` : ''}${r.result.confirmation ? ` #${r.result.confirmation}` : ''} (evidence @${formatDuration(r.result.evidence?.t ?? 0)}: “${r.result.evidence?.text ?? ''}”)` : '') +
        (r.failure ? `\n  broke at “${r.failure.step}”: ${r.failure.reason}: ${r.failure.detail}` : ''),
    );
  }
}
