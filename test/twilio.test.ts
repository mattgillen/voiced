// The Twilio line against a fake ConversationRelay socket and a stubbed REST API.
// This checks our side of the protocol; it is not a substitute for a live call.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { WebSocket } from 'ws';
import { bedford } from '../src/sim/scenarios/bedford.js';
import { twilioFromEnv, validSignature, type TwilioLine } from '../src/telephony/twilio.js';

test('X-Twilio-Signature matches the documented test vector', () => {
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  assert.ok(validSignature('12345', '0/KCTR6DLpKmkAf8muzZqo1nDgQ=', url, params));
  assert.ok(!validSignature('12345', '0/KCTR6DLpKmkAf8muzZqo1nDgQ=', url, { ...params, Digits: '9999' }));
});

test('TwilioLine: dials with ConversationRelay TwiML, turns prompts into speech, sends DTMF', async () => {
  const env = { ...process.env };
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_NUMBER: '(555) 010-0000', VOICED_USER_PHONE: '+14155550142' });
  const requests: { url: string; body: URLSearchParams }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: new URLSearchParams(init.body as URLSearchParams) });
    return new Response(JSON.stringify({ sid: 'CA_business' }), { status: 201 });
  }) as typeof fetch;
  try {
    const twilio = twilioFromEnv(() => 'https://voiced.example.com')!;
    const { task } = bedford.task();
    const line = twilio.line(task) as TwilioLine;
    const sent: Record<string, unknown>[] = [];
    const ws = Object.assign(new EventEmitter(), { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) });

    const dialing = line.dial();
    await new Promise((r) => setTimeout(r, 10));
    const create = requests[0];
    assert.match(create.url, /\/Accounts\/AC123\/Calls\.json$/);
    assert.equal(create.body.get('To'), '+13155550110');
    assert.equal(create.body.get('From'), '+15550100000', 'caller ID goes out in E.164 whatever the env format');
    const twiml = create.body.get('Twiml')!;
    assert.match(twiml, /<ConversationRelay url="wss:\/\/voiced\.example\.com\/twilio\/relay\?job=/);
    assert.doesNotMatch(twiml, /welcomeGreeting/, 'the agent must not talk first on an IVR call');
    assert.match(twiml, /<Connect action="https:\/\/voiced\.example\.com\/twilio\/action\?job=/);

    line.connect(ws as unknown as WebSocket);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'setup', callSid: 'CA_business' })));
    await dialing;

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'prompt', voicePrompt: 'For English, press 1. Para español, oprima el dos.', last: true })));
    assert.deepEqual(await line.next(), { kind: 'speech', speaker: 'ivr', text: 'For English, press 1.', durationMs: 0 });
    assert.equal((await line.next()).kind, 'speech');
    const quiet = await line.next();
    assert.equal(quiet.kind, 'silence', 'endpointing turns a pause into a turn end');

    await line.sendDigits('1');
    await line.say('Pay my bill');
    assert.deepEqual(sent[0], { type: 'sendDigits', digits: '1' });
    assert.deepEqual(sent[1], { type: 'text', token: 'Pay my bill', last: true, interruptible: false });

    ws.emit('close');
    assert.deepEqual(await line.next(), { kind: 'hangup', by: 'remote' });
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
});
