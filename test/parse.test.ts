import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeTurn,
  extractConfirmation,
  fingerprint,
  looksHuman,
  looksLikeCommit,
  parseMenuOptions,
  parseTimes,
} from '../src/core/parse.js';
import { buildCustomTask, keypadDigits } from '../src/core/tasks.js';
import { Vault } from '../src/core/vault.js';

test('parses label-first, key-first and speech menu options', () => {
  const opts = parseMenuOptions(
    'For billing and payments, press 2. Press 0 to speak with a representative. To return to the main menu, press star. Para español, oprima el dos.',
  );
  assert.deepEqual(
    opts.map((o) => [o.key, o.label]),
    // "oprima el dos" repeats key 2, so the first label for a key wins.
    [
      ['2', 'billing and payments'],
      ['0', 'speak with a representative'],
      ['*', 'return to the main menu'],
    ],
  );
  const speech = parseMenuOptions("You can say things like 'make a reservation', 'hours and location', or 'catering'.");
  assert.deepEqual(speech.map((o) => o.label), ['make a reservation', 'hours and location', 'catering']);
  assert.deepEqual(parseMenuOptions('If this is correct, press 1. Otherwise, press 2.').map((o) => o.label), ['this is correct', 'otherwise']);
});

test('extracts spoken confirmation codes', () => {
  assert.equal(extractConfirmation('Your confirmation number is 4 8 2 0 1 7 7.'), '4820177');
  assert.equal(extractConfirmation('Your confirmation code is L U N 4 8 2.'), 'LUN482');
  assert.equal(extractConfirmation('Your case number is K W 7 7 1 0 4.'), 'KW77104');
  assert.equal(extractConfirmation('A confirmation number is required to continue.'), undefined);
});

test('tells recorded voices from people', () => {
  assert.ok(looksHuman('Thank you for holding, this is Dana with Kestrel Wireless billing.'));
  assert.ok(looksHuman('Who do I have the pleasure of speaking with today?'));
  assert.ok(!looksHuman("Thanks for calling Luna Trattoria! I'm Luna's virtual host."));
  assert.ok(!looksHuman('This is Kestrel Wireless. How can I help you today?'));
});

test('flags commit steps', () => {
  assert.ok(looksLikeCommit('To authorize this payment, press 1.'));
  assert.ok(looksLikeCommit('To confirm your cancellation, press 1.'));
  assert.ok(!looksLikeCommit('To make a payment, press 1.'));
  assert.equal(analyzeTurn('To authorize this payment, press 1. To cancel, press 2.', 'ivr').kind, 'commit');
});

test('fingerprints ignore amounts and dates so screens match across calls', () => {
  assert.equal(
    fingerprint('Your current balance is $142.17, due on October 3rd.'),
    fingerprint('Your current balance is $88.00, due on November 12th.'),
  );
});

test('parses times', () => {
  assert.deepEqual(parseTimes('I have 6:15 PM or 7:45 p.m.'), [18 * 60 + 15, 19 * 60 + 45]);
});

test('vault resolves, redacts and scrubs', () => {
  const v = new Vault(
    [
      { key: 'card.number', label: 'Card', secret: true, display: 'Visa •• 4242', aliases: [] },
      { key: 'zip', label: 'ZIP', value: '13205', aliases: [] },
    ],
    { 'card.number': '4242424242424242' },
  );
  assert.equal(v.resolve('{{card.number}}#', { allowSecrets: true }), '4242424242424242#');
  assert.throws(() => v.resolve('{{card.number}}', { allowSecrets: false }));
  assert.equal(v.redact('{{card.number}}# {{zip}}'), 'Visa •• 4242# 13205');
  assert.equal(v.scrub('You entered 4242 4242 4242 4242.'), 'You entered Visa •• 4242.');
});

test('secret numbers copied from a bill are keyed without separators', () => {
  assert.equal(keypadDigits('1234567890-004'), '1234567890004');
  assert.equal(keypadDigits(' 4242 4242 4242 4242 '), '4242424242424242');
  assert.equal(keypadDigits('12/28'), '1228');
  assert.equal(keypadDigits('AB-1234'), 'AB-1234', 'letters are left alone (a keypad cannot send them; the session blocks it)');
  const { task, secrets } = buildCustomTask({
    to: '+18005550100', business: 'Acme', kind: 'pay_bill', goal: 'Hear the balance', user: { name: 'Pat Lee' },
    facts: { account: '1234567890-004', zip: '13205' },
  });
  assert.equal(secrets.account, '1234567890004');
  assert.equal(task.facts.find((f) => f.key === 'account')?.display, '•••• 0004');
});
