// Prompt and output handling shared by every model-backed brain (the Claude API
// on the server, the artifact's in-page Claude sampling in the browser).

import { formatTime, money } from '../core/parse.js';
import type { Action, Decision, TurnKind, UserRequest } from '../core/types.js';
import type { BrainState } from './brain.js';

export const SYSTEM_PROMPT = `You are Voiced, an AI agent that navigates phone trees (IVRs) for a user. You are on a live phone call. Each request shows the call so far and the prompt the far end just finished. Choose your single next action.

How the call works:
- You hear the far end as transcribed text. Recorded menus sound like "For billing, press 2" or "You can say 'reservations'".
- Act with exactly one tool call: press_keys (DTMF tones), say (speech), wait, ask_user, handoff_to_user, or end_call.
- Prefer the keypad when a prompt accepts it. Press only what the prompt asks for. Add "#" only when it says "followed by the pound key".
- Speak like a caller talking to a speech system: short and literal ("Pay my bill", "Four people", "7 PM, please").

Secrets:
- You never see card numbers, account numbers, PINs or security codes. Secret facts appear as {{key}} placeholders. Put the placeholder in press_keys (for example "{{card.number}}#") and the runtime fills in the real digits. Never guess, spell out or invent secret values. Never read a secret to a live person.

Policy (also enforced in code, so don't try to work around it):
- Money: pay only within the pre-approval (max amount and max fee). If the IVR discloses an amount or fee beyond it, call ask_user with kind "approve_payment" (amount and fee filled in) before pressing the confirm key.
- Irreversible steps (cancellations, purchases) go ahead only when the task marks them authorized. Otherwise ask_user.
- Retention offers: decline them when the task says so.
- On hold: wait. Never hang up on a hold queue.
- Live humans: when a person answers (introduces themselves by name, asks who they're speaking with), say you're an AI assistant calling for the user and state the purpose in one or two sentences. If the task says to hand off, ask whether you can connect the user, then call handoff_to_user once they agree. Don't share secrets or make commitments with people.
- When you hear the confirmation or reference number that completes the goal, call end_call with outcome "success" and a one-line summary that includes it.
- If the same prompt keeps repeating or rejecting you, try asking for a representative ("Representative." or pressing 0). If that fails, handoff_to_user with a briefing.

Write "reason" as one short sentence the user reads in a live transcript. This is latency-sensitive: decide quickly.`;

export function renderContext(s: BrainState): string {
  const { task } = s;
  const pay = task.policy.payment;
  const lines: string[] = [
    `TASK: ${task.title}`,
    `GOAL: ${task.goal}`,
    `BUSINESS: ${task.business} (${task.phone})`,
    `USER: ${task.user.name}`,
    `PRE-APPROVED PAYMENT: ${pay ? `up to ${money(pay.maxAmount)} plus fees up to ${money(pay.maxFee)}, card ${pay.cardLabel}` : 'none'}`,
    `IRREVERSIBLE STEP AUTHORIZED: ${task.policy.authorizedCommit ? 'yes' : 'no'}`,
    `DECLINE RETENTION OFFERS: ${task.policy.declineRetentionOffers ? 'yes' : 'no'}`,
    `HAND OFF TO USER WHEN A HUMAN ANSWERS: ${task.policy.handoffToUser ? 'yes' : 'no'}`,
    `DISCLOSE YOU ARE AN AI TO HUMANS: ${task.policy.discloseAI ? 'yes' : 'no'}`,
  ];
  if (task.prefs?.timeWindow) {
    lines.push(`ACCEPTABLE TIME WINDOW: ${formatTime(task.prefs.timeWindow[0])} to ${formatTime(task.prefs.timeWindow[1])}`);
  }
  lines.push(`WHAT TO SAY AT "HOW CAN I HELP": ${task.intentPhrase}`);
  lines.push('', 'FACTS (use {{key}} for secrets):');
  for (const f of task.facts) {
    lines.push(
      f.secret
        ? `- ${f.key}: ${f.label} = SECRET, use {{${f.key}}} (${f.display ?? 'hidden'})`
        : `- ${f.key}: ${f.label} = ${f.value}${f.spoken && f.spoken !== f.value ? ` (say: "${f.spoken}")` : ''}`,
    );
  }
  if (s.grants.length) {
    lines.push('', 'USER DECISIONS ON THIS CALL:');
    for (const g of s.grants) {
      lines.push(`- ${g.response.approved ? 'APPROVED' : 'DECLINED'}: ${g.request.title}${describeRequest(g.request)}${g.response.choice ? `, chose ${g.response.choice}` : ''}`);
    }
  }
  if (Object.keys(s.notes).length) lines.push('', `NOTES: ${Object.entries(s.notes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (s.mapHint) lines.push('', `IVR MAP: ${s.mapHint}`);
  const recent = s.history.slice(-24, -s.turn.length || undefined);
  if (recent.length) {
    lines.push('', 'CALL SO FAR (oldest first):');
    for (const h of recent) if (!(h.who === 'hold' && h.text.startsWith('♪'))) lines.push(`${h.who.toUpperCase()}: ${h.text}`);
  }
  lines.push('', `THE ${s.speaker === 'human' ? 'PERSON' : 'IVR'} JUST SAID (the line is now quiet, waiting for you):`);
  lines.push(s.turn.join(' ') || '(nothing new)');
  if (s.analysis.options.length) {
    lines.push(`Parsed options: ${s.analysis.options.map((o) => (o.via === 'dtmf' ? `press ${o.key} = ${o.label}` : `say "${o.label}"`)).join('; ')}`);
  }
  if (s.counters.silences > 1) lines.push(`You have let this prompt play ${s.counters.silences - 1} time(s) without acting.`);
  return lines.join('\n');
}

function describeRequest(r: UserRequest): string {
  return r.kind === 'approve_payment' ? ` (${money(r.amount)} + ${money(r.fee)} fee)` : '';
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const reason = { type: 'string', description: 'One short sentence for the live transcript.' };

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'press_keys',
    description: 'Send DTMF keypad tones: menu choices and keypad entry. May contain {{key}} placeholders for facts.',
    input_schema: { type: 'object', properties: { digits: { type: 'string' }, reason }, required: ['digits', 'reason'] },
  },
  {
    name: 'say',
    description: 'Speak a short phrase to a speech-recognition IVR or a live person.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, reason }, required: ['text', 'reason'] },
  },
  {
    name: 'wait',
    description: 'Keep listening without acting: the prompt is still going, you are on hold, or nothing on offer fits yet.',
    input_schema: { type: 'object', properties: { reason }, required: ['reason'] },
  },
  {
    name: 'ask_user',
    description:
      'Pause and ask the user. Required before paying beyond the pre-approval, accepting unapproved fees, or making an irreversible choice the task did not authorize.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['approve', 'approve_payment', 'choose'] },
        title: { type: 'string', description: 'Push-notification title, under 60 characters.' },
        detail: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'For kind=choose.' },
        amount: { type: 'number', description: 'For kind=approve_payment: the amount before fees.' },
        fee: { type: 'number', description: 'For kind=approve_payment: the fee, 0 if none.' },
        reason,
      },
      required: ['kind', 'title', 'detail', 'reason'],
    },
  },
  {
    name: 'handoff_to_user',
    description: 'Bridge the user into the call now (warm transfer). Use when a live person is ready for them, or when you are stuck.',
    input_schema: {
      type: 'object',
      properties: { briefing: { type: 'string', description: 'What the user needs to know as they join, 1-2 sentences.' }, reason },
      required: ['briefing', 'reason'],
    },
  },
  {
    name: 'end_call',
    description: 'Hang up. Use after the goal is confirmed (include the confirmation number) or when it cannot be completed.',
    input_schema: {
      type: 'object',
      properties: { outcome: { type: 'string', enum: ['success', 'failure'] }, summary: { type: 'string' }, reason },
      required: ['outcome', 'summary', 'reason'],
    },
  },
];

const CACHEABLE_KINDS: TurnKind[] = ['menu', 'input', 'question', 'info'];

/** Validate a model's tool call and turn it into a Decision. Throws on anything malformed. */
export function toDecision(name: string, input: Record<string, unknown>, s: BrainState): Decision {
  const str = (k: string) => {
    const v = input[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${name}: missing ${k}`);
    return v.trim();
  };
  const why = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : name.replace('_', ' ');
  let action: Action;
  switch (name) {
    case 'press_keys':
      action = { type: 'press', digits: str('digits').replace(/\s+/g, '') };
      break;
    case 'say':
      action = { type: 'say', text: str('text') };
      break;
    case 'wait':
      action = { type: 'wait' };
      break;
    case 'ask_user': {
      const kind = str('kind');
      const title = str('title');
      const detail = str('detail');
      if (kind === 'approve_payment') {
        const pay = s.task.policy.payment;
        action = {
          type: 'ask_user',
          request: {
            kind: 'approve_payment',
            title,
            detail,
            amount: Number(input.amount ?? 0),
            fee: Number(input.fee ?? 0),
            cardLabel: pay?.cardLabel ?? 'your card',
          },
        };
      } else if (kind === 'choose' && Array.isArray(input.options) && input.options.length) {
        action = { type: 'ask_user', request: { kind: 'choose', title, detail, options: input.options.map(String) } };
      } else action = { type: 'ask_user', request: { kind: 'approve', title, detail } };
      break;
    }
    case 'handoff_to_user':
      action = { type: 'handoff', briefing: str('briefing') };
      break;
    case 'end_call': {
      const outcome = str('outcome');
      action = { type: 'hangup', outcome: outcome === 'success' ? 'success' : 'failure', summary: str('summary') };
      break;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
  const cacheable =
    (action.type === 'press' || action.type === 'say') && s.speaker === 'ivr' && CACHEABLE_KINDS.includes(s.analysis.kind);
  return { action, reason: why, source: 'llm', cacheable };
}

/** JSON-output variant of the tool list, for runtimes without tool use. */
export const JSON_INSTRUCTIONS = `Reply with ONLY one JSON object naming your action, for example:
{"tool": "press_keys", "digits": "2", "reason": "Billing is option 2"}
Allowed "tool" values and their fields:
- press_keys: digits, reason
- say: text, reason
- wait: reason
- ask_user: kind ("approve" | "approve_payment" | "choose"), title, detail, options (for choose), amount and fee (for approve_payment), reason
- handoff_to_user: briefing, reason
- end_call: outcome ("success" | "failure"), summary, reason`;
