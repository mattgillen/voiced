// A conversational (speech) booking line: slot filling by voice, a sold-out
// time with alternatives to negotiate, and a phone number by keypad.

import { parseTimes, formatTime } from '../../core/parse.js';
import { spell, type IvrScript } from '../engine.js';
import { persona } from './persona.js';
import type { Scenario } from './types.js';

const PHONE = '+1 (212) 555-0137';
const CONFIRMATION = 'LUN482';
const ALTERNATIVES = [18 * 60 + 15, 19 * 60 + 45];

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function parseCount(text: string): string | undefined {
  const digit = /\b(\d{1,2})\b/.exec(text);
  if (digit) return digit[1];
  const word = Object.keys(NUMBER_WORDS).find((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
  return word ? String(NUMBER_WORDS[word]) : undefined;
}

function script(): IvrScript {
  return {
    id: 'luna',
    business: 'Luna Trattoria',
    phone: PHONE,
    start: 'greet',
    nodes: {
      greet: {
        say: [
          "Thanks for calling Luna Trattoria! I'm Luna's virtual host.",
          "You can say things like 'make a reservation', 'hours and location', or 'catering'.",
          'What can I help you with?',
        ],
        speech: [
          { match: /reserv|book|table/i, to: 'party' },
          { match: /hour|location|address|open/i, to: 'hours' },
          { match: /cater/i, to: 'hours' },
        ],
      },
      hours: {
        say: ["We're open five to ten every night at 88 Mulberry Lane.", 'Is there anything else I can help with?'],
        speech: [{ match: /reserv|book|table/i, to: 'party' }],
        next: 'goodbye',
      },
      party: {
        say: ['Wonderful, I can help with that.', 'How many guests will be joining you?'],
        capture: { store: 'party', parse: parseCount, to: 'date' },
        invalid: 'Sorry, how many people is the reservation for?',
      },
      date: {
        say: ['And what day would you like to come in?'],
        capture: {
          store: 'date',
          parse: (t) => (/fri|25/i.test(t) ? 'Friday, September 25th' : /tonight|today|wed/i.test(t) ? 'tonight' : undefined),
          to: 'time',
        },
        invalid: "Sorry, we're only booking this week. Which day works for you?",
      },
      time: {
        say: (ctx) => [`${ctx.vars.date}, got it. What time would you like?`],
        capture: {
          store: 'time',
          parse: (t) => {
            const m = parseTimes(t)[0];
            return m === undefined ? undefined : String(m);
          },
          to: (ctx) => (ALTERNATIVES.includes(Number(ctx.vars.time)) ? 'name' : 'alternatives'),
        },
      },
      alternatives: {
        say: (ctx) => [
          `I'm sorry, ${formatTime(Number(ctx.vars.time))} is fully booked for a party of ${ctx.vars.party}.`,
          `The closest times I have are ${ALTERNATIVES.map(formatTime).join(' or ')}.`,
          "Which would you prefer? You can also say 'waitlist'.",
        ],
        speech: [{ match: /wait ?list/i, to: 'goodbye' }],
        capture: {
          store: 'time',
          parse: (t) => {
            const m = parseTimes(t)[0];
            return m !== undefined && ALTERNATIVES.includes(m) ? String(m) : undefined;
          },
          to: 'name',
        },
        invalid: `Sorry, I only have ${ALTERNATIVES.map(formatTime).join(' or ')}. Which would you like?`,
      },
      name: {
        say: ['Perfect. What name should I put the reservation under?'],
        capture: {
          store: 'name',
          parse: (t) => t.replace(/^(?:it'?s|under|the name is|name is)\s+/i, '').replace(/[.!]$/, '').trim() || undefined,
          to: 'phone',
        },
      },
      phone: {
        say: ['And a mobile number for the reservation.', 'Please enter it on your keypad, starting with the area code.'],
        collect: { min: 10, max: 10, store: 'phone', to: 'requests' },
      },
      requests: {
        say: ['Last question. Are we celebrating anything, or are there any special requests, like a high chair or accessibility needs?'],
        capture: { store: 'requests', parse: (t) => t.trim() || undefined, to: 'booked' },
      },
      booked: {
        say: (ctx) => [
          `You're all set! A table for ${ctx.vars.party} on ${ctx.vars.date} at ${formatTime(Number(ctx.vars.time))}, under the name ${ctx.vars.name}.`,
          /birthday/i.test(ctx.vars.requests ?? '') ? "We'll have a little something for the birthday." : null,
          `Your confirmation code is ${spell(CONFIRMATION)}.`,
          `We'll text a reminder to the number ending in ${spell((ctx.vars.phone ?? '').slice(-4))}.`,
          'See you soon. Goodbye!',
        ].filter(Boolean) as string[],
        end: true,
      },
      goodbye: { say: ['Thanks for calling Luna Trattoria. Goodbye!'], end: true },
    },
  };
}

export const luna: Scenario = {
  id: 'luna',
  business: 'Luna Trattoria',
  phone: PHONE,
  category: 'Reservation',
  title: 'Book dinner for 4, Friday 7–8pm',
  pain: ['Voice-only booking bot', 'Your time is sold out', 'Phone number by keypad'],
  featured: false,
  script,
  task() {
    return {
      task: {
        id: 'luna-book',
        kind: 'reservation',
        title: 'Book dinner for 4, Friday 7–8pm',
        goal: `Book a table for 4 at Luna Trattoria this Friday (September 25th) between 7:00 and 8:00 PM under ${persona.name}. Mention it's a birthday dinner. Get a confirmation code.`,
        business: 'Luna Trattoria',
        phone: PHONE,
        user: { name: persona.name, firstName: persona.firstName },
        navHints: { reservation: 6, reserve: 5, book: 4, table: 3, hours: -2, catering: -3 },
        intentPhrase: 'Make a reservation',
        purpose: 'would like to book a table for four this Friday between 7 and 8 PM',
        facts: [
          { key: 'party', label: 'Party size', value: '4', spoken: 'Four people.', aliases: ['how many guests', 'how many people', 'party size', 'how many'] },
          { key: 'date', label: 'Date', value: 'Friday, September 25', spoken: 'This Friday, September 25th.', aliases: ['what day', 'which day', 'what date', 'which date'] },
          { key: 'time', label: 'Preferred time', value: '7:00 PM', spoken: '7 PM, please.', aliases: ['what time'] },
          { key: 'name', label: 'Name', value: persona.name, spoken: persona.name, aliases: ['what name', 'name should i put', 'under what name', 'name for the reservation'] },
          { key: 'phone', label: 'Mobile', value: persona.mobile, aliases: ['mobile number', 'phone number', 'callback number'] },
          {
            key: 'requests',
            label: 'Special requests',
            value: "It's a birthday dinner",
            spoken: "Yes, it's a birthday dinner.",
            aliases: ['celebrating', 'special requests', 'any requests'],
          },
        ],
        policy: { discloseAI: true },
        prefs: { timeWindow: [19 * 60, 20 * 60], specialRequests: "It's a birthday dinner" },
        successNote: 'confirmation',
      },
      secrets: {},
    };
  },
};
