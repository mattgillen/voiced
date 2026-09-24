// Hard cases for the eval harness: the phone trees that break agents. Each one
// is a variant of a demo tree with a known-correct outcome. Some should be
// resolved by the AI, some need a person, and some can't be done by phone at
// all, where the right answer is to fail with the right reason.

import type { IvrScript } from '../engine.js';
import { bedford } from './bedford.js';
import { ironTemple } from './irontemple.js';
import { kestrel } from './kestrel.js';
import type { Scenario } from './types.js';

function variant(
  base: Scenario,
  patch: Partial<Omit<Scenario, 'script' | 'task'>> & {
    id: string;
    phone?: string;
    business?: string;
    title: string;
    edit: (s: IvrScript) => void;
  },
): Scenario {
  const { edit, ...rest } = patch;
  const phone = patch.phone ?? base.phone;
  const business = patch.business ?? base.business;
  return {
    ...base,
    featured: false,
    hard: true,
    ...rest,
    phone,
    business,
    script() {
      const s = base.script();
      s.id = patch.id;
      s.phone = phone;
      s.business = business;
      edit(s);
      return s;
    },
    task(opts) {
      const t = base.task(opts);
      return { ...t, task: { ...t.task, id: patch.id, phone, business, title: patch.title, facts: [...t.task.facts] } };
    },
  };
}

/** Menu option 4 is broken and loops back. Only saying "cancel" at the membership menu works. */
export const ironTempleLoop = variant(ironTemple, {
  id: 'irontemple-loop',
  phone: '+1 (646) 555-0189',
  business: 'Iron Temple Fitness (Midtown)',
  title: 'Cancel my gym: their menu loops',
  pain: ['Option 4 sends you back to the same menu', 'The working path isn’t announced'],
  expect: { resolution: 'human_assisted', reason: 'loop', warm: 'ai' },
  operatorPlaybook: [
    { type: 'say', text: 'Cancel my membership.' },
    { type: 'return', note: 'Option 4 on the membership menu is broken. Saying “cancel my membership” there works.' },
  ],
  edit(s) {
    s.nodes.member_menu = {
      ...s.nodes.member_menu,
      menu: { ...s.nodes.member_menu.menu, '4': 'broken' },
      speech: [{ match: /cancel/i, to: 'save_1' }],
    };
    s.nodes.broken = {
      say: ['That option is temporarily unavailable.', 'Returning to the membership menu.'],
      next: 'member_menu',
    };
  },
});

/** An identity check the task has no answer for: the agent must ask the user, not guess. */
export const bedfordVerify = variant(bedford, {
  id: 'bedford-verify',
  phone: '+1 (315) 555-0111',
  title: 'Pay my Bedford bill: identity check',
  pain: ['Asks for the last 4 of your SSN', 'Not something the agent has on file'],
  expect: { resolution: 'ai' },
  userInputs: { ssn4: '6789' },
  edit(s) {
    s.nodes.lookup = { ...s.nodes.lookup, next: (ctx) => (ctx.vars.zip === ctx.data.zip && ctx.vars.account === ctx.data.account ? 'identity' : 'not_found') };
    s.nodes.identity = {
      say: ['For your security, please enter the last four digits of the Social Security number on the account.'],
      collect: { min: 4, max: 4, store: 'ssn4', validate: (v) => v === '6789', to: 'verify', invalid: 'That doesn’t match our records.' },
    };
  },
});

/** Payments by phone are down. Nothing can finish this call; the right outcome is an honest failure. */
export const bedfordDown = variant(bedford, {
  id: 'bedford-down',
  phone: '+1 (315) 555-0112',
  title: 'Pay my Bedford bill: payments line down',
  pain: ['Phone payments are offline tonight'],
  expect: { resolution: 'failed', reason: 'business_unavailable' },
  edit(s) {
    s.nodes.billing = { ...s.nodes.billing, menu: { ...s.nodes.billing.menu, '1': 'down' } };
    s.nodes.down = {
      say: [
        'We’re sorry, payments by phone are temporarily unavailable.',
        'Please pay online at bedford falls utilities dot com, or call back after 8 AM.',
        'Goodbye.',
      ],
      end: true,
    };
  },
});

/** The billing option moved. The map's replay fails once, then the tree gets relearned. */
export const bedfordMoved = variant(bedford, {
  id: 'bedford-moved',
  title: 'Pay my Bedford bill: menu changed',
  pain: ['Billing moved from 2 to 3 since the last call'],
  expect: { resolution: 'ai' },
  warmWith: 'bedford',
  edit(s) {
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
  },
});

/** The queue refuses callers after the deflection maze. */
export const kestrelClosed = variant(kestrel, {
  id: 'kestrel-closed',
  phone: '+1 (888) 555-0164',
  title: 'Get me a human: queue closed',
  pain: ['“Call back later” after the menus'],
  expect: { resolution: 'failed', reason: 'business_unavailable' },
  edit(s) {
    s.nodes.queue = {
      say: [
        'We’re experiencing unusually high call volume and are unable to take your call right now.',
        'Please call back later. Goodbye.',
      ],
      end: true,
    };
  },
});

export const hardCases: Scenario[] = [ironTempleLoop, bedfordVerify, bedfordDown, bedfordMoved, kestrelClosed];
