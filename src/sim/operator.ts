// A scripted stand-in for a human operator, for the eval harness and the demo.
// It follows each scenario's playbook (what a person would do on that tree).
// With no playbook it does what an honest operator does when phone support
// can't finish the job: ends the call and says why.

import type { OperatorQueue } from '../core/operators.js';
import { phoneKey } from '../core/memory.js';
import { allScenarios } from './scenarios/index.js';

export function attachScriptedOperator(queue: OperatorQueue, opts: { delayMs?: number; name?: string } = {}) {
  const delay = opts.delayMs ?? 0;
  const name = opts.name ?? 'Sam (simulated operator)';
  const wait = () => new Promise((r) => setTimeout(r, delay));
  return queue.onOpen((ticket) => {
    const scenario = allScenarios.find((s) => phoneKey(s.phone) === phoneKey(ticket.phone));
    const playbook = scenario?.operatorPlaybook ?? [
      { type: 'hangup' as const, summary: `An operator reviewed it: ${ticket.detail.charAt(0).toLowerCase()}${ticket.detail.slice(1)}, and it can’t be finished by phone.` },
    ];
    void (async () => {
      for (const command of playbook) {
        await wait();
        const t = queue.get(ticket.id);
        if (!t || t.status === 'closed') return;
        await queue.act(ticket.id, command, name).catch(() => undefined);
      }
    })();
  });
}
