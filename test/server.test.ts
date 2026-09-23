// Boots the real server and drives it the way agent platforms do: REST with an
// API key, the OAuth 2.1 + PKCE connector dance, and MCP over streamable HTTP.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const KEY = 'vk_test_key';
let server: ChildProcess;
let base = '';

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    env: { ...process.env, PORT: '0', VOICED_API_KEY: KEY, VOICED_DATA: mkdtempSync(join(tmpdir(), 'voiced-')), VOICED_BRAIN: 'rules', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  base = await new Promise<string>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /Voiced on (http:\/\/\S+)/.exec(out);
      if (m) resolve(m[1]);
    });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

after(() => server.kill());

const api = (path: string, init: RequestInit & { key?: string | null } = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? KEY}` }),
      ...(init.headers ?? {}),
    },
  });

test('REST: pay a bill, pause on the fee, approve, finish', async () => {
  assert.equal((await api('/v1/calls', { method: 'POST', body: '{}', key: null })).status, 401);
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/v1/calls'].post.operationId === 'startCall');

  const started = await (await api('/v1/calls', { method: 'POST', body: JSON.stringify({ business_id: 'bedford', max_amount: 200, speed: 200 }) })).json();
  assert.equal(started.business, 'Bedford Falls Electric & Water');
  let call = await (await api(`/v1/calls/${started.id}?wait=30`)).json();
  assert.equal(call.pending_request?.kind, 'approve_payment');
  assert.equal(call.pending_request.fee, 2.95);
  assert.match(call.pending_request.approval_url, /approve=/);

  call = await (await api(`/v1/calls/${started.id}/respond`, { method: 'POST', body: JSON.stringify({ request_id: call.pending_request.id, approved: true }) })).json();
  call = await (await api(`/v1/calls/${started.id}?wait=30`)).json();
  assert.equal(call.status, 'ended');
  assert.equal(call.outcome, 'success');
  assert.equal(call.notes.confirmation, '4820177');
  assert.ok(!JSON.stringify(call).includes('4242424242424242'));

  // The watch link works without the API key (capability token), and only for this call.
  const token = new URL(call.watch_url).searchParams.get('t');
  assert.equal((await api(`/v1/calls/${started.id}?t=${token}`, { key: null })).status, 200);
  assert.equal((await api(`/v1/calls/${started.id}?t=wrong`, { key: null })).status, 401);

  const stats = await (await api('/v1/stats')).json();
  assert.equal(stats.calls, 1);
  assert.equal(stats.completion_rate, 1);
});

test('OAuth 2.1 + PKCE connector flow, then MCP tools over streamable HTTP', async () => {
  // An unauthenticated MCP request points the client at the resource metadata.
  const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata=/);
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);

  // Dynamic client registration.
  const redirect = 'https://agent.example.com/callback';
  const client = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: [redirect] }) })).json();

  // Authorize with PKCE; the user clicks Allow on the consent page.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'calls' });
  const consent = await fetch(`${meta.authorization_endpoint}?${q}`);
  assert.match(await consent.text(), /Test Agent wants to make calls for you/);
  const allowed = await fetch(`${meta.authorization_endpoint}?${q}`, { method: 'POST', body: 'decision=allow', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  const back = new URL(allowed.headers.get('location')!);
  assert.equal(back.searchParams.get('state'), 'xyz');

  // A wrong verifier fails; the right one gets a token.
  const exchange = (v: string, code: string) =>
    fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: v, client_id: client.client_id, redirect_uri: redirect }) });
  const code = back.searchParams.get('code')!;
  const tokens = await (await exchange(verifier, code)).json();
  assert.match(tokens.access_token, /^vat_/);
  assert.equal((await exchange('nope', code)).status, 400, 'codes are single-use');

  // MCP with the OAuth token.
  const mcp = new Client({ name: 'test-agent', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  assert.deepEqual(tools.sort(), ['get_call', 'get_stats', 'hang_up', 'list_businesses', 'respond_to_call', 'start_call']);

  const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
  const businesses = text(await mcp.callTool({ name: 'list_businesses', arguments: {} }));
  assert.ok(businesses.some((b: { id: string }) => b.id === 'irontemple'));
  const call = text(await mcp.callTool({ name: 'start_call', arguments: { business_id: 'irontemple' } }));
  let status = call;
  for (let i = 0; i < 5 && status.status !== 'ended'; i++) status = text(await mcp.callTool({ name: 'get_call', arguments: { call_id: call.id, wait_seconds: 20 } }));
  assert.equal(status.outcome, 'success', status.summary);
  assert.equal(status.notes.confirmation, 'CX44190');
  await mcp.close();
});
