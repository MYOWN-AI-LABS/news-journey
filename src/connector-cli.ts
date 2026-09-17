import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { CODE_ROOT, workspaceRoot, localToken, contained, read, authenticate, authorize, atomicJson } from './workspaces.js';
import { HarnessOAuth } from './connector-remote.js';
import { connectionId, hostFor, loadConnection, connectorCards } from './connector-hosts.js';
import { configureConnection, disconnectConnection, selfServeConnection, serveConnection, verifyConnection, launchSpec } from './connector-local.js';
const { values, positionals } = parseArgs({ allowPositionals: true, options: { workspace: { type: 'string' }, connection: { type: 'string' }, generation: { type: 'string' }, 'configure-only': { type: 'boolean' }, 'launch-only': { type: 'boolean' }, 'serve-self': { type: 'boolean' }, restore: { type: 'boolean' }, verify: { type: 'boolean' }, serve: { type: 'boolean' }, status: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help || !positionals.length) {
  console.log('node connect.mjs <codex|claude|cursor|vscode|gemini|opencode|zcode|hermes|openclaw|droid|copilot|grok|pi|grok-bot> --workspace <id> [--configure-only|--restore|--verify|--status|--serve-self]');
} else try {
  const agent = positionals[0]; hostFor(agent);
  if (positionals.length !== 1 || ['configure-only', 'launch-only', 'restore', 'verify', 'serve', 'serve-self', 'status'].filter(k => values[k as keyof typeof values]).length > 1) throw new Error('Choose one agent and one launcher mode');
  if (!values.workspace) throw new Error('--workspace is required');
  process.env.HARNESS_WORKSPACE = values.workspace;
  const root = workspaceRoot(CODE_ROOT, values.workspace);
  if (values['serve-self']) { const c = selfServeConnection(root, agent, localToken(root)); await serveConnection(root, c.id, c.generation); }
  else if (values.serve) { if (!values.connection || !values.generation) throw new Error('--connection and --generation required'); const c = loadConnection(root, values.connection, values.generation); if (c.agent !== agent) throw new Error('Agent binding mismatch'); await serveConnection(root, c.id, values.generation); }
  else if (agent === 'grok-bot') {
    const token = localToken(root), actor = authenticate(root, token), saved = read<any>(contained(root, 'state/connectors/remote.json'), null);
    if (values.restore) {
      authorize('manage', { root, actor });
      if (saved) new HarnessOAuth(root, saved.origin, '', values.workspace).disconnect();
      atomicJson(contained(root, 'state/connectors/remote-stop.json'), { actor: actor.id, at: new Date().toISOString() });
      console.log('All cloud grants revoked immediately. The running harness stops its managed tunnel within 500 ms. Saved customer tunnel settings are retained.');
    } else if (values.status || values.verify) {
      const grants = saved ? new HarnessOAuth(root, saved.origin, '', values.workspace).grants(actor) : [];
      console.log(JSON.stringify({ configured: Boolean(saved), endpoint: saved ? saved.origin + '/mcp' : null, grants, accountFlow: 'unverified' }, null, 2));
      let reachable = false;
      if (saved && values.verify) { try { const response = await fetch(saved.origin + '/.well-known/oauth-protected-resource/mcp', { signal: AbortSignal.timeout(10000), redirect: 'error' }); reachable = response.ok && (await response.json()).resource === saved.origin + '/mcp'; } catch {} }
      if (values.verify && !reachable) throw new Error('Remote connector unavailable at its public HTTPS resource. No actions replayed.');
      if (values.verify && !grants.some(g => !g.revoked && g.expiresAt > Date.now() / 1000 && g.lastCall)) throw new Error('No unexpired remote tool-call proof. Complete Grok Bot OAuth and call harness_status in that account.');
    } else if (values['configure-only']) console.log('Configure the named Cloudflare tunnel in node start.mjs → Connect & Launch → Grok Bot. No cloud account has been connected.');
    else { const child = spawn(process.execPath, ['--import', 'tsx', CODE_ROOT + '/src/executive-app.ts'], { cwd: CODE_ROOT, stdio: 'inherit', env: { ...process.env, HARNESS_WORKSPACE: values.workspace, HARNESS_TOKEN: token } }); child.once('error', e => { console.error(e.message); process.exitCode = 1; }); }
  }
  else {
    const token = values.connection ? loadConnection(root, values.connection).token : localToken(root);
    if (values.status) console.log(JSON.stringify(connectorCards(root, CODE_ROOT, token).find(c => c.id === agent), null, 2));
    else if (values.restore) console.log((await disconnectConnection(root, agent, token)).message);
    else {
      const c = values['launch-only'] && values.connection ? loadConnection(root, values.connection) : await configureConnection(root, agent, token);
      if (values.verify) console.log(JSON.stringify(await verifyConnection(root, c)));
      else if (values['configure-only']) console.log('Configured. Native login/trust and an actual host tool call are still required.');
      else { const spec = launchSpec(c); const env = { ...process.env }; delete env.HARNESS_TOKEN; const child = spawn(spec.command, spec.args, { cwd: CODE_ROOT, stdio: 'inherit', env }); child.once('error', e => { console.error(e.message); process.exitCode = 1; }); child.once('exit', code => { process.exitCode = code || 0; }); }
    }
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
