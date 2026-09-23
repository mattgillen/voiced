// Bill pay through a classic DTMF utility IVR: language menu, main menu,
// billing menu, ZIP + account lookup, identity check, card entry, fee
// disclosure and an authorization step. Two dozen keypresses by hand.

import { luhn, spell, type IvrScript } from '../engine.js';
import { card, persona } from './persona.js';
import type { Scenario } from './types.js';

const PHONE = '+1 (315) 555-0110';
const BALANCE = 142.17;
const FEE = 2.95;
const CONFIRMATION = '4820177';
const ACCOUNT = '4410228719';

function script(): IvrScript {
  return {
    id: 'bedford',
    business: 'Bedford Falls Electric & Water',
    phone: PHONE,
    start: 'welcome',
    data: { account: ACCOUNT, zip: persona.zip },
    nodes: {
      welcome: {
        say: [
          'Thank you for calling Bedford Falls Electric and Water.',
          'This call may be monitored or recorded for quality assurance.',
          'Please listen carefully, as our menu options have changed.',
        ],
        next: 'language',
      },
      language: {
        say: ['For English, press 1.', 'Para español, oprima el dos.'],
        menu: { '1': 'main', '2': 'spanish' },
      },
      spanish: { say: ['Lo sentimos, este servicio no está disponible en este momento.', 'Adiós.'], end: true },
      main: {
        say: [
          'To report a power outage or emergency, press 1.',
          'For billing and payments, press 2.',
          'To start, stop, or transfer service, press 3.',
          'For all other questions, press 4.',
        ],
        menu: { '1': 'wrong_turn', '2': 'billing', '3': 'wrong_turn', '4': 'wrong_turn' },
      },
      wrong_turn: {
        say: ["We're sorry, that department is closed right now.", 'Returning to the main menu.'],
        next: 'main',
      },
      billing: {
        say: [
          'Billing and payments.',
          'To make a payment, press 1.',
          'To hear your balance and due date, press 2.',
          'To set up a payment arrangement, press 3.',
          'To return to the main menu, press star.',
        ],
        menu: { '1': 'zip', '2': 'wrong_turn', '3': 'wrong_turn', '*': 'main' },
      },
      zip: {
        say: ['Using your telephone keypad, please enter the five digit ZIP code for your service address.'],
        collect: { min: 5, max: 5, store: 'zip', to: 'account' },
      },
      account: {
        say: ['Thank you.', 'Now enter your ten digit account number, followed by the pound key.'],
        collect: { min: 10, max: 10, terminator: true, store: 'account', to: 'lookup' },
      },
      lookup: {
        say: ['One moment while I find your account.'],
        pauseMs: 1800,
        next: (ctx) => (ctx.vars.zip === ctx.data.zip && ctx.vars.account === ctx.data.account ? 'verify' : 'not_found'),
      },
      not_found: {
        say: ["I'm sorry, I couldn't find an account matching that information. Let's try again."],
        next: 'zip',
      },
      verify: {
        say: [
          `I found an account for ${persona.name} at ${persona.address}.`,
          'If this is correct, press 1.',
          'Otherwise, press 2.',
        ],
        menu: { '1': 'balance', '2': 'zip' },
      },
      balance: {
        say: [
          `Your current balance is $${BALANCE.toFixed(2)}, due on October 3rd.`,
          'To pay the full balance, press 1.',
          'To pay a different amount, press 2.',
          'To return to the main menu, press star.',
        ],
        menu: { '1': 'card', '2': 'wrong_turn', '*': 'main' },
      },
      card: {
        say: ['Please enter your credit or debit card number, followed by the pound key.'],
        collect: {
          min: 15,
          max: 16,
          terminator: true,
          store: 'card',
          validate: (v) => luhn(v),
          to: 'expiry',
          invalid: "I'm sorry, that card number is not valid.",
        },
      },
      expiry: {
        say: ['Enter the four digit expiration date, using two digits for the month and two digits for the year.'],
        collect: {
          min: 4,
          max: 4,
          store: 'exp',
          validate: (v) => Number(v.slice(0, 2)) >= 1 && Number(v.slice(0, 2)) <= 12,
          to: 'cvv',
        },
      },
      cvv: {
        say: ['Enter the three or four digit security code from your card, followed by the pound key.'],
        collect: { min: 3, max: 4, terminator: true, store: 'cvv', to: 'billing_zip' },
      },
      billing_zip: {
        say: ['Enter the five digit billing ZIP code for this card.'],
        collect: { min: 5, max: 5, store: 'billing_zip', to: 'confirm' },
      },
      confirm: {
        say: (ctx) => [
          `You are about to pay $${BALANCE.toFixed(2)} to Bedford Falls Electric and Water using the card ending in ${spell(ctx.vars.card.slice(-4))}.`,
          `A convenience fee of $${FEE.toFixed(2)} will be applied, for a total of $${(BALANCE + FEE).toFixed(2)}.`,
          'To authorize this payment, press 1.',
          'To cancel, press 2.',
        ],
        menu: { '1': 'processing', '2': 'cancelled' },
        timeoutMs: 9000,
      },
      processing: { say: ['Please wait while we process your payment.'], pauseMs: 3500, next: 'paid' },
      paid: {
        say: [
          'Your payment has been approved.',
          `Your confirmation number is ${spell(CONFIRMATION)}.`,
          `Again, your confirmation number is ${spell(CONFIRMATION)}.`,
          'Thank you for calling Bedford Falls Electric and Water. Goodbye.',
        ],
        end: true,
      },
      cancelled: { say: ['Your payment has been cancelled.', 'Thank you for calling. Goodbye.'], end: true },
    },
  };
}

export const bedford: Scenario = {
  id: 'bedford',
  business: 'Bedford Falls Electric & Water',
  phone: PHONE,
  category: 'Bill pay',
  title: 'Pay my Bedford utilities bill',
  pain: ['9 menus and prompts', '43 keypresses', 'Card, expiry, CVV and ZIP by keypad'],
  featured: true,
  script,
  task(opts = {}) {
    const c = card(opts.cardId);
    return {
      task: {
        id: 'bedford-pay',
        kind: 'pay_bill',
        title: 'Pay my Bedford utilities bill',
        goal: `Pay the full current balance on ${persona.firstName}'s Bedford Falls Electric & Water account with the authorized card, and get a confirmation number.`,
        business: 'Bedford Falls Electric & Water',
        phone: PHONE,
        user: { name: persona.name, firstName: persona.firstName },
        navHints: {
          'make a payment': 5,
          payment: 3,
          pay: 2,
          billing: 2,
          'full balance': 5,
          'different amount': -3,
          'hear your balance': -2,
          outage: -6,
          emergency: -6,
          arrangement: -4,
          'start, stop': -3,
        },
        intentPhrase: 'Pay my bill',
        purpose: 'would like to pay the current balance on the account',
        facts: [
          { key: 'name', label: 'Account holder', value: persona.name, aliases: ['name on the account', 'account holder'] },
          { key: 'address', label: 'Service address', value: persona.address, aliases: ['street address'] },
          { key: 'zip', label: 'Service ZIP', value: persona.zip, aliases: ['zip code for your service address', 'service zip', 'zip code'] },
          { key: 'account', label: 'Account number', secret: true, display: `•••• ${ACCOUNT.slice(-4)}`, aliases: ['account number'] },
          { key: 'card.number', label: 'Card number', secret: true, display: c.label, aliases: ['credit or debit card', 'card number'] },
          { key: 'card.exp', label: 'Card expiration', secret: true, display: '••/••', aliases: ['expiration date', 'expiration'] },
          { key: 'card.cvv', label: 'Card security code', secret: true, display: '•••', aliases: ['security code', 'cvv', 'verification code'] },
          { key: 'card.zip', label: 'Card billing ZIP', value: persona.zip, aliases: ['billing zip code', 'billing zip'] },
        ],
        policy: {
          discloseAI: true,
          payment: {
            cardId: c.id,
            cardLabel: c.label,
            maxAmount: opts.maxAmount ?? 200,
            maxFee: opts.maxFee ?? 0,
          },
        },
        successNote: 'confirmation',
      },
      secrets: {
        account: ACCOUNT,
        'card.number': c.number,
        'card.exp': c.exp,
        'card.cvv': opts.cvv ?? (c.cvvLength === 4 ? '1234' : '737'),
      },
    };
  },
};
