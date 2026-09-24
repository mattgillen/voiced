// The human fallback. When the agent is stuck (a dead end, a loop, a check it
// can't pass) the call and its full context go to an operator queue instead of
// failing. Operators act on the live call through the same vault and guard as
// the AI: they work with placeholders like {{account}} and never see secrets.
// What an operator does on an automated screen is learned into the IVR map, so
// the next call handles that exception without a person.

import type { HistoryItem } from '../brains/brain.js';
import type { FailureReason } from './types.js';

export interface EscalationTicket {
  id: string;
  callId: string;
  business: string;
  phone: string;
  task: string;
  goal: string;
  reason: FailureReason;
  detail: string;
  /** The screen or state where the AI got stuck. */
  step: string;
  /** Call time when it was escalated. */
  t: number;
  /** Redacted transcript tail. */
  transcript: HistoryItem[];
  /** Facts the operator may use, as placeholders; secrets show only their redacted form. */
  facts: { key: string; label: string; display: string }[];
  status: 'waiting' | 'active' | 'returned' | 'closed';
  openedAt: number;
  operator?: string;
  log: { at: number; operator: string; command: OperatorCommand }[];
}

export type OperatorCommand =
  /** DTMF; {{fact}} placeholders are filled from the vault. */
  | { type: 'press'; digits: string }
  | { type: 'say'; text: string }
  /** Bridge the customer in with a briefing. */
  | { type: 'handoff'; briefing: string }
  /** Give the call back to the AI. */
  | { type: 'return'; note?: string }
  /** Nothing more can be done: end the call as failed. */
  | { type: 'hangup'; summary: string };

/** What a session exposes to the operator holding its ticket. */
export interface OperatorControl {
  act(command: OperatorCommand, operator: string): Promise<void>;
}

export class OperatorQueue {
  private tickets = new Map<string, { ticket: EscalationTicket; control: OperatorControl }>();
  private openListeners = new Set<(t: EscalationTicket) => void>();

  open(ticket: EscalationTicket, control: OperatorControl) {
    this.tickets.set(ticket.id, { ticket, control });
    for (const fn of this.openListeners) fn(ticket);
  }

  /** Subscribe to new tickets (a console, a pager, or a scripted stand-in). */
  onOpen(fn: (t: EscalationTicket) => void): () => void {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }

  list(status?: EscalationTicket['status']): EscalationTicket[] {
    return [...this.tickets.values()].map((e) => e.ticket).filter((t) => !status || t.status === status);
  }

  get(id: string): EscalationTicket | undefined {
    return this.tickets.get(id)?.ticket;
  }

  async act(id: string, command: OperatorCommand, operator: string): Promise<EscalationTicket> {
    const entry = this.tickets.get(id);
    if (!entry) throw new Error(`No ticket ${id}`);
    const { ticket, control } = entry;
    if (ticket.status === 'closed' || ticket.status === 'returned') throw new Error(`Ticket ${id} is ${ticket.status}`);
    ticket.status = 'active';
    ticket.operator = operator;
    ticket.log.push({ at: Date.now(), operator, command });
    await control.act(command, operator);
    if (command.type === 'return') ticket.status = 'returned';
    if (command.type === 'hangup' || command.type === 'handoff') ticket.status = 'closed';
    return ticket;
  }

  /** The call ended on its own (e.g. the business hung up) while the ticket was open. */
  close(callId: string) {
    for (const { ticket } of this.tickets.values()) {
      if (ticket.callId === callId && ticket.status !== 'returned') ticket.status = 'closed';
    }
  }
}
