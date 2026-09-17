import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { stringify } from 'yaml';
import { atomicJson, authenticate, authorize, contained, read, members, type Actor } from './workspaces.js';
import { connectorCards, executable, loadConnection } from './connector-hosts.js';
import { configureConnection, disconnectConnection, launchFromBrowser, verifyConnection } from './connector-local.js';
import { HarnessOAuth, createRemoteApp, remoteOrigin } from './connector-remote.js';
import { harnessApi, pendingConfirmations, callHarnessTool } from './connector-tools.js';
import { conversationState, conversationText, realtimeSession } from './connector-voice.js';
import { releaseLock } from './release-lock.js';
import { engagementState } from './engagement.js';

const remoteSchema = z.object({ origin: z.string().transform(remoteOrigin), tunnelId: z.string().uuid(), credentialsFile: z.string().min(1).max(2000), port: z.number().int().min(1024).max(65535).default(4793) }).strict();
type RemoteConfig = z.infer<typeof remoteSchema>;
interface Remote { oauth: HarnessOAuth; server: Server; tunnel: ChildProcess; running: boolean; timer?: ReturnType<typeof setInterval>; error?: string }
export function connectorController(codeRoot: string) {
  const remote = new Map<string, Remote>();
  const voiceCalls = new Set<string>();
  const generations = new Map<string, number>();
  const bump = (root: string) => { const n = (generations.get(root) || 0) + 1; generations.set(root, n); return n; };
  const stop = async (root: string, invalidate = true) => {
    if (invalidate) bump(root);
    const runtime = remote.get(root);
    if (runtime) { runtime.oauth.disconnect(); clearInterval(runtime.timer); runtime.tunnel.kill('SIGTERM'); runtime.server.closeAllConnections(); runtime.server.close(); remote.delete(root); }
    else {
      const saved = read<RemoteConfig | null>(contained(root, 'state/connectors/remote.json'), null);
      if (saved) new HarnessOAuth(root, saved.origin, '', '').disconnect();
    }
  };
  return {
    close: () => { for (const root of remote.keys()) void stop(root); },
    async handle(path: string, method: string, root: string, token: string, base: string, data: any, human: boolean): Promise<any> {
      const actor = authenticate(root, token), workspace = read<{ id: string }>(contained(root, 'workspace.json'), { id: '' }).id;
      if (!workspace) throw new Error('Select a named workspace');
      const api = harnessApi(base, workspace, token), context = { root, token, api, connection: 'voice-' + createHash('sha256').update(actor.id).digest('hex').slice(0, 12) };
      if (method === 'GET' && path === '/v1/connectors') {
        const saved = read<RemoteConfig | null>(contained(root, 'state/connectors/remote.json'), null), runtime = remote.get(root);
        const oauth = runtime?.oauth || (saved ? new HarnessOAuth(root, saved.origin, base, workspace) : null);
        const cards = connectorCards(root, codeRoot, token), grants = oauth?.grants(actor) || [];
        const cloud = cards.find(c => c.id === 'grok-bot')!;
        const active = grants.filter(g => g.actor === actor.id && !g.revoked && g.expiresAt > Date.now() / 1000);
        cloud.status = !runtime?.running ? saved ? 'unavailable; local cloud connection stopped' : 'cloud setup required' : active.some(g => g.lastCall) ? 'remote tool verified; account flow unverified' : active.length ? 'authorized; awaiting remote tool call' : 'tunnel started; OAuth consent required';
        const review = pendingConfirmations(root).filter(r => {
          try {
            if (r.action.operation.startsWith('member-')) return ['owner', 'admin'].includes(actor.role);
            const meta = read<any>(contained(root, 'workdir/videos', r.action.id || r.action.videoId, 'meta.json'), {});
            authorize('read', { root, actor, edition: meta.edition || 'daily-roundup', platform: r.action.platform }); return true;
          } catch { return false; }
        });
        return { cards, review, conversation: conversationState(root),
          remote: { configured: Boolean(saved), origin: saved?.origin || '', running: runtime?.running || false, error: runtime?.error, cloudflared: Boolean(executable('cloudflared')), accountVerification: 'Grok Bot account/plugin flow is unverified until exercised in that account', grants, pending: oauth?.pending(actor) || [] } };
      }
      if (method !== 'POST') throw new Error('Unknown connector endpoint');
      // Voice may invoke only the named tool surface. Browser credentials never enter the model.
      if (path === '/v1/connectors/tool') { const body = z.object({ name: z.string(), arguments: z.unknown() }).strict().parse(data); return callHarnessTool(context, body.name, body.arguments); }
      if (path === '/v1/connectors/voice/session' || path === '/v1/connectors/voice/text') {
        authorize('read', { root, actor });
        const key = root + ':' + actor.id;
        if (voiceCalls.has(key)) throw new Error('Busy: voice request already in progress');
        voiceCalls.add(key);
        try { return path.endsWith('/session') ? await realtimeSession(root, z.object({ sdp: z.string() }).strict().parse(data).sdp) : await conversationText(context, data); }
        finally { voiceCalls.delete(key); }
      }
      if (!human) throw new Error('Forbidden: use the authenticated local browser confirmation control');
      if (['/v1/connectors/configure', '/v1/connectors/launch', '/v1/connectors/restore', '/v1/connectors/verify'].includes(path)) {
        const { agent } = z.object({ agent: z.string() }).strict().parse(data);
        if (path.endsWith('/restore')) return disconnectConnection(root, agent, token);
        if (path.endsWith('/launch')) return launchFromBrowser(root, agent, token);
        const connection = await configureConnection(root, agent, token);
        if (path.endsWith('/verify')) return verifyConnection(root, connection);
        return { message: 'Configuration saved. Complete native login/trust, then ask the host to call harness_status.' };
      }
      if (path === '/v1/connectors/review') {
        const body = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), allow: z.boolean() }).strict().parse(data);
        const file = contained(root, 'state/connector-review', body.id + '.json');
        const unlock = releaseLock(root, 'connector-review'); let request: any;
        try {
          request = read<any>(file, null);
          if (!request || request.status !== 'pending' || request.hash !== body.expectedHash || request.expiresAt <= Date.now()) throw new Error('Conflict: request expired, changed or already attempted');
          const op = request.action.operation;
          if (op === 'member-disable' && JSON.stringify(members(root).find(m => m.id === request.action.memberId)) !== request.memberSnapshot) throw new Error('Conflict: target membership changed; request fresh confirmation');
          const permission = op === 'approve' || op === 'engagement-approve' ? 'approve' : op.startsWith('member-') ? 'manage' : 'publish';
          const meta = request.action.id || request.action.videoId ? read<any>(contained(root, 'workdir/videos', request.action.id || request.action.videoId, 'meta.json'), {}) : null;
          const item = request.action.itemId ? engagementState(root).items.find(i => i.id === request.action.itemId) : undefined;
          authorize(permission, { root, actor, edition: meta?.edition || (meta ? 'daily-roundup' : undefined), author: item ? item.draftedBy : meta?.createdBy, platform: request.action.platform });
          if (!body.allow) { atomicJson(file, { ...request, status: 'denied', decidedBy: actor.id }); return { message: 'Request declined' }; }
          const requester = members(root).find(m => m.id === request.actor);
          if (!requester || requester.disabled || createHash('sha256').update(JSON.stringify(requester)).digest('hex') !== request.requesterHash) throw new Error('Forbidden: requester membership changed or was revoked; request fresh confirmation');
          if (request.origin?.kind === 'local' && loadConnection(root, request.origin.id, request.origin.generation).actor !== request.actor) throw new Error('Forbidden: originating connection changed');
          if (request.origin?.kind === 'oauth') {
            const grant = read<any>(contained(root, 'state/connectors/oauth/grants', request.origin.id + '.json'), null);
            if (!grant || grant.revoked || grant.expiresAt <= Date.now() / 1000 || grant.actor !== request.actor || authenticate(root, grant.memberToken).id !== request.actor) throw new Error('Forbidden: originating cloud grant expired or was revoked');
          }
          atomicJson(file, { ...request, status: 'attempted', decidedBy: actor.id, decidedAt: new Date().toISOString() });
        } finally { unlock(); }
        const { operation, ...bodyData } = request.action;
        try {
          const result = await api(operation === 'approve' ? '/v1/packages/' + bodyData.id + '/approve' : '/v1/journey/' + operation, bodyData, 'confirmation:' + request.id);
          // Member credentials are returned only to this browser response, never stored in the queue.
          atomicJson(file, { ...request, status: 'submitted', decidedBy: actor.id, result: result.job ? { job: result.job } : { accepted: true } });
          return result;
        } catch (error) { atomicJson(file, { ...request, status: 'failed', decidedBy: actor.id }); throw error; }
      }
      if (path === '/v1/connectors/remote/verify') {
        const runtime = remote.get(root); if (!runtime?.running) throw new Error('Remote connector unavailable; start the named tunnel first');
        const response = await fetch(runtime.oauth.origin + '/.well-known/oauth-protected-resource/mcp', { redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok || (await response.json()).resource !== runtime.oauth.resource) throw new Error('Public connector resource could not be verified');
        const proof = runtime.oauth.grants(actor).find(g => g.actor === actor.id && !g.revoked && g.expiresAt > Date.now() / 1000 && g.lastCall);
        if (!proof) throw new Error('Public resource reachable; a successful remote harness_status call is still required');
        return { message: 'Public resource and prior remote tool receipt verified. Grok Bot account-specific support requires its actual plugin flow.', proof: proof.lastCall };
      }
      if (path === '/v1/connectors/remote/consent') {
        const body = z.object({ id: z.string(), expectedHash: z.string(), allow: z.boolean() }).strict().parse(data);
        const runtime = remote.get(root); if (!runtime?.running) throw new Error('Remote connector unavailable');
        return runtime.oauth.consent(body.id, token, body.expectedHash, body.allow);
      }
      if (path === '/v1/connectors/remote/revoke') {
        const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(data);
        const saved = read<RemoteConfig | null>(contained(root, 'state/connectors/remote.json'), null); if (!saved) throw new Error('No remote connection');
        const provider = remote.get(root)?.oauth || new HarnessOAuth(root, saved.origin, base, workspace);
        if (!provider.grants(actor).some(g => g.id === id)) throw new Error('Forbidden: grant belongs to another member');
        provider.revoke(id); return { message: 'Grant revoked immediately' };
      }
      authorize('manage', { root, actor });
      if (path === '/v1/connectors/remote/stop') { await stop(root); return { message: 'All remote grants revoked and harness-managed tunnel stopped' }; }
      if (path === '/v1/connectors/remote/configure') {
        const config = remoteSchema.parse(data);
        if (!isAbsolute(config.credentialsFile) || !existsSync(config.credentialsFile) || !statSync(config.credentialsFile).isFile()) throw new Error('Choose the existing named tunnel credentials JSON file');
        const credentials = JSON.parse(readFileSync(config.credentialsFile, 'utf8'));
        if (credentials.TunnelID !== config.tunnelId || typeof credentials.TunnelSecret !== 'string') throw new Error('Credentials do not match the named tunnel');
        await stop(root); atomicJson(contained(root, 'state/connectors/remote.json'), config);
        return { message: 'Named tunnel saved. Its DNS route must already point to this tunnel. Start it explicitly to enable cloud access.' };
      }
      if (path === '/v1/connectors/remote/start') {
        if (remote.get(root)?.running) return { message: 'Remote connector already running' };
        const generation = bump(root);
        const stopFile = contained(root, 'state/connectors/remote-stop.json'); if (existsSync(stopFile)) unlinkSync(stopFile);
        await stop(root, false);
        const config = remoteSchema.parse(read(contained(root, 'state/connectors/remote.json'), {}));
        const binary = executable('cloudflared'); if (!binary) throw new Error('Install cloudflared before starting the named tunnel');
        const oauth = new HarnessOAuth(root, config.origin, base, workspace), app = createRemoteApp(oauth);
        const server = await new Promise<Server>((resolve, reject) => { const s = app.listen(config.port, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
        try {
        if (generations.get(root) !== generation || existsSync(stopFile)) throw new Error('Remote connection start cancelled by disconnect');
        const yaml = contained(root, 'state/connectors/tunnel.yml');
        writeFileSync(yaml, stringify({ tunnel: config.tunnelId, 'credentials-file': config.credentialsFile, ingress: [{ hostname: new URL(config.origin).hostname, path: '^/(mcp|authorize|token|register|revoke|\\.well-known/.*)$', service: 'http://127.0.0.1:' + config.port, originRequest: { httpHostHeader: new URL(config.origin).host } }, { service: 'http_status:404' }] }), { mode: 0o600 });
        const tunnel = spawn(binary, ['tunnel', '--config', yaml, 'run', config.tunnelId], { stdio: 'ignore' });
        const runtime: Remote = { oauth, server, tunnel, running: true }; remote.set(root, runtime);
        runtime.timer = setInterval(() => { if (existsSync(stopFile)) void stop(root); }, 500); runtime.timer.unref();
        tunnel.once('error', () => { runtime.running = false; runtime.error = 'cloudflared could not start'; clearInterval(runtime.timer); server.closeAllConnections(); server.close(); });
        tunnel.once('exit', code => { runtime.running = false; clearInterval(runtime.timer); runtime.error = `Tunnel stopped (${code}); cloud tools are unavailable. No actions replayed.`; server.close(); });
        return { message: 'Tunnel process started. Public reachability and Grok Bot account/plugin support still require a successful external tool call.', url: oauth.resource };
        } catch (error) { server.closeAllConnections(); server.close(); throw error; }
      }
      throw new Error('Unknown connector endpoint');
    },
  };
}
