// The rules brain: a deterministic IVR navigator. It handles the common shapes
// of phone trees (menus, keypad entry, speech slots, verification, commit
// steps, retention offers, hold queues, live humans) with no model call. It is
// the fallback when the model is unavailable and the baseline the model must beat.

import {
  asksOpenQuestion,
  asksYesNo,
  extractConfirmation,
  formatTime,
  inputModality,
  lastSentence,
  looksLikeRetentionOffer,
  money,
  normalize,
  parseAmounts,
  parseTimes,
  sentences,
  wantsPound,
} from '../core/parse.js';
import { STANDARD_FACTS } from '../core/tasks.js';
import type { Decision, Fact, FailureReason, MenuOption, Task } from '../core/types.js';
import type { Brain, BrainState } from './brain.js';

const GLOBAL_HINTS: Record<string, number> = {
  english: 6,
  'español': -10,
  espanol: -10,
  'main menu': -5,
  'previous menu': -5,
  repeat: -3,
  'hang up': -10,
};

const HUMAN_ASKS = ['Representative.', 'Agent, please.', 'Speak to a representative.'];

export class RulesBrain implements Brain {
  readonly name = 'rules';

  async decide(s: BrainState): Promise<Decision> {
    return decideByRules(s);
  }
}

export function decideByRules(s: BrainState): Decision {
  const text = s.turn.join(' ');
  const last = lastSentence(text);
  const { task, analysis } = s;
  const hasDtmf = analysis.options.some((o) => o.via === 'dtmf');

  if (!text.trim()) return wait('Listening');
  if (analysis.kind === 'hold') return wait('On hold. Waiting for a human so you don’t have to.');
  if (analysis.kind === 'human' || s.speaker === 'human') return talkToHuman(s);
  if (analysis.kind === 'goodbye') {
    return s.notes.confirmation
      ? hangup('success', summaryFor(s), 'Got the confirmation, wrapping up')
      : wait('Call is wrapping up');
  }
  if (analysis.kind === 'commit') return commitStep(s);
  if (analysis.kind === 'confirm') return verifyStep(s);
  if (task.kind === 'pay_bill' && /\b(?:current|total|account|statement) balance is\b/i.test(text) && hasDtmf) {
    return balanceStep(s);
  }
  if (looksLikeRetentionOffer(text) && task.policy.declineRetentionOffers) {
    return say('No, thank you. Please continue with the cancellation.', 'Declining a retention offer, as you asked', false);
  }
  const offered = offeredTimes(text);
  if (task.prefs?.timeWindow && offered.length >= 2 && !/what time/i.test(last)) return pickTime(s, offered);

  // Did the IVR just ask for something we know?
  const fact = findRequestedFact(last, task.facts) ?? (inputModality(last) ? findRequestedFact(text, task.facts) : undefined);
  if (fact) {
    const modality = inputModality(last) ?? inputModality(text) ?? 'speech';
    if ((s.entered[fact.key] ?? 0) >= 2) {
      const refused = s.grants.some((g) => g.request.kind === 'input' && g.request.factKey === fact.key && !g.response.approved);
      if (refused) return escalate('dead_end', `${task.business} keeps rejecting the ${fact.label.toLowerCase()} on file`, 'The value on file is being rejected. Getting a person to look.');
      return {
        action: {
          type: 'ask_user',
          request: {
            kind: 'input',
            title: `${task.business} didn't accept your ${fact.label.toLowerCase()}`,
            detail: `It was rejected twice. Enter it again? ${fact.secret ? 'It goes straight to the vault.' : ''}`.trim(),
            secret: fact.secret,
            factKey: fact.key,
            factLabel: fact.label,
            aliases: fact.aliases,
          },
        },
        reason: `The IVR rejected the ${fact.label.toLowerCase()} twice. Asking you to check it.`,
        source: 'rules',
      };
    }
    if (modality === 'dtmf') {
      const digits = fact.secret || /^\d+$/.test(fact.value ?? '') ? `{{${fact.key}}}` : undefined;
      if (digits) {
        return {
          action: { type: 'press', digits: digits + (wantsPound(text) ? '#' : '') },
          reason: `Entering ${fact.label.toLowerCase()}${fact.secret ? ' from the vault' : ''}`,
          source: 'rules',
          cacheable: true,
        };
      }
    }
    const spoken = fact.spoken ?? fact.value ?? (fact.secret ? `{{${fact.key}}}` : undefined);
    if (spoken) return say(spoken, `Answering: ${fact.label.toLowerCase()}`, true);
  }

  // The IVR wants something we don't have on file (often an identity check).
  if (!fact && (analysis.kind === 'input' || (isVerification(last) && inputModality(last)))) return missingInfo(s, last);

  // Open question ("How can I help?"), possibly with suggested phrases.
  if (asksOpenQuestion(text)) {
    const speech = analysis.options.filter((o) => o.via === 'speech');
    if (task.kind === 'reach_human' && s.counters.escalations > 0) return askForHuman(s);
    const best = bestOption(task, speech);
    if (best && best.score > 0) return say(capitalize(best.option.label), `Saying "${best.option.label}"`, true);
    if (task.kind === 'reach_human') {
      s.counters.escalations += 1;
      return say(task.intentPhrase, 'Stating the reason, so we get routed to the right queue', true);
    }
    return say(task.intentPhrase, 'Stating what you need', true);
  }

  if (asksYesNo(last)) return yesNo(s, text);

  if (analysis.options.length) {
    const best = bestOption(task, analysis.options);
    if (best && best.score > 0) {
      const o = best.option;
      return o.via === 'dtmf'
        ? { action: { type: 'press', digits: o.key }, reason: `Pressing ${o.key}: "${o.label}"`, source: 'rules', cacheable: true }
        : say(capitalize(o.label), `Saying "${o.label}"`, true);
    }
    if (task.kind === 'reach_human' && analysis.options.some((o) => o.key === '0')) {
      return { action: { type: 'press', digits: '0' }, reason: 'No option fits, asking for an operator', source: 'rules', cacheable: true };
    }
    if (s.counters.silences < 2) return wait('No option matches the goal. Waiting for more options.');
  }

  if (s.counters.silences >= 2) {
    if (task.kind === 'reach_human' && s.counters.escalations < 4) return askForHuman(s);
    return escalate('dead_end', `Nothing on "${analysis.title}" leads to the goal`, 'No option fits. Getting a person to look.');
  }
  return wait('Listening for the rest of the prompt');
}

const VERIFY = /\b(?:verify|verification|for your security|social security|date of birth|last four|passcode|security question|maiden name)\b/i;

function isVerification(text: string): boolean {
  return VERIFY.test(text);
}

/** Ask the user for information the task doesn't have; if they can't give it, escalate. */
function missingInfo(s: BrainState, prompt: string): Decision {
  const t = normalize(prompt);
  const std = Object.entries(STANDARD_FACTS).find(([, f]) => f.aliases.some((a) => t.includes(a)));
  const phrase = s.analysis.title.replace(/^Enter\s+/i, '').toLowerCase();
  const key = std?.[0] ?? `asked.${phrase.replace(/[^a-z0-9]+/g, '_').slice(0, 32)}`;
  const label = std?.[1].label ?? phrase;
  const verification = isVerification(prompt);
  const refused = s.grants.some((g) => g.request.kind === 'input' && g.request.factKey === key && !g.response.approved);
  if (refused) {
    return escalate(
      verification ? 'identity_check' : 'dead_end',
      `${s.task.business} asks for ${label.toLowerCase()}, and it isn't on file`,
      'You couldn’t provide it. Getting a person to look.',
    );
  }
  return {
    action: {
      type: 'ask_user',
      request: {
        kind: 'input',
        title: `${s.task.business} is asking for your ${label.toLowerCase()}`,
        detail: `“${prompt}” It isn’t on file. ${verification || std?.[1].secret ? 'It goes straight to the vault; the model never sees it.' : ''}`.trim(),
        secret: std?.[1].secret ?? verification,
        factKey: key,
        factLabel: label,
        aliases: std?.[1].aliases ?? [phrase],
      },
    },
    reason: verification ? 'Identity check I can’t answer from what’s on file. Asking you.' : 'The IVR wants something that isn’t on file. Asking you.',
    source: 'rules',
  };
}

function escalate(reason: FailureReason, detail: string, why: string): Decision {
  return { action: { type: 'escalate', reason, detail }, reason: why, source: 'rules' };
}

// ---------------------------------------------------------------------------

function commitStep(s: BrainState): Decision {
  const text = s.turn.join(' ');
  const { task } = s;
  const CONFIRM = /\b(?:authorize|confirm|submit|complete|yes)\b/i;
  const confirmKey = optionKey(s, CONFIRM);
  const cancelKey = s.analysis.options.find((o) => o.via === 'dtmf' && /\b(?:cancel|keep|no|go back)\b/i.test(o.label) && !CONFIRM.test(o.label))?.key;
  const declined = s.grants.find((g) => !g.response.approved && g.request.kind !== 'input');

  if (declined) {
    return cancelKey
      ? { action: { type: 'press', digits: cancelKey }, reason: 'You declined, so backing out', source: 'guard' }
      : hangup('failure', 'You declined the final step, so nothing was committed.', 'Hanging up without committing');
  }

  if (task.kind === 'pay_bill') {
    const auth = task.policy.payment;
    const amounts = parseAmounts(text);
    const fee = amountAfter(text, /\bfee\b/i) ?? 0;
    const total = amountAfter(text, /\btotal\b/i) ?? (amounts[0] ?? 0) + fee;
    const base = amounts[0] ?? total - fee;
    const approved = s.grants.some(
      (g) => g.response.approved && g.request.kind === 'approve_payment' && g.request.amount + g.request.fee >= total - 0.001,
    );
    const withinAuth = auth && base <= auth.maxAmount && fee <= auth.maxFee;
    if (!confirmKey) return wait('Waiting for the authorization option');
    if (approved || withinAuth) {
      return {
        action: { type: 'press', digits: confirmKey },
        reason: approved ? `You approved ${money(total)}. Authorizing.` : `${money(total)} is within your pre-approval. Authorizing.`,
        source: 'rules',
        notes: { paid: money(total) },
      };
    }
    if (!auth) return ask(s, 'Authorize payment?', `${task.business} wants ${money(total)}. You haven't pre-approved a payment.`);
    return {
      action: {
        type: 'ask_user',
        request: {
          kind: 'approve_payment',
          title: fee > auth.maxFee ? `${task.business} adds a ${money(fee)} fee` : `Approve ${money(total)}?`,
          detail:
            fee > auth.maxFee
              ? `Balance ${money(base)} + ${money(fee)} card fee = ${money(total)} on ${auth.cardLabel}. You pre-approved the balance but not a fee.`
              : `${money(total)} is above your ${money(auth.maxAmount)} limit.`,
          amount: base,
          fee,
          cardLabel: auth.cardLabel,
        },
      },
      reason: fee > auth.maxFee ? `Unapproved ${money(fee)} fee. Asking you before committing.` : 'Amount is over your limit. Asking you.',
      source: 'rules',
    };
  }

  // Cancellations and other irreversible steps.
  const feeMentioned = /\b(?:cancellation|early termination|closing)\s+fee\b/i.test(text);
  const approved = s.grants.some((g) => g.response.approved);
  if (confirmKey && (approved || (task.policy.authorizedCommit && !feeMentioned))) {
    return {
      action: { type: 'press', digits: confirmKey },
      reason: approved ? 'You approved. Confirming.' : 'You authorized this when you started the task. Confirming.',
      source: 'rules',
    };
  }
  if (!confirmKey) return wait('Waiting for the confirmation option');
  return ask(s, 'Confirm this step?', `${task.business} says: "${lastSentence(text)}"`);
}

function verifyStep(s: BrainState): Decision {
  const text = normalize(s.turn.join(' '));
  const facts = s.task.facts.filter((f) => ['name', 'address', 'party', 'date', 'phone'].includes(f.key) && f.value);
  const heard = facts.filter((f) => {
    const v = normalize(f.value!);
    const surname = v.split(' ').slice(-1)[0];
    return text.includes(v) || (f.key === 'name' && text.includes(surname)) || (f.key === 'address' && text.includes(v.split(' ')[0]));
  });
  const yes = optionKey(s, /\b(?:correct|right|yes)\b/i);
  const no = optionKey(s, /\b(?:otherwise|incorrect|no)\b/i);
  const mentionsSomethingWeKnow = /\b(?:account|name|address|for)\b/i.test(text);
  if (heard.length > 0 || !mentionsSomethingWeKnow) {
    if (yes) return { action: { type: 'press', digits: yes }, reason: `Details match (${heard.map((f) => f.label).join(', ') || 'as entered'})`, source: 'rules' };
    return say('Yes, that’s correct.', 'Confirming the details', false);
  }
  if (no) return { action: { type: 'press', digits: no }, reason: 'Those details don’t match yours', source: 'rules' };
  return say('No, that’s not correct.', 'Those details don’t match yours', false);
}

function balanceStep(s: BrainState): Decision {
  const text = s.turn.join(' ');
  const auth = s.task.policy.payment;
  const balance = parseAmounts(text)[0];
  const notes = balance !== undefined ? { balance: money(balance) } : undefined;
  const fullKey = optionKey(s, /\b(?:full|entire|total|whole) (?:balance|amount)\b/i) ?? optionKey(s, /\bpay\b/i);
  const approved = s.grants.some((g) => g.response.approved && g.request.kind === 'approve_payment');
  if (balance === undefined || !fullKey) return { ...decideByRules({ ...s, task: { ...s.task, kind: 'reach_human' } }), source: 'rules' };
  if (approved || (auth && balance <= auth.maxAmount)) {
    return {
      action: { type: 'press', digits: fullKey },
      reason: `Balance is ${money(balance)}${auth ? `, within your ${money(auth.maxAmount)} limit` : ''}. Paying in full.`,
      source: 'rules',
      notes,
    };
  }
  return {
    action: {
      type: 'ask_user',
      request: {
        kind: 'approve_payment',
        title: `Pay ${money(balance)}?`,
        detail: auth ? `The balance is above your ${money(auth.maxAmount)} limit.` : 'You have not pre-approved a payment.',
        amount: balance,
        fee: 0,
        cardLabel: auth?.cardLabel ?? 'your card',
      },
    },
    reason: 'Balance is over your limit. Asking you.',
    source: 'rules',
    notes,
  };
}

function pickTime(s: BrainState, offered: number[]): Decision {
  const [lo, hi] = s.task.prefs!.timeWindow!;
  const inWindow = offered.filter((t) => t >= lo && t <= hi);
  if (inWindow.length) {
    const t = inWindow[0];
    return say(`${formatTime(t)}, please.`, `${formatTime(t)} fits your ${formatTime(lo)}–${formatTime(hi)} window`, false, { time: formatTime(t) });
  }
  const choice = s.grants.find((g) => g.request.kind === 'choose' && g.response.choice)?.response.choice;
  if (choice) return say(`${choice}, please.`, `You picked ${choice}`, false, { time: choice });
  return {
    action: {
      type: 'ask_user',
      request: {
        kind: 'choose',
        title: 'None of the times fit your window',
        detail: `${s.task.business} offered ${offered.map(formatTime).join(' or ')}.`,
        options: offered.map(formatTime),
      },
    },
    reason: 'Offered times are outside your window. Asking you.',
    source: 'rules',
  };
}

function yesNo(s: BrainState, text: string): Decision {
  const { task } = s;
  if (task.kind === 'reach_human') {
    s.counters.escalations += 1;
    return say('No, thanks. I need to speak with a representative.', 'Declining self-service and asking for a person', true);
  }
  if (looksLikeRetentionOffer(text)) return say('No, thank you.', 'Declining the offer', false);
  if (/\b(?:is (?:this|that) (?:correct|right)|did you say)\b/i.test(text)) return say('Yes.', 'Confirming', false);
  if (/\b(?:anything else|something else|another)\b/i.test(text)) return say('No, that’s all. Thank you.', 'Nothing else needed', false);
  return say('No, thank you.', 'Declining something you didn’t ask for', false);
}

function askForHuman(s: BrainState): Decision {
  const n = s.counters.escalations;
  s.counters.escalations += 1;
  if (n >= HUMAN_ASKS.length + 1) return escalate('dead_end', 'The phone tree won’t transfer to a person', 'Can’t get past the deflection. Getting a person to look.');
  if (n >= HUMAN_ASKS.length && s.analysis.options.some((o) => o.key === '0')) {
    return { action: { type: 'press', digits: '0' }, reason: 'Pressing 0 for an operator', source: 'rules' };
  }
  return say(HUMAN_ASKS[Math.min(n, HUMAN_ASKS.length - 1)], 'Asking for a person', true);
}

function talkToHuman(s: BrainState): Decision {
  const { task } = s;
  const text = s.turn.join(' ');
  s.counters.humanTurns += 1;
  const rep = /\b(?:this is|my name is|i'?m)\s+([A-Z][a-z]+)/.exec(text)?.[1];
  const notes = rep ? { rep } : undefined;
  const first = task.user.firstName;

  const agreed =
    /\b(?:go ahead|sure|of course|okay|ok|absolutely|yes)\b[^.?!]*\b(?:connect|conference|bring|put)\b/i.test(text) ||
    /\b(?:go ahead and|please) (?:connect|bring|put)\b/i.test(text) ||
    /\bi'?ll (?:hold|wait|stay on)\b/i.test(text);
  if (agreed || s.counters.humanTurns > 4) {
    return {
      action: { type: 'handoff', briefing: briefing(s, rep) },
      reason: agreed ? `${rep ?? s.notes.rep ?? 'The rep'} is ready. Handing the call to you.` : 'Handing off rather than going in circles',
      source: 'rules',
      notes,
    };
  }

  if (s.counters.humanTurns === 1) {
    const intro = task.policy.discloseAI
      ? `Hi${rep ? ` ${rep}` : ''}, I'm Voiced, an AI assistant calling on behalf of the account holder, ${task.user.name}.`
      : `Hi${rep ? ` ${rep}` : ''}, I'm calling on behalf of ${task.user.name}.`;
    const ask = task.policy.handoffToUser ? ` ${first} is standing by. Can I connect them to you now?` : '';
    const recorded = task.policy.recorded ? ' This call is being recorded.' : '';
    return say(`${intro}${recorded} ${first} ${task.purpose}.${ask}`, 'Disclosing that I’m an AI, stating the purpose, offering a handoff', false, notes);
  }

  if (/\b(?:social security|ssn|last four|date of birth|security question|pin|passcode|verify)\b/i.test(text)) {
    return say(`${first} can verify that directly. Can I connect them now?`, 'Verification needs the account holder. Not sharing secrets with a person.', false, notes);
  }
  const fact = findRequestedFact(text, task.facts.filter((f) => !f.secret));
  if (fact?.value) return say(fact.spoken ?? fact.value, `Answering: ${fact.label.toLowerCase()}`, false, notes);
  return say(`${first} is on standby and can take it from here. Can I connect them?`, 'Offering the handoff', false, notes);
}

function briefing(s: BrainState, rep?: string): string {
  const name = rep ?? s.notes.rep;
  const holdMin = s.notes.hold ? ` after ${s.notes.hold} on hold` : '';
  return `You're connected with ${name ?? 'a live rep'} at ${s.task.business}${holdMin}. They know you ${s.task.purpose}. I told them I'm an AI assistant and didn't share any account secrets.`;
}

function summaryFor(s: BrainState): string {
  const conf = s.notes.confirmation ?? extractConfirmation(s.turn.join(' '));
  switch (s.task.kind) {
    case 'pay_bill':
      return `Paid ${s.notes.paid ?? s.notes.balance ?? 'the balance'} to ${s.task.business}${s.task.policy.payment ? ` with ${s.task.policy.payment.cardLabel}` : ''}. Confirmation ${conf}.`;
    case 'cancel':
      return `${s.task.business} membership canceled, retention offers declined. Confirmation ${conf}.`;
    case 'reservation':
      return `Booked ${s.task.business}${s.notes.time ? ` for ${s.notes.time}` : ''} (${s.task.title.replace(/^Book /, '')}). Confirmation ${conf}.`;
    default:
      return `Done. Reference ${conf}.`;
  }
}

// ---------------------------------------------------------------------------

export function findRequestedFact(text: string, facts: Fact[]): Fact | undefined {
  const t = normalize(text);
  let best: { fact: Fact; len: number } | undefined;
  for (const fact of facts) {
    for (const alias of fact.aliases) {
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(t) && (!best || alias.length > best.len)) best = { fact, len: alias.length };
    }
  }
  return best?.fact;
}

/** Times on offer, ignoring ones described as taken ("7 PM is fully booked"). */
export function offeredTimes(text: string): number[] {
  return sentences(text)
    .filter((s) => !/\b(?:booked|unavailable|not available|full|sold out|taken)\b/i.test(s))
    .flatMap((s) => parseTimes(s));
}

export function scoreOption(task: Task, label: string): number {
  const l = normalize(label);
  const hints = { ...GLOBAL_HINTS, ...task.navHints };
  const matched = Object.keys(hints)
    .filter((h) => l.includes(h))
    .sort((a, b) => b.length - a.length);
  const counted: string[] = [];
  for (const h of matched) if (!counted.some((c) => c.includes(h))) counted.push(h);
  return counted.reduce((sum, h) => sum + hints[h], 0);
}

function bestOption(task: Task, options: MenuOption[]): { option: MenuOption; score: number } | undefined {
  let best: { option: MenuOption; score: number } | undefined;
  for (const option of options) {
    const score = scoreOption(task, option.label);
    if (!best || score > best.score) best = { option, score };
  }
  return best;
}

function optionKey(s: BrainState, re: RegExp): string | undefined {
  return s.analysis.options.find((o) => o.via === 'dtmf' && re.test(o.label))?.key;
}

function amountAfter(text: string, word: RegExp): number | undefined {
  for (const sentence of sentences(text)) {
    const idx = sentence.search(word);
    if (idx === -1) continue;
    const amounts = parseAmounts(sentence.slice(idx));
    if (amounts.length) return amounts[0];
  }
  return undefined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function wait(reason: string): Decision {
  return { action: { type: 'wait' }, reason, source: 'rules' };
}

function say(text: string, reason: string, cacheable: boolean, notes?: Record<string, string>): Decision {
  return { action: { type: 'say', text }, reason, source: 'rules', cacheable, notes };
}

function hangup(outcome: 'success' | 'failure', summary: string, reason: string): Decision {
  return { action: { type: 'hangup', outcome, summary }, reason, source: 'rules' };
}

function ask(s: BrainState, title: string, detail: string): Decision {
  return { action: { type: 'ask_user', request: { kind: 'approve', title, detail } }, reason: 'Needs your call', source: 'rules' };
}

export { summaryFor };
