// "Get me a human": a deflection-heavy speech IVR, an 18-minute hold queue,
// then a live rep. Voiced briefs the rep and hands the call to the user.

import { spell, type HumanBehavior, type IvrScript } from '../engine.js';
import { persona } from './persona.js';
import type { Scenario } from './types.js';

const PHONE = '+1 (888) 555-0163';
const PIN = '8231';
const CASE = 'KW77104';
const HUMAN = /\b(?:representative|agent|human|person|operator|someone)\b/i;

const dana: HumanBehavior = {
  onAgent(text, ctx) {
    const n = (ctx.flags.agentTurns = (ctx.flags.agentTurns ?? 0) + 1);
    const connect = /\b(?:connect|join|bring (?:them|him|her)|conference|patch|put (?:them|him|her) (?:on|through))\b/i.test(text);
    const ai = /\b(?:ai|assistant|automated|virtual)\b/i.test(text);
    if (connect) {
      return {
        say: [
          ai && n === 1 ? 'Oh, okay. Thanks for letting me know.' : null,
          "Sure, go ahead and connect them. I'll stay on the line.",
        ].filter(Boolean) as string[],
      };
    }
    if (n === 1) return { say: ['Okay. And how can I help today?'] };
    if (n >= 3) return { say: ["I'll need to speak with the account holder directly. Can you bring them on?"] };
    return { say: ["Got it. For privacy I'll need to verify the account holder. Are they available?"] };
  },
  onBridge: () => ({ say: [`Hi, this is Dana with Kestrel billing. Am I speaking with ${persona.firstName}?`] }),
  onUser(text, ctx) {
    const k = (ctx.flags.userTurns = (ctx.flags.userTurns ?? 0) + 1);
    const aboutCharge = /charge|49|protection|dispute|remove|refund|credit|bill/i.test(text);
    if (!ctx.flags.resolved) {
      if (!aboutCharge && k === 1) {
        return { say: [`Great, thanks ${persona.firstName}. I understand you're calling about a charge on your bill?`] };
      }
      ctx.flags.resolved = 1;
      return {
        say: [
          'I see it: a $49.99 Premium Device Protection charge from September 3rd. It looks like it was added during your phone upgrade.',
          "I've removed it and applied a $49.99 credit, so you'll see that on your next statement.",
          `Your case number is ${spell(CASE)}.`,
          'Is there anything else I can help with?',
        ],
      };
    }
    if (/\b(?:no|nope|that'?s (?:it|all)|all set|thanks|thank you|bye)\b/i.test(text)) {
      return { say: [`You're all set, ${persona.firstName}. Thanks for being with Kestrel. Have a great day!`], end: true };
    }
    return { say: ["I can only help with billing on this line, but you're all set on that charge. Anything else on your bill?"] };
  },
};

function script(): IvrScript {
  return {
    id: 'kestrel',
    business: 'Kestrel Wireless',
    phone: PHONE,
    start: 'welcome',
    data: { mdn: persona.mobile, pin: PIN },
    nodes: {
      welcome: {
        say: ['Welcome to Kestrel Wireless.', 'Para español, oprima nueve.'],
        menu: { '9': 'spanish' },
        next: 'mdn',
        timeoutMs: 1800,
      },
      spanish: { say: ['Gracias. Todos nuestros representantes están ocupados. Adiós.'], end: true },
      mdn: {
        say: ['To get started, please enter the ten digit mobile number on your account.'],
        collect: { min: 10, max: 10, store: 'mdn', validate: (v, ctx) => v === ctx.data.mdn, to: 'pin' },
      },
      pin: {
        say: ['Thanks. For your security, enter your four digit account PIN.'],
        collect: {
          min: 4,
          max: 4,
          store: 'pin',
          validate: (v, ctx) => v === ctx.data.pin,
          to: 'intent',
          invalid: "That PIN doesn't match our records.",
        },
      },
      intent: {
        say: [
          `Thanks, ${persona.firstName}. I can help with things like paying your bill, checking your data usage, or technical support.`,
          "In a few words, tell me what you're calling about.",
        ],
        speech: [
          { match: HUMAN, to: 'deflect' },
          { match: /dispute|charge|bill|fee|refund/i, to: 'bill_question' },
          { match: /\bpay/i, to: 'deflect' },
        ],
        invalid: "Sorry, I didn't get that. You can say things like 'pay my bill' or 'technical support'.",
      },
      bill_question: {
        say: [
          'It sounds like you have a question about your bill.',
          'Your current balance is $187.43, due October 9th.',
          'Good news: you can see a full breakdown of your charges in the Kestrel app.',
          'Would you like me to text you a link to your bill? Say yes or no.',
        ],
        speech: [
          { match: HUMAN, to: 'deflect' },
          { match: /^\s*(?:yes|yeah|sure)\b/i, to: 'texted' },
          { match: /\bno\b/i, to: 'explain_offer' },
        ],
      },
      texted: { say: ["Done! I've texted you a link. Thanks for calling Kestrel. Goodbye."], end: true },
      explain_offer: {
        say: ['Okay. I can also explain the charges on your bill.', "Just say 'explain my bill', or say 'something else'."],
        speech: [
          { match: /something else/i, to: 'deflect' },
          { match: HUMAN, to: 'deflect' },
          { match: /explain/i, to: 'texted' },
        ],
      },
      deflect: {
        say: ["I can help with most things right here, and it's usually faster.", 'Can you tell me a little more about what you need?'],
        speech: [
          { match: HUMAN, to: 'transfer' },
          { match: /dispute|charge|bill/i, to: 'explain_offer' },
        ],
      },
      transfer: {
        say: [
          'Okay, let me get you to someone who can help.',
          'Please note, for your privacy, our representatives can only discuss the account with the account holder.',
        ],
        next: 'queue',
      },
      queue: {
        say: ['All of our representatives are currently assisting other customers.', 'Your estimated wait time is 18 minutes.'],
        hold: {
          ms: 18 * 60_000 - 40_000,
          every: 4,
          messages: [
            'Thank you for your patience. Your call is important to us and will be answered in the order it was received.',
            'Did you know you can manage your account, pay your bill, and more in the Kestrel app?',
          ],
        },
        next: 'rep',
      },
      rep: {
        speaker: 'human',
        say: ['Thank you for holding, this is Dana with Kestrel Wireless billing.', 'Who do I have the pleasure of speaking with today?'],
        human: dana,
        timeoutMs: 8000,
      },
    },
  };
}

export const kestrel: Scenario = {
  id: 'kestrel',
  business: 'Kestrel Wireless',
  phone: PHONE,
  category: 'Reach a human',
  title: 'Dispute a charge, hand me a human',
  pain: ['IVR refuses to transfer', '18-minute hold', 'Rep needs the account holder'],
  featured: false,
  script,
  task() {
    return {
      task: {
        id: 'kestrel-dispute',
        kind: 'reach_human',
        title: 'Dispute a charge, hand me a human',
        goal: `Get a live Kestrel Wireless billing rep on the line about a $49.99 "Premium Device Protection" charge ${persona.firstName} never signed up for, brief them, then hand the call to ${persona.firstName}.`,
        business: 'Kestrel Wireless',
        phone: PHONE,
        user: { name: persona.name, firstName: persona.firstName },
        navHints: {
          representative: 6,
          agent: 5,
          'speak with': 5,
          'something else': 4,
          'all other': 3,
          other: 2,
          billing: 2,
          'technical support': -3,
          'data usage': -3,
          'explain my bill': -3,
        },
        intentPhrase: 'I want to dispute a charge on my bill.',
        purpose: 'would like to dispute a $49.99 Premium Device Protection charge on the September bill that they never signed up for',
        facts: [
          { key: 'name', label: 'Account holder', value: persona.name, aliases: ['name on the account', 'account holder', 'your name'] },
          { key: 'mdn', label: 'Mobile number', value: persona.mobile, aliases: ['mobile number on your account', 'mobile number', 'wireless number', 'phone number'] },
          { key: 'pin', label: 'Account PIN', secret: true, display: '••••', aliases: ['account pin', 'pin', 'passcode'] },
        ],
        policy: { discloseAI: true, handoffToUser: true },
        successNote: 'handoff',
      },
      secrets: { pin: PIN },
    };
  },
};
