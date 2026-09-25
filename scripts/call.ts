// Place one real call and watch it live. Run it on your own machine: Twilio has to
// reach Voiced over a public https URL, which this script opens with a Cloudflare
// quick tunnel (brew install cloudflared) unless PUBLIC_URL is already set.
//
//   npm run call -- +18005550100 --business "Acme Utilities" \
//     --goal "Hear the current balance and due date, then hang up. Do not make a payment." \
//     --ask account --ask zip --record
//
//   npm run call -- --demo bedford     # the same flow on a simulated tree: no Twilio, no tunnel, no cost
//
// --ask <fact>     typed here with hidden input; goes straight to the vault (not shell history, not any model)
// --fact k=v       a non-secret fact, e.g. --fact zip=13205
// --name "…"       the account holder (asked if missing)
// --kind           pay_bill (default) | reach_human | cancel | reservation
// --max-amount N   pre-approve a payment up to $N. Without it nothing can be paid: the guard stops and asks.
// --record         record the call (paused while vault digits are keyed) and open the recording afterwards
// --brain          rules | gemini | claude (default: the first key in your env)
//
// Only for business service lines: the script attests that the number is one.

import '../src/env.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { CallEvent } from '../src/core/types.js';
import { printEvent } from './transcript.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const opts = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const valued = new Set(['business', 'goal', 'kind', 'name', 'ask', 'fact', 'max-amount', 'brain', 'demo', 'port']);
const to = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]?.replace(/^--/, '')));
const demo = opt('demo');
const port = Number(opt('port') ?? process.env.PORT ?? 8787);
const local = `http://localhost:${port}`;
const API_KEY = process.env.VOICED_API_KEY ?? 'vk_demo_local';
const H = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' };
const children: ChildProcess[] = [];

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  shutdown(1);
}

function shutdown(code = 0): never {
  for (const c of children) c.kill('SIGINT');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(130));

if (!demo && !to) fail('Give the number to call (E.164, e.g. +18005550100), or --demo bedford to try the flow on a simulated tree.');
if (!demo) {
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER']) if (!process.env[k]) fail(`${k} is not set (put it in .env).`);
  if (!opt('business') || !opt('goal')) fail('Real calls need --business "Name" and --goal "What should happen".');
}

// 1. A public URL for Twilio, then the server behind it.
let publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, '');
if (!demo && !publicUrl) publicUrl = await openTunnel();
if (!existsSync('web/dist/index.html')) spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build-web.ts'], { stdio: 'inherit' });
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  env: {
    ...process.env,
    PORT: String(port),
    ...(publicUrl ? { PUBLIC_URL: publicUrl } : {}),
    ...(flag('record') ? { VOICED_RECORD: '1' } : {}),
    ...(opt('brain') ? { VOICED_BRAIN: opt('brain') } : {}),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
children.push(server);
server.stdout!.on('data', (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, '  server │ ')));
server.on('exit', (code) => code && fail(`the server exited (${code})`));
await waitFor(`${local}/openapi.json`, 30_000, 'the Voiced server to start');
if (publicUrl) await waitFor(`${publicUrl}/openapi.json`, 90_000, `${publicUrl} to be reachable (new tunnels take a few seconds)`);

// 2. The task. Secrets are typed with hidden input and sent only to the local server's vault.
let body: Record<string, unknown>;
if (demo) body = { business_id: demo, max_amount: Number(opt('max-amount') ?? 200), speed: 4 };
else {
  const facts: Record<string, string> = {};
  for (const kv of opts('fact')) {
    const [k, ...v] = kv.split('=');
    facts[k] = v.join('=');
  }
  for (const key of opts('ask')) facts[key] = await askHidden(`${key} (hidden): `);
  const name = opt('name') ?? (await ask('Account holder name: '));
  const max = opt('max-amount');
  body = {
    custom: {
      to,
      business: opt('business'),
      kind: opt('kind') ?? 'pay_bill',
      goal: opt('goal'),
      user: { name },
      facts,
      business_line_attested: true,
      ...(max ? { max_amount: Number(max) } : {}),
    },
  };
  if (!max) console.log('  No --max-amount: nothing can be paid on this call. The guard stops at any payment step and asks you.');
}

// 3. Place it, open the live view, and print the transcript here too.
const started = new Date();
const res = await fetch(`${local}/v1/calls`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const call = (await res.json()) as { id?: string; watch_url?: string; error?: string };
if (!res.ok || !call.id) fail(`the call was not placed: ${call.error ?? res.status}`);
const watch = call.watch_url!.replace(publicUrl ?? local, local);
console.log(`\n━━ Calling ${demo ?? to} · live view: ${watch} ━━`);
openInBrowser(watch);

const ended = await follow(call.id!);
if (flag('record') && !demo) await fetchRecording(started);
shutdown(ended ? 0 : 1);

async function follow(id: string): Promise<boolean> {
  const stream = await fetch(`${local}/v1/calls/${id}/events`, { headers: H });
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame.startsWith('data: ')) continue;
      const data = JSON.parse(frame.slice(6)) as { type: string };
      if (data.type === 'hello' || data.type === 'map') continue;
      const e = data as CallEvent;
      printEvent(e);
      if (e.type === 'user_request') void answer(id, e.id, e.request);
      if (e.type === 'ended') {
        const r = e.result;
        console.log(`→ ${r.resolution.toUpperCase()}: ${r.summary}${r.failure ? `\n  broke at “${r.failure.step}”: ${r.failure.reason}: ${r.failure.detail}` : ''}`);
        return r.outcome === 'success';
      }
    }
  }
  return false;
}

/** Approvals are answered here; anything secret is entered on the approval page, straight to the vault. */
async function answer(callId: string, requestId: string, request: Extract<CallEvent, { type: 'user_request' }>['request']) {
  if (request.kind === 'input') {
    console.log(`  Enter it on the approval page (it goes straight to the vault): ${watch}&approve=${requestId}`);
    return;
  }
  const choice = request.kind === 'choose' ? await ask(`  Choose (${request.options.join(' / ')}): `) : undefined;
  const approved = request.kind === 'choose' ? !!choice : /^y/i.test(await ask('  Approve? [y/N] '));
  await fetch(`${local}/v1/calls/${callId}/respond`, { method: 'POST', headers: H, body: JSON.stringify({ request_id: requestId, approved, choice }) });
}

async function openTunnel(): Promise<string> {
  console.log('Opening a Cloudflare quick tunnel so Twilio can reach Voiced…');
  const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', local], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(tunnel);
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail('cloudflared did not print a tunnel URL within 30s'), 30_000);
    tunnel.on('error', () => fail('cloudflared is not installed (brew install cloudflared), or set PUBLIC_URL to a public https URL for this machine.'));
    tunnel.stderr!.on('data', (d: Buffer) => {
      const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        console.log(`  tunnel ${m[0]}`);
        resolve(m[0]);
      }
    });
  });
}

async function waitFor(url: string, ms: number, what: string) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`timed out waiting for ${what}`);
}

/** The recording of the call just made: newest call to this number since we started, saved and opened. */
async function fetchRecording(since: Date) {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const auth = { authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}` };
  const api = `https://api.twilio.com/2010-04-01/Accounts/${sid}`;
  const calls = (await (await fetch(`${api}/Calls.json?To=${encodeURIComponent(to!)}&PageSize=5`, { headers: auth })).json()) as { calls?: { sid: string; date_created: string }[] };
  const twCall = calls.calls?.find((c) => new Date(c.date_created) >= new Date(since.getTime() - 60_000));
  if (!twCall) return console.log('  No Twilio call found to fetch a recording from.');
  for (let i = 0; i < 15; i++) {
    const list = (await (await fetch(`${api}/Calls/${twCall.sid}/Recordings.json`, { headers: auth })).json()) as { recordings?: { sid: string; status: string }[] };
    const rec = list.recordings?.find((r) => r.status === 'completed');
    if (rec) {
      const mp3 = await fetch(`${api}/Recordings/${rec.sid}.mp3`, { headers: auth });
      mkdirSync('.voiced/recordings', { recursive: true });
      const file = `.voiced/recordings/${twCall.sid}.mp3`;
      writeFileSync(file, Buffer.from(await mp3.arrayBuffer()));
      console.log(`  Recording saved to ${file}`);
      openInBrowser(file);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  The recording isn't ready yet; it's in the Twilio Console under call ${twCall.sid}.`);
}

function openInBrowser(target: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [target], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function askHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) fail('run this in a terminal: --ask facts are typed with hidden input');
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003') shutdown(130);
        if (c === '\r' || c === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          return resolve(value.trim());
        }
        value = c === '\u007f' || c === '\b' ? value.slice(0, -1) : value + c;
      }
    };
    stdin.on('data', onData);
  });
}
