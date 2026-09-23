// Auth for the Voiced API and remote MCP server.
// - API keys (Authorization: Bearer vk_...) for developers and static-credential clients.
// - OAuth 2.1 authorization code + PKCE with dynamic client registration (RFC 7591)
//   and metadata discovery (RFC 8414 / RFC 9728): the connector flow that Claude,
//   Muse and other agent platforms use for remote MCP servers.
// Storage is in-memory; tokens are opaque random strings.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: number;
}

interface CodeGrant {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  user: string;
  scope: string;
  expires: number;
}

interface TokenGrant {
  user: string;
  client_id: string;
  scope: string;
  expires: number;
}

const TOKEN_TTL_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

export class Auth {
  private clients = new Map<string, OAuthClient>();
  private codes = new Map<string, CodeGrant>();
  private tokens = new Map<string, TokenGrant>();
  private refreshTokens = new Map<string, Omit<TokenGrant, 'expires'>>();

  /** apiKeys maps key → user id. */
  constructor(private apiKeys: Map<string, string>) {}

  /** Returns the user id for a bearer credential, or undefined. */
  authenticate(authorization: string | undefined): string | undefined {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) return undefined;
    const token = m[1];
    for (const [key, user] of this.apiKeys) if (safeEqual(key, token)) return user;
    const grant = this.tokens.get(token);
    if (grant && grant.expires > Date.now()) return grant.user;
    return undefined;
  }

  metadata(base: string) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['calls'],
      service_documentation: `${base}/docs`,
    };
  }

  resourceMetadata(base: string) {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['calls'],
      resource_name: 'Voiced',
    };
  }

  register(body: Record<string, unknown>): OAuthClient {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length) throw new AuthError(400, 'invalid_redirect_uri', 'redirect_uris is required');
    for (const u of uris) {
      const url = safeUrl(u);
      if (!url || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
        throw new AuthError(400, 'invalid_redirect_uri', `redirect_uri must be https (or localhost): ${u}`);
      }
    }
    const client: OAuthClient = {
      client_id: `vc_${randomBytes(12).toString('base64url')}`,
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : undefined,
      redirect_uris: uris,
      created_at: Date.now(),
    };
    this.clients.set(client.client_id, client);
    return client;
  }

  client(id: string): OAuthClient | undefined {
    return this.clients.get(id);
  }

  /** Validate an authorization request before showing consent. */
  checkAuthorize(q: URLSearchParams): { client: OAuthClient; redirect_uri: string } {
    const client = this.clients.get(q.get('client_id') ?? '');
    if (!client) throw new AuthError(400, 'invalid_client', 'Unknown client_id');
    const redirect_uri = q.get('redirect_uri') ?? client.redirect_uris[0];
    if (!client.redirect_uris.includes(redirect_uri)) throw new AuthError(400, 'invalid_request', 'redirect_uri not registered');
    if (q.get('response_type') !== 'code') throw new AuthError(400, 'unsupported_response_type', 'response_type must be code');
    if (!q.get('code_challenge') || (q.get('code_challenge_method') ?? 'S256') !== 'S256') {
      throw new AuthError(400, 'invalid_request', 'PKCE with S256 is required');
    }
    return { client, redirect_uri };
  }

  /** The user approved: mint a one-time code and return the redirect URL. */
  approve(q: URLSearchParams, user: string): string {
    const { client, redirect_uri } = this.checkAuthorize(q);
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      client_id: client.client_id,
      redirect_uri,
      code_challenge: q.get('code_challenge')!,
      user,
      scope: q.get('scope') ?? 'calls',
      expires: Date.now() + CODE_TTL_MS,
    });
    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (q.get('state')) url.searchParams.set('state', q.get('state')!);
    return url.toString();
  }

  deny(q: URLSearchParams): string {
    const { redirect_uri } = this.checkAuthorize(q);
    const url = new URL(redirect_uri);
    url.searchParams.set('error', 'access_denied');
    if (q.get('state')) url.searchParams.set('state', q.get('state')!);
    return url.toString();
  }

  token(params: URLSearchParams) {
    const grantType = params.get('grant_type');
    if (grantType === 'authorization_code') {
      const code = this.codes.get(params.get('code') ?? '');
      this.codes.delete(params.get('code') ?? '');
      if (!code || code.expires < Date.now()) throw new AuthError(400, 'invalid_grant', 'Code is invalid or expired');
      if (params.get('client_id') && params.get('client_id') !== code.client_id) throw new AuthError(400, 'invalid_grant', 'client_id mismatch');
      if (params.get('redirect_uri') && params.get('redirect_uri') !== code.redirect_uri) throw new AuthError(400, 'invalid_grant', 'redirect_uri mismatch');
      const verifier = params.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !safeEqual(challenge, code.code_challenge)) throw new AuthError(400, 'invalid_grant', 'PKCE verification failed');
      return this.issue({ user: code.user, client_id: code.client_id, scope: code.scope });
    }
    if (grantType === 'refresh_token') {
      const rt = params.get('refresh_token') ?? '';
      const grant = this.refreshTokens.get(rt);
      if (!grant) throw new AuthError(400, 'invalid_grant', 'Unknown refresh token');
      this.refreshTokens.delete(rt);
      return this.issue(grant);
    }
    throw new AuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }

  private issue(grant: Omit<TokenGrant, 'expires'>) {
    const access = `vat_${randomBytes(24).toString('base64url')}`;
    const refresh = `vrt_${randomBytes(24).toString('base64url')}`;
    this.tokens.set(access, { ...grant, expires: Date.now() + TOKEN_TTL_MS });
    this.refreshTokens.set(refresh, grant);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_MS / 1000,
      refresh_token: refresh,
      scope: grant.scope,
    };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function safeUrl(u: string): URL | undefined {
  try {
    return new URL(u);
  } catch {
    return undefined;
  }
}
