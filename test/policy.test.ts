// The TCPA line in code: Voiced calls businesses for users, never consumers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RulesBrain } from '../src/brains/rules.js';
import { MapMemory } from '../src/core/memory.js';
import type { Line } from '../src/core/types.js';
import { CallManager, HttpError } from '../src/server/calls.js';

function manager() {
  const dialed: string[] = [];
  const fakeLine = (task: { phone: string }): Line => {
    dialed.push(task.phone);
    return {
      simulated: false,
      dial: async () => {},
      next: async () => ({ kind: 'hangup', by: 'remote' }),
      sendDigits: async () => {},
      say: async () => {},
      bridge: async () => {},
      hangup: async () => {},
      now: () => 0,
      elapse: () => {},
    };
  };
  const calls = new CallManager({
    memory: new MapMemory(),
    brain: () => new RulesBrain(),
    baseUrl: 'http://localhost',
    realLine: fakeLine,
    dialPolicy: { allowed: ['+1 (800) 555-0199'], userPhone: '+1 (415) 555-0142' },
  });
  return { calls, dialed };
}

const task = (to: string, extra: Record<string, unknown> = {}) => ({
  custom: { to, business: 'Utility', kind: 'pay_bill' as const, goal: 'Pay the bill', user: { name: 'Jordan Lee' }, ...extra },
});

test('real calls go to allowlisted business lines', () => {
  const { calls, dialed } = manager();
  calls.start(task('+18005550199'), 'u');
  assert.deepEqual(dialed, ['+18005550199']);
});

test('unknown numbers need an explicit business-line attestation', () => {
  const { calls, dialed } = manager();
  assert.throws(() => calls.start(task('+12125550100'), 'u'), (e: unknown) => e instanceof HttpError && e.status === 403 && /TCPA/.test(e.message));
  calls.start(task('+12125550100', { business_line_attested: true }), 'u');
  assert.deepEqual(dialed, ['+12125550100']);
});

test('the user is never the one being called, even with an attestation', () => {
  const { calls, dialed } = manager();
  assert.throws(() => calls.start(task('(415) 555-0142', { business_line_attested: true }), 'u'), /not people/);
  assert.equal(dialed.length, 0);
});
