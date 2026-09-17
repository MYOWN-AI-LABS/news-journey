import express from 'express';
import { releaseLock } from './release-lock.js';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidClientMetadataError, UnsupportedGrantTypeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { atomicJson, authenticate, authorize, contained, read, type Actor } from './workspaces.js';
import { createHarnessMcp, harnessApi, type ToolContext, TOOL_DEFINITIONS } from './connector-tools.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const SCOPE = ['harness:read', 'harness:prepare'];
const identifier = (s: string) => { if (!/^[a-f0-9]{64}$/.test(s)) throw new InvalidGrantError('Invalid authorization identifier'); return s; };
interface Pending { id: string; clientId: string; name: string; params: { state?: string; scopes: string[]; codeChallenge: string; redirectUri: string; resource: string }; expiresAt: number; state: 'pending' | 'approved' | 'denied' | 'used'; codeHash?: string; token?: string; actor?: string }
interface Grant { id: string; clientId: string; actor: string; memberToken: string; scopes: string[]; resource: string; expiresAt: number; revoked?: boolean; lastCall?: { at: string; client: string; tool: string } }
export function remoteOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid|trycloudflare\.com)$/.test(url.hostname) || /^\d+(?:\.\d+){3}$/.test(url.hostname)) throw new Error('Use a stable public HTTPS hostname for your named tunnel');
  return url.origin;
}

export class HarnessOAuth implements OAuthServerProvider {
  readonly resource: string;
  constructor(readonly root: string, readonly origin: string, readonly localBase: string, readonly workspace: string) { this.resource = remoteOrigin(origin) + '/mcp'; }
  private path(kind: string, id: string) { return contained(this.root, 'state/connectors/oauth', kind, identifier(id) + '.json'); }
  readonly clientsStore = {
    getClient: (id: string) => /^[a-f0-9]{64}$/.test(id) ? read<OAuthClientInformationFull | undefined>(this.path('clients', id), undefined) : undefined,
    registerClient: (input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
      if (input.token_endpoint_auth_method !== 'none') throw new InvalidClientMetadataError('Use a public OAuth client with PKCE');
      if (!input.redirect_uris.length || input.redirect_uris.length > 10 || input.redirect_uris.some(uri => {
        const u = new URL(uri); return u.username || u.password || u.hash || !(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
      })) throw new InvalidClientMetadataError('Use HTTPS or loopback redirect URIs without credentials or fragments');
      const client: OAuthClientInformationFull = { ...input, client_id: secret(), client_id_issued_at: Math.floor(Date.now() / 1000), grant_types: ['authorization_code'], response_types: ['code'], scope: SCOPE.join(' ') };
      atomicJson(this.path('clients', client.client_id), client); return client;
    },
  };
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: express.Response) {
    const scopes = params.scopes?.length ? params.scopes : SCOPE;
    if (scopes.some(s => !SCOPE.includes(s)) || !scopes.includes('harness:read')) throw new InvalidScopeError('Use harness:read and optional harness:prepare');
    if (params.resource?.href !== this.resource) throw new InvalidGrantError('Exact MCP resource required');
    const id = secret();
    const request: Pending = { id, clientId: client.client_id, name: (client.client_name || 'MCP client').slice(0, 150), params: { ...params, scopes, resource: this.resource }, expiresAt: Date.now() + 10 * 60 * 1000, state: 'pending' };
    atomicJson(this.path('pending', id), request);
    res.redirect(this.localBase + '/journey?workspace=' + encodeURIComponent(this.workspace) + '&oauth=' + id);
  }
  pending(actor: Actor) {
    authorize('read', { root: this.root, actor });
    return this.list<Pending>('pending').filter(p => p.state === 'pending' && p.expiresAt > Date.now()).map(p => ({ id: p.id, name: p.name, redirectUri: p.params.redirectUri, scopes: p.params.scopes, expiresAt: p.expiresAt, hash: hash(JSON.stringify([p.id, p.clientId, p.params])) }));
  }
  consent(id: string, token: string, expectedHash: string, allow: boolean) {
    const unlock = releaseLock(this.root, 'connector-oauth');
    try {
    const actor = authenticate(this.root, token);
    const pending = read<Pending | null>(this.path('pending', id), null);
    if (!pending || pending.state !== 'pending' || pending.expiresAt <= Date.now() || expectedHash !== hash(JSON.stringify([pending.id, pending.clientId, pending.params]))) throw new Error('Authorization request changed or expired');
    if (pending.params.scopes.includes('harness:prepare') && actor.role === 'viewer') throw new Error('Forbidden: viewers may grant read access only; reconnect requesting harness:read');
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state) redirect.searchParams.set('state', pending.params.state);
    if (!allow) { pending.state = 'denied'; redirect.searchParams.set('error', 'access_denied'); }
    else {
      const code = secret(); pending.state = 'approved'; pending.codeHash = hash(code); pending.token = token; pending.actor = actor.id;
      // Code lookup contains only a pending-request identifier, not the member credential.
      atomicJson(this.path('codes', pending.codeHash), { request: id }); redirect.searchParams.set('code', code);
    }
    atomicJson(this.path('pending', id), pending);
    return { redirect: redirect.href };
    } finally { unlock(); }
  }
  private authorization(client: OAuthClientInformationFull, code: string) {
    const pointer = read<{ request: string } | null>(this.path('codes', hash(code)), null);
    const p = pointer ? read<Pending | null>(this.path('pending', pointer.request), null) : null;
    if (!p || p.clientId !== client.client_id || p.state !== 'approved' || p.expiresAt <= Date.now() || p.codeHash !== hash(code)) throw new InvalidGrantError('Authorization code is invalid, used or expired');
    return p;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) { return this.authorization(client, code).params.codeChallenge; }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    const unlock = releaseLock(this.root, 'connector-oauth');
    try {
    const p = this.authorization(client, code);
    if (redirectUri !== p.params.redirectUri || resource?.href !== this.resource) throw new InvalidGrantError('Redirect URI or resource mismatch');
    const actor = authenticate(this.root, p.token!);
    if (actor.id !== p.actor) throw new InvalidGrantError('Member changed');
    const token = secret(), id = hash(token), expiresAt = Math.floor(Date.now() / 1000) + 3600;
    p.state = 'used'; const memberToken = p.token!; delete p.token;
    // Consume synchronously before returning; concurrent exchanges cannot issue a second grant.
    atomicJson(this.path('pending', p.id), p);
    const grant: Grant = { id, clientId: client.client_id, actor: actor.id, memberToken, scopes: p.params.scopes, resource: this.resource, expiresAt };
    atomicJson(this.path('grants', id), grant);
    return { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: grant.scopes.join(' ') };
    } finally { unlock(); }
  }
  async exchangeRefreshToken(): Promise<never> { throw new UnsupportedGrantTypeError('Reconnect for fresh local consent after expiry'); }
  grant(token: string): Grant {
    const grant = read<Grant | null>(this.path('grants', hash(token)), null);
    if (!grant || grant.revoked || grant.expiresAt <= Date.now() / 1000 || grant.resource !== this.resource) throw new InvalidTokenError('Connector token expired or revoked');
    try { if (authenticate(this.root, grant.memberToken).id !== grant.actor) throw new Error(); }
    catch { throw new InvalidTokenError('Workspace membership revoked'); }
    return grant;
  }
  async verifyAccessToken(token: string) {
    const g = this.grant(token);
    return { token, clientId: g.clientId, scopes: g.scopes, expiresAt: g.expiresAt, resource: new URL(g.resource) };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const g = read<Grant | null>(this.path('grants', hash(request.token)), null);
    if (g?.clientId === client.client_id) this.revoke(g.id);
  }
  revoke(id: string) { const unlock = releaseLock(this.root, 'connector-oauth'); try { const file = this.path('grants', id), g = read<Grant | null>(file, null); if (g) { g.revoked = true; g.memberToken = ''; atomicJson(file, g); } } finally { unlock(); } }
  disconnect() {
    const unlock = releaseLock(this.root, 'connector-oauth'); try {
    for (const g of this.list<Grant>('grants')) this.revoke(g.id);
    for (const p of this.list<Pending>('pending')) { p.state = 'denied'; delete p.token; atomicJson(this.path('pending', p.id), p); }
    } finally { unlock(); }
  }
  grants(actor: Actor) { return this.list<Grant>('grants').filter(g => actor.id === g.actor || ['owner', 'admin'].includes(actor.role)).map(({ memberToken, ...g }) => g); }
  private list<T>(kind: string): T[] { const dir = contained(this.root, 'state/connectors/oauth', kind); return (existsSync(dir) ? readdirSync(dir) : []).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => read<T>(contained(dir, n), {} as T)); }
  toolContext(token: string): ToolContext {
    const grant = this.grant(token), api = harnessApi(this.localBase, this.workspace, grant.memberToken);
    return { root: this.root, token: grant.memberToken, connection: grant.id.slice(0, 24), origin: { kind: 'oauth', id: grant.id }, validate: () => { this.grant(token); }, api: (path, body, key) => {
      this.grant(token);
      if (body !== undefined && !grant.scopes.includes('harness:prepare')) throw new Error('Forbidden: read-only connector grant');
      return api(path, body, key);
    } };
  }
  called(token: string, client: string, tool: string) { const unlock = releaseLock(this.root, 'connector-oauth'); try { const g = this.grant(token); g.lastCall = { at: new Date().toISOString(), client, tool }; atomicJson(this.path('grants', g.id), g); } finally { unlock(); } }
}

/** This listener has no control UI, file serving, API proxy, or approval endpoint. */
export function createRemoteApp(provider: HarnessOAuth) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(provider.origin).host) { res.status(403).json({ error: 'Unexpected connector hostname' }); return; }
    if (req.headers.origin && req.headers.origin !== provider.origin) { res.status(403).json({ error: 'Unexpected origin' }); return; }
    next();
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(provider.origin), resourceServerUrl: new URL(provider.resource), scopesSupported: SCOPE }));
  app.all('/mcp', requireBearerAuth({ verifier: provider, requiredScopes: ['harness:read'], resourceMetadataUrl: provider.origin + '/.well-known/oauth-protected-resource/mcp' }), express.json({ limit: '64kb' }), async (req, res) => {
    if (req.method !== 'POST') { res.status(405).set('Allow', 'POST').end(); return; }
    const access = req.auth!.token, grant = provider.grant(access);
    if (req.body?.method === 'tools/call' && !grant.scopes.includes('harness:prepare') && !(TOOL_DEFINITIONS[req.body?.params?.name as keyof typeof TOOL_DEFINITIONS]?.readOnly || req.body?.params?.name === 'harness_sources' && !req.body?.params?.arguments?.refresh || req.body?.params?.name === 'harness_analytics' && !req.body?.params?.arguments?.collect)) { res.status(403).json({ error: 'Read-only connector grant' }); return; }
    const server = createHarnessMcp(provider.toolContext(access), (client, tool) => provider.called(access, client, tool));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport); await transport.handleRequest(req, res, req.body);
  });
  app.use((_req, res) => { res.status(404).json({ error: 'Connector route not found' }); });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (!res.headersSent) res.status(400).json({ error: 'Invalid connector request' }); });
  return app;
}
