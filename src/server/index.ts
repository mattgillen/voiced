// The Voiced server: REST API, remote MCP (streamable HTTP) with OAuth, the
// OpenAPI spec agent platforms build connectors from, and the consumer web app.
//
//   npm start                    # http://localhost:8787
//   PUBLIC_URL=https://...       # when exposed publicly (connectors need https)
//   VOICED_API_KEY=vk_...        # developer key (default: vk_demo_local)
//   ANTHROPIC_API_KEY=...        # use the Claude brain (otherwise rules only)

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize as normalizePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeBrain } from '../brains/claude.js';
import { RulesBrain } from '../brains/rules.js';
import { MapMemory, type IvrMap } from '../core/memory.js';
import { Auth, AuthError } from './auth.js';
import { CallManager, HttpError, type ManagedCall } from './calls.js';
import { buildMcpServer } from './mcp.js';
import { openapi } from './openapi.js';
import { consentPage, errorPage } from './pages.js';
import { FileMapStore } from './store.js';
import { twilioFromEnv } from '../telephony/twilio.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const DATA = process.env.VOICED_DATA ?? join(ROOT, '.voiced');
const API_KEY = process.env.VOICED_API_KEY ?? 'vk_demo_local';
const DEMO_USER = 'Jordan Lee (demo)';
const useClaude = process.env.VOICED_BRAIN === 'claude' || (!!process.env.ANTHROPIC_API_KEY && process.env.VOICED_BRAIN !== 'rules');

let base = process.env.PUBLIC_URL?.replace(/\/$/, '') ?? `http://localhost:${PORT}`;

const store = new FileMapStore(join(DATA, 'maps.json'));
seedMaps(store, join(ROOT, 'maps'));
const memory = new MapMemory(store);
const auth = new Auth(new Map([[API_KEY, DEMO_USER]]));
const twilio = twilioFromEnv(() => base);
const calls = new CallManager({
  memory,
  brain: () => (useClaude ? new ClaudeBrain() : new RulesBrain()),
  baseUrl: base,
  logPath: join(DATA, 'calls.jsonl'),
  realLine: twilio?.line,
});

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    if (err instanceof AuthError) return sendJson(res, err.status, { error: err.error, error_description: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  });
});
twilio?.attach(server);

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', base);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate');
  if (method === 'OPTIONS') return end(res, 204);
  if (twilio && (await twilio.handle(req, res, url))) return;

  // --- Discovery & OAuth -----------------------------------------------------
  if (path === '/openapi.json') return sendJson(res, 200, openapi(base));
  if (path === '/.well-known/oauth-authorization-server') return sendJson(res, 200, auth.metadata(base));
  if (path.startsWith('/.well-known/oauth-protected-resource')) return sendJson(res, 200, auth.resourceMetadata(base));
  if (path === '/oauth/register' && method === 'POST') return sendJson(res, 201, auth.register(await readJson(req)));
  if (path === '/oauth/authorize') {
    try {
      if (method === 'GET') {
        const { client } = auth.checkAuthorize(url.searchParams);
        return sendHtml(res, 200, consentPage(client.client_name ?? 'An app', url.searchParams.toString(), DEMO_USER));
      }
      const form = new URLSearchParams(await readText(req));
      const to = form.get('decision') === 'allow' ? auth.approve(url.searchParams, DEMO_USER) : auth.deny(url.searchParams);
      res.writeHead(302, { location: to });
      return res.end();
    } catch (err) {
      if (err instanceof AuthError) return sendHtml(res, err.status, errorPage('Can’t connect', err.message));
      throw err;
    }
  }
  if (path === '/oauth/token' && method === 'POST') {
    const raw = await readText(req);
    const params = (req.headers['content-type'] ?? '').includes('json')
      ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)]))
      : new URLSearchParams(raw);
    res.setHeader('cache-control', 'no-store');
    return sendJson(res, 200, auth.token(params));
  }

  // --- Remote MCP --------------------------------------------------------------
  if (path === '/mcp') {
    const user = auth.authenticate(req.headers.authorization);
    if (!user) {
      res.setHeader('www-authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      return sendJson(res, 401, { error: 'unauthorized', error_description: 'Connect with OAuth or send Authorization: Bearer <Voiced API key>' });
    }
    if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', error_description: 'Stateless server: use POST' });
    const body = await readJson(req);
    const mcp = buildMcpServer(calls, user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  // --- REST API --------------------------------------------------------------
  if (path.startsWith('/v1/')) return api(req, res, url, method);

  // --- Web app -----------------------------------------------------------------
  if (path === '/docs') {
    res.writeHead(302, { location: '/openapi.json' });
    return res.end();
  }
  return serveStatic(res, path);
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, method: string) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "v1"
  const user = auth.authenticate(req.headers.authorization);

  // Per-call capability links (watch_url / approval_url) carry ?t=<token>.
  const callFor = (id: string): ManagedCall => {
    const call = calls.get(id);
    if (!call) throw new HttpError(404, `No call ${id}`);
    const token = url.searchParams.get('t');
    if ((user && call.owner === user) || (token && token === call.token)) return call;
    throw new HttpError(user ? 404 : 401, user ? `No call ${id}` : 'Unauthorized');
  };
  const requireUser = () => {
    if (!user) throw new HttpError(401, 'Send Authorization: Bearer <Voiced API key or OAuth token>');
    return user;
  };

  if (parts[0] === 'businesses' && method === 'GET') return sendJson(res, 200, calls.directory());
  if (parts[0] === 'stats' && method === 'GET') return sendJson(res, 200, calls.stats());
  if (parts[0] === 'maps' && method === 'GET') return sendJson(res, 200, memory.all().map(mapSummary));
  if (parts[0] === 'maps' && method === 'DELETE') {
    requireUser();
    memory.reset();
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'calls' && parts.length === 1) {
    const owner = requireUser();
    if (method === 'POST') {
      const body = await readJson(req);
      const call = calls.start(
        {
          business_id: str(body.business_id),
          instructions: str(body.instructions),
          max_amount: num(body.max_amount),
          max_fee: num(body.max_fee),
          card: str(body.card),
          speed: num(body.speed),
          custom: body.custom as never,
        },
        owner,
      );
      return sendJson(res, 201, calls.view(call));
    }
    if (method === 'GET') return sendJson(res, 200, calls.list(owner).map((c) => calls.view(c, { transcript: 3 })));
  }

  if (parts[0] === 'calls' && parts[1]) {
    const call = callFor(parts[1]);
    const action = parts[2];
    if (!action && method === 'GET') {
      const wait = Math.min(50, Math.max(0, Number(url.searchParams.get('wait') ?? 0)));
      if (wait) await calls.waitForChange(call, wait * 1000);
      return sendJson(res, 200, calls.view(call, { transcript: 40 }));
    }
    if (action === 'events' && method === 'GET') return streamEvents(req, res, call);
    if (action === 'respond' && method === 'POST') {
      const body = await readJson(req);
      if (!call.session.respond(String(body.request_id), { approved: body.approved === true, choice: str(body.choice) })) {
        throw new HttpError(409, 'That request is no longer pending');
      }
      await new Promise((r) => setTimeout(r, 30));
      return sendJson(res, 200, calls.view(call));
    }
    if (action === 'message' && method === 'POST') {
      const body = await readJson(req);
      void call.session.userSays(String(body.text ?? '').slice(0, 500));
      return sendJson(res, 202, { ok: true });
    }
    if (action === 'hangup' && method === 'POST') {
      await call.session.hangup();
      return sendJson(res, 200, calls.view(call));
    }
    if (action === 'speed' && method === 'POST') {
      const body = await readJson(req);
      if (call.clock) call.clock.speed = Math.min(200, Math.max(1, Number(body.speed) || 1));
      return sendJson(res, 200, { speed: call.clock?.speed ?? 1 });
    }
  }
  throw new HttpError(404, 'Not found');
}

function streamEvents(req: IncomingMessage, res: ServerResponse, call: ManagedCall) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  write({ type: 'hello', call: calls.view(call, { transcript: 0 }), map: mapSummary(memory.get(call.task.phone)) });
  for (const e of call.session.events) write(e);
  if (call.session.result) return res.end();
  const unsubscribe = call.session.subscribe((e) => {
    write(e);
    if (e.type === 'ended') {
      write({ type: 'map', map: mapSummary(memory.get(call.task.phone)) });
      setTimeout(() => res.end(), 50);
    }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    unsubscribe();
    clearInterval(ping);
  });
}

function mapSummary(map: IvrMap | undefined) {
  if (!map) return null;
  return {
    phone: map.phone,
    business: map.business,
    calls: map.calls,
    screens: map.screens.map((s) => ({ id: s.id, title: s.title, kind: s.kind, sample: s.sample[0], plays: Object.keys(s.plays).length, seen: s.seen })),
  };
}

// --- Static files -----------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

function serveStatic(res: ServerResponse, path: string) {
  const webRoot = join(ROOT, 'web', 'dist');
  const file = path === '/' ? 'index.html' : normalizePath(path).replace(/^[/\\]+/, '');
  const full = join(webRoot, file);
  if (!full.startsWith(webRoot) || !existsSync(full)) {
    if (path === '/') return sendHtml(res, 503, errorPage('Web app not built', 'Run "npm run build:web", then reload.'));
    return sendJson(res, 404, { error: 'not_found' });
  }
  let body: string | Buffer = readFileSync(full);
  if (file === 'index.html') {
    const config = { mode: 'server', apiKey: API_KEY, brain: useClaude ? 'claude' : 'rules', realCalls: !!twilio };
    body = body.toString('utf8').replace('<!--VOICED_CONFIG-->', `<script>window.VOICED_CONFIG=${JSON.stringify(config)}</script>`);
  }
  res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(body);
}

// --- Helpers -----------------------------------------------------------------

function seedMaps(store: FileMapStore, dir: string) {
  // Hand-mapped phone trees (maps/*.json) seed the shared map on first boot.
  if (!existsSync(dir)) return;
  const current = store.load();
  let changed = false;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const seed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, IvrMap>;
    for (const [k, v] of Object.entries(seed)) if (!current[k]) (current[k] = v), (changed = true);
  }
  if (changed) {
    store.save(current);
    store.flush();
  }
}

function readText(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function end(res: ServerResponse, status: number) {
  res.writeHead(status);
  res.end();
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

server.listen(PORT, () => {
  if (!process.env.PUBLIC_URL) base = `http://localhost:${(server.address() as { port: number }).port}`;
  calls.baseUrl = base;
  console.log(`Voiced on ${base}`);
  console.log(`  web app      ${base}/`);
  console.log(`  REST + spec  ${base}/v1  ·  ${base}/openapi.json`);
  console.log(`  remote MCP   ${base}/mcp  (OAuth or Bearer ${API_KEY})`);
  console.log(`  brain        ${useClaude ? `Claude (${process.env.VOICED_MODEL ?? 'claude-opus-5'})` : 'rules (set ANTHROPIC_API_KEY for Claude)'}`);
  console.log(`  real calls   ${twilio ? 'Twilio' : 'off (simulated phone trees only)'}`);
});

process.on('SIGINT', () => {
  store.flush();
  process.exit(0);
});
