// Text heuristics for understanding IVR prompts. These power the rules brain,
// the turn analysis shown in the UI, and the policy guard that sits in front of
// the model. They are deliberately conservative: when unsure, return nothing.

import type { MenuOption, TurnAnalysis, TurnKind } from './types.js';

const WORD_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', star: '*', pound: '#', hash: '#',
  dos: '2', uno: '1', tres: '3', nueve: '9', cero: '0',
};

export function keyFromWord(word: string): string | undefined {
  const w = word.toLowerCase().replace(/[^a-z0-9*#]/g, '');
  if (/^[0-9*#]$/.test(w)) return w;
  return WORD_DIGITS[w];
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a prompt into sentences, keeping quoted phrases intact. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+(?=[A-Z0-9¿¡"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const KEY = String.raw`(\d|\*|#|zero|one|two|three|four|five|six|seven|eight|nine|star|pound|hash|dos|uno|tres|nueve|cero)`;
const LABEL = String.raw`([^.;:?!]+?)`;

/** Parse "For billing, press 2" / "Press 2 for billing" / "say 'billing'" style options. */
export function parseMenuOptions(text: string): MenuOption[] {
  const out: MenuOption[] = [];
  const seen = new Set<string>();
  const add = (key: string | undefined, label: string, via: 'dtmf' | 'speech') => {
    if (!key && via === 'dtmf') return;
    const cleaned = label
      .replace(/^(?:please|you can|or|and)\s+/i, '')
      .replace(/\s+(?:please|now)$/i, '')
      .replace(/^(?:for|to)\s+/i, '')
      .trim();
    if (!cleaned) return;
    const k = via === 'dtmf' ? key! : cleaned.toLowerCase();
    const id = `${via}:${k}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key: k, label: cleaned, via });
  };

  for (const s of sentences(text)) {
    // "For billing and payments, press 2." / "To make a payment, press 1." / "If this is correct, press 1."
    const labelFirst = new RegExp(
      String.raw`(?:^|[,.]\s*|\b)(?:for|to|if|otherwise|para)\s*${LABEL},?\s+(?:please\s+)?(?:press|dial|enter|oprima(?:\s+el)?)\s+${KEY}\b`,
      'gi',
    );
    let m: RegExpExecArray | null;
    let matched = false;
    while ((m = labelFirst.exec(s))) {
      const lead = m[0].trim().toLowerCase();
      const label = lead.startsWith('otherwise') ? 'otherwise' : m[1];
      add(keyFromWord(m[2]), label, 'dtmf');
      matched = true;
    }
    // "Otherwise, press 2."
    const otherwise = /\botherwise,?\s+press\s+(\w+)/i.exec(s);
    if (otherwise && !matched) add(keyFromWord(otherwise[1]), 'otherwise', 'dtmf');
    // "Press 1 for English" / "Press 0 to speak with a representative"
    const keyFirst = new RegExp(String.raw`\bpress\s+${KEY}\s+(?:for|to)\s+${LABEL}(?=[.;,?!]|$)`, 'gi');
    while ((m = keyFirst.exec(s))) add(keyFromWord(m[1]), m[2], 'dtmf');
    // Speech options: "You can say things like 'make a reservation', 'hours', or 'catering'."
    if (/\bsay\b/i.test(s)) {
      const quoted = s.match(/['"‘“]([^'"’”]{2,40})['"’”]/g) ?? [];
      for (const q of quoted) add(undefined, q.slice(1, -1), 'speech');
    }
  }
  return out;
}

/** Numbers like "$142.17" → 142.17. Returns every amount in order. */
export function parseAmounts(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
}

/** "7:45 PM", "6 p.m." → minutes since midnight. */
export function parseTimes(text: string): number[] {
  const out: number[] = [];
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase().startsWith('p')) h += 12;
    out.push(h * 60 + Number(m[2] ?? 0));
  }
  return out;
}

export function formatTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${h24 >= 12 ? 'PM' : 'AM'}`;
}

/** "Your confirmation number is 8 4 7 2 1 9." → "847219". Letters and dashes are collapsed. */
export function extractConfirmation(text: string): string | undefined {
  const m =
    /(?:confirmation|reference|ticket|case)\s+(?:number|code|#)\s+(?:is\s+)?([A-Z0-9](?:[A-Z0-9]|[\s-](?=[A-Z0-9])){3,30})/i.exec(
      text,
    );
  if (!m) return undefined;
  const code = m[1].replace(/[\s-]/g, '').toUpperCase();
  return /\d/.test(code) ? code : undefined;
}

const HUMAN_PATTERNS = [
  /\bmy name is [A-Z][a-z]+/,
  /\bthis is [A-Z][a-z]+ (?:with|from|in|on)\b/,
  /\bwho (?:am i|do i have the pleasure of) speaking\b/i,
  /\bthanks? (?:you )?for (?:holding|waiting)\b[^.]*\b(?:this is|my name is|i'?m) [A-Z]/,
];

/** Recorded IVR voices rarely introduce themselves by first name or ask who they're speaking with. */
export function looksHuman(text: string): boolean {
  if (/\b(?:virtual|automated|digital) (?:assistant|agent|host)\b/i.test(text)) return false;
  return HUMAN_PATTERNS.some((re) => re.test(text));
}

export function looksLikeHold(text: string): boolean {
  return /\b(?:please (?:continue to )?hold|estimated wait|all of our (?:representatives|agents|associates)|next available|your call is important|remain on the line|in the queue|while you wait)\b/i.test(
    text,
  );
}

export function looksLikeGoodbye(text: string): boolean {
  return /\b(?:goodbye|good-bye|thank you for calling[^.]*\.\s*$)/i.test(text.trim());
}

export function looksLikeInvalid(text: string): boolean {
  return /\b(?:not a valid|invalid|didn'?t (?:get|hear|understand|catch)|not recognized|was not found|couldn'?t find|try again|option is (?:temporarily )?unavailable)\b/i.test(
    text,
  );
}

/** Prompts that commit money or an irreversible change. These are policy-gated. */
export function looksLikeCommit(text: string): boolean {
  return /\b(?:authorize (?:this|the) payment|to (?:confirm|submit|complete) (?:this |the |your )?(?:payment|cancellation|purchase|order)|confirm (?:your|the) cancellation|you are about to (?:pay|cancel|purchase))\b/i.test(
    text,
  );
}

/** "I found an account for J. Lee at 320 Sycamore..." "If this is correct, press 1." */
export function looksLikeVerification(text: string): boolean {
  return /\b(?:if (?:this|that) is correct|is (?:this|that) (?:correct|right)|did you say|i heard)\b/i.test(text);
}

export function looksLikeRetentionOffer(text: string): boolean {
  return /\b(?:before you go|we'?d hate to see you go|special offer|instead of cancel|how about|would you (?:like|consider) (?:to )?(?:freez|pause|stay|keep))/i.test(
    text,
  );
}

export function asksYesNo(text: string): boolean {
  return /\b(?:say yes or no|yes or no)\b|\b(?:would you like|do you want|shall i)\b[^.]*\?|\bsay (?:'|")?yes(?:'|")?/i.test(text);
}

export function asksOpenQuestion(text: string): boolean {
  return /\b(?:how (?:can|may) i help|what (?:are you|is the reason (?:for|you'?re)) calling|tell me (?:briefly )?(?:what|why|in a few words)|in a few words|what can i help you with|what brings you|can you tell me (?:a (?:little|bit) )?more)\b/i.test(
    text,
  );
}

/** Where the prompt asks the caller to key in or say something. */
export function inputModality(text: string): 'dtmf' | 'speech' | undefined {
  const t = normalize(text);
  if (/\b(?:enter|key in|type|using your (?:telephone )?keypad|on your keypad|followed by the pound)\b/.test(t)) return 'dtmf';
  if (/\b(?:say|tell me|speak|what (?:date|day|time|name)|how many|can i (?:get|have)|may i have)\b/.test(t) || t.endsWith('?'))
    return 'speech';
  return undefined;
}

export function wantsPound(text: string): boolean {
  return /\bfollowed by (?:the )?(?:pound|hash)(?: key| sign)?\b/i.test(text);
}

/** A stable fingerprint of a prompt sentence: dynamic values are masked so the same menu matches across calls. */
export function fingerprint(sentence: string): string {
  return normalize(sentence)
    .replace(/\$\s?[\d,]+(?:\.\d+)?/g, '$#')
    .replace(/\b\d+(?::\d+)?(?:st|nd|rd|th)?\b/g, '#')
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/g, '#')
    .replace(/[^a-z#$ ']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Classify a completed IVR turn for the UI and the map. */
export function analyzeTurn(text: string, speaker: 'ivr' | 'human' | 'hold'): TurnAnalysis {
  const options = parseMenuOptions(text);
  let kind: TurnKind;
  if (speaker === 'hold' || looksLikeHold(text)) kind = 'hold';
  else if (speaker === 'human' || looksHuman(text)) kind = 'human';
  else if (looksLikeGoodbye(text)) kind = 'goodbye';
  else if (looksLikeCommit(text)) kind = 'commit';
  else if (looksLikeVerification(text)) kind = 'confirm';
  else if (options.filter((o) => o.via === 'dtmf').length >= 2) kind = 'menu';
  else if (inputModality(lastSentence(text)) === 'dtmf') kind = 'input';
  else if (options.length >= 2) kind = 'menu';
  else if (/\?\s*$/.test(text.trim()) || inputModality(lastSentence(text)) === 'speech') kind = 'question';
  else kind = 'info';
  return { kind, options, title: titleFor(kind, text, options) };
}

export function lastSentence(text: string): string {
  const all = sentences(text);
  return all[all.length - 1] ?? text;
}

function titleFor(kind: TurnKind, text: string, options: MenuOption[]): string {
  const last = lastSentence(text);
  switch (kind) {
    case 'menu': {
      if (options.some((o) => /english|español|espanol/i.test(o.label))) return 'Language menu';
      const first = sentences(text).find((s) => !looksLikeInvalid(s) && !/^returning to\b/i.test(s))?.replace(/[.!]$/, '') ?? '';
      const named = first.length < 44 && !/\b(?:press|say|enter)\b|^(?:thanks?|thank you|okay|welcome|hi)\b/i.test(first);
      if (named) return `${first} menu`.replace(/ menu menu$/i, ' menu');
      const labels = options.filter((o) => o.via === 'dtmf').map((o) => o.label);
      return labels.length ? truncate(`Menu: ${labels.slice(0, 2).join(' · ')}${labels.length > 2 ? ' · …' : ''}`, 60) : `Menu · ${options.length} options`;
    }
    case 'hold':
      return 'Hold queue';
    case 'human':
      return 'Live human';
    case 'commit':
      return 'Commit step';
    case 'confirm':
      return 'Verify details';
    case 'goodbye':
      return 'Wrap-up';
    case 'input': {
      const wanted = /\b(?:enter|key in)\s+(?:your\s+|the\s+|it\s+)?(?:(?:three or four|\w+)[\s-]digit\s+)?([^,.]+?)(?:,|\.|$|\s+(?:followed|using|starting|found|on your))/i.exec(last) ??
        /\b(?:enter|key in)\s+(?:your\s+|the\s+)?(?:(?:three or four|\w+)[\s-]digit\s+)?([^,.]+?)(?:,|\.|$|\s+(?:followed|using|starting|found|on your))/i.exec(text);
      if (wanted && !/^(?:it|on your)/i.test(wanted[1])) return `Enter ${truncate(wanted[1], 40)}`;
      const noun = /\b((?:mobile|phone|account|card|member|policy|confirmation)\s+(?:number|id))\b/i.exec(text);
      return noun ? `Enter ${noun[1]}` : 'Keypad entry';
    }
    default:
      return truncate(last, 64);
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}
