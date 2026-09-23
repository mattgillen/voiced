// Build a Task for an arbitrary business from a small, developer-friendly
// input. Standard fact keys (zip, account, card.number, pin, ...) come with the
// phrasing IVRs use to ask for them and the right secrecy defaults.

import type { Fact, Task, TaskKind } from './types.js';

export interface CustomTaskInput {
  /** E.164 number to dial, e.g. +13155550110. */
  to: string;
  business: string;
  kind: TaskKind;
  /** What should happen, in plain language. */
  goal: string;
  /** What to say at "how can I help?" prompts. Defaults by kind. */
  intent_phrase?: string;
  user: { name: string };
  /** Standard keys get labels, aliases and secrecy for free; values may be strings or {value, secret}. */
  facts?: Record<string, string | { value: string; secret?: boolean; label?: string; aliases?: string[] }>;
  max_amount?: number;
  max_fee?: number;
  card_label?: string;
  handoff_to_user?: boolean;
  decline_retention_offers?: boolean;
  /** The user authorized the irreversible step (e.g. the cancellation itself). */
  authorize_commit?: boolean;
}

interface StandardFact {
  label: string;
  aliases: string[];
  secret?: boolean;
  display?: (v: string) => string;
}

const last4 = (v: string) => `•••• ${v.slice(-4)}`;

export const STANDARD_FACTS: Record<string, StandardFact> = {
  name: { label: 'Account holder', aliases: ['name on the account', 'account holder', 'your name', 'first and last name'] },
  zip: { label: 'Service ZIP', aliases: ['zip code for your service address', 'service zip', 'zip code', 'postal code'] },
  address: { label: 'Service address', aliases: ['street address', 'service address', 'billing address'] },
  phone: { label: 'Phone number', aliases: ['phone number on the account', 'mobile number', 'phone number', 'callback number', 'wireless number'] },
  account: { label: 'Account number', aliases: ['account number'], secret: true, display: last4 },
  member: { label: 'Member ID', aliases: ['member id', 'member number', 'membership number'] },
  policy: { label: 'Policy number', aliases: ['policy number'], secret: true, display: last4 },
  pin: { label: 'Account PIN', aliases: ['account pin', 'pin', 'passcode'], secret: true, display: () => '••••' },
  ssn4: { label: 'Last 4 of SSN', aliases: ['last four digits of your social', 'last four of your social', 'social security'], secret: true, display: () => '•••' },
  dob: { label: 'Date of birth', aliases: ['date of birth', 'birth date', 'birthday'], secret: true, display: () => '••/••/••' },
  'card.number': { label: 'Card number', aliases: ['credit or debit card', 'card number'], secret: true, display: last4 },
  'card.exp': { label: 'Card expiration', aliases: ['expiration date', 'expiration'], secret: true, display: () => '••/••' },
  'card.cvv': { label: 'Card security code', aliases: ['security code', 'cvv', 'verification code'], secret: true, display: () => '•••' },
  'card.zip': { label: 'Card billing ZIP', aliases: ['billing zip code', 'billing zip'] },
};

const NAV_HINTS: Record<TaskKind, Record<string, number>> = {
  pay_bill: {
    'make a payment': 5,
    payment: 3,
    pay: 2,
    billing: 2,
    'full balance': 5,
    'different amount': -3,
    outage: -6,
    emergency: -6,
    arrangement: -4,
  },
  cancel: { cancel: 8, cancellation: 8, 'all other': 3, other: 2, account: 1, upgrade: -5, freeze: -6, pause: -4 },
  reservation: { reservation: 6, reserve: 5, book: 4, appointment: 5, schedule: 4, hours: -2 },
  reach_human: { representative: 6, agent: 5, 'speak with': 5, 'something else': 4, 'all other': 3, other: 2, operator: 5 },
};

const INTENT: Record<TaskKind, string> = {
  pay_bill: 'Pay my bill',
  cancel: 'Cancel my account',
  reservation: 'Make a reservation',
  reach_human: 'Representative',
};

export function buildCustomTask(input: CustomTaskInput): { task: Task; secrets: Record<string, string> } {
  const facts: Fact[] = [];
  const secrets: Record<string, string> = {};
  const add = (key: string, raw: CustomTaskInput['facts'] extends Record<string, infer V> | undefined ? V : never) => {
    const std = STANDARD_FACTS[key];
    const value = typeof raw === 'string' ? raw : raw.value;
    const secret = (typeof raw === 'string' ? undefined : raw.secret) ?? std?.secret ?? false;
    const label = (typeof raw === 'string' ? undefined : raw.label) ?? std?.label ?? key;
    const aliases = [...((typeof raw === 'string' ? undefined : raw.aliases) ?? []), ...(std?.aliases ?? [label.toLowerCase()])];
    if (secret) {
      secrets[key] = value;
      facts.push({ key, label, secret: true, display: std?.display?.(value) ?? '••••', aliases });
    } else facts.push({ key, label, value, aliases });
  };
  add('name', input.user.name);
  for (const [key, raw] of Object.entries(input.facts ?? {})) if (key !== 'name') add(key, raw);

  const first = input.user.name.split(/\s+/)[0];
  const task: Task = {
    id: `custom-${input.kind}`,
    kind: input.kind,
    title: input.goal.length > 60 ? `${input.goal.slice(0, 57)}…` : input.goal,
    goal: input.goal,
    business: input.business,
    phone: input.to,
    user: { name: input.user.name, firstName: first },
    navHints: NAV_HINTS[input.kind],
    intentPhrase: input.intent_phrase ?? INTENT[input.kind],
    purpose: `needs help with the following: ${input.goal.replace(/\.$/, '')}`,
    facts,
    policy: {
      discloseAI: true,
      handoffToUser: input.handoff_to_user ?? input.kind === 'reach_human',
      declineRetentionOffers: input.decline_retention_offers ?? input.kind === 'cancel',
      authorizedCommit: input.authorize_commit ?? false,
      payment:
        input.max_amount !== undefined
          ? { cardId: 'card', cardLabel: input.card_label ?? STANDARD_FACTS['card.number'].display!(secrets['card.number'] ?? '0000'), maxAmount: input.max_amount, maxFee: input.max_fee ?? 0 }
          : undefined,
    },
    successNote: input.kind === 'reach_human' ? 'handoff' : 'confirmation',
  };
  return { task, secrets };
}
