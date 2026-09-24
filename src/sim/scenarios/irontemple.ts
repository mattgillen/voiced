// Cancellation through a retention-optimized IVR: no "cancel" option in any
// menu, two save offers, a reason prompt, then a confirmation step.

import { spell, type IvrScript } from '../engine.js';
import { persona } from './persona.js';
import type { Scenario } from './types.js';

const PHONE = '+1 (646) 555-0188';
const MEMBER = '00427719';
const CONFIRMATION = 'CX44190';
const NO = /\b(?:no|nope|not interested|continue|cancel)\b/i;
const YES = /^\s*(?:yes|yeah|sure|okay|ok)\b/i;

function script(): IvrScript {
  return {
    id: 'irontemple',
    business: 'Iron Temple Fitness',
    phone: PHONE,
    start: 'welcome',
    data: { member: MEMBER },
    nodes: {
      welcome: {
        say: [
          'Thank you for calling Iron Temple Fitness, where strong starts here.',
          'For club hours and locations, press 1.',
          'For personal training, press 2.',
          'For membership and billing questions, press 3.',
          'For all other inquiries, press 0.',
        ],
        menu: { '1': 'wrong_turn', '2': 'wrong_turn', '3': 'member_id', '0': 'member_id' },
      },
      wrong_turn: { say: ['Please visit iron temple fitness dot com for more information.'], next: 'welcome' },
      member_id: {
        say: ['Please enter your eight digit member ID, found on the back of your key tag.'],
        collect: {
          min: 8,
          max: 8,
          store: 'member',
          validate: (v, ctx) => v === ctx.data.member,
          to: 'member_menu',
          invalid: "Sorry, I couldn't find that member ID.",
        },
      },
      member_menu: {
        say: [
          `Thanks, ${persona.firstName}.`,
          'To update your payment method, press 1.',
          'To freeze your membership, press 2.',
          'To upgrade your membership, press 3.',
          'For all other membership questions, press 4.',
        ],
        menu: { '1': 'wrong_turn', '2': 'frozen', '3': 'wrong_turn', '4': 'other' },
      },
      other: {
        say: ['Okay. Briefly, what can I help you with today?'],
        speech: [
          { match: /cancel|terminate|end my membership/i, to: 'save_1' },
          { match: /freeze|pause/i, to: 'frozen' },
        ],
        invalid: "Sorry, I didn't get that. You can say things like 'billing question' or 'update my address'.",
      },
      save_1: {
        say: [
          "We'd hate to see you go!",
          'As a valued member, you qualify for a special offer: three months at half price, just $17.50 a month.',
          "To accept this offer, say 'yes'. To continue with your cancellation, say 'no'.",
        ],
        speech: [
          { match: YES, to: 'accepted' },
          { match: NO, to: 'save_2' },
        ],
      },
      save_2: {
        say: [
          'I understand.',
          'Before you go, would you like to freeze your membership instead, for just $9.99 a month? Your current rate will be locked in.',
          'Say yes or no.',
        ],
        speech: [
          { match: YES, to: 'frozen' },
          { match: NO, to: 'reason' },
        ],
      },
      reason: {
        say: ['Okay. So we can improve, can you tell me the main reason for canceling?'],
        capture: { store: 'reason', parse: (t) => (t.trim().length > 2 ? t.trim() : undefined), to: 'terms' },
      },
      terms: {
        say: [
          'Thank you for the feedback.',
          'Your membership will be canceled effective October 31st, at the end of your current billing cycle.',
          'You will not be charged your $35.00 monthly dues after that date.',
          'To confirm your cancellation, press 1. To keep your membership, press 2.',
        ],
        menu: { '1': 'canceled', '2': 'kept' },
      },
      canceled: {
        say: [
          'Your membership has been canceled.',
          `Your cancellation confirmation number is ${spell(CONFIRMATION)}.`,
          "We'll email a copy to the address on file.",
          'Thank you for being a member of Iron Temple Fitness. Goodbye.',
        ],
        end: true,
      },
      accepted: { say: ["Great! You'll see $17.50 on your next three statements. Goodbye."], end: true },
      frozen: { say: ['Your membership has been frozen at $9.99 a month. Goodbye.'], end: true },
      kept: { say: ["Great, we're glad you're staying! Goodbye."], end: true },
    },
  };
}

export const ironTemple: Scenario = {
  id: 'irontemple',
  business: 'Iron Temple Fitness',
  phone: PHONE,
  category: 'Cancellation',
  title: 'Cancel my gym membership',
  pain: ['No "cancel" option in any menu', 'Two retention offers', 'Phone-only cancellation'],
  featured: true,
  expect: { resolution: 'ai' },
  script,
  task() {
    return {
      task: {
        id: 'irontemple-cancel',
        kind: 'cancel',
        title: 'Cancel my gym membership',
        goal: `Cancel ${persona.firstName}'s Iron Temple Fitness membership. Decline every retention offer (discounts, freezes). Get a cancellation confirmation number.`,
        business: 'Iron Temple Fitness',
        phone: PHONE,
        user: { name: persona.name, firstName: persona.firstName },
        navHints: {
          cancel: 8,
          cancellation: 8,
          membership: 4,
          'all other': 3,
          other: 2,
          freeze: -6,
          upgrade: -5,
          'payment method': -4,
          hours: -4,
          training: -4,
        },
        intentPhrase: 'Cancel my membership.',
        purpose: 'would like to cancel their membership',
        facts: [
          { key: 'name', label: 'Member name', value: persona.name, aliases: ['name on the account', 'your name'] },
          { key: 'member', label: 'Member ID', value: MEMBER, aliases: ['member id', 'member number', 'membership number'] },
          {
            key: 'reason',
            label: 'Reason for canceling',
            value: "I'm moving out of state",
            spoken: "I'm moving out of state, so I won't be able to use the club anymore.",
            aliases: ['reason for canceling', 'reason for cancelling', 'main reason', 'why you'],
          },
        ],
        policy: { discloseAI: true, declineRetentionOffers: true, authorizedCommit: true },
        successNote: 'confirmation',
      },
      secrets: {},
    };
  },
};
