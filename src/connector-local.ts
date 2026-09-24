import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CODE_ROOT, atomicJson, authenticate, contained, read } from './workspaces.js';
import { configureHost, restoreHost, hostFor, executable, connectionId, connectionPath, loadConnection, recordToolCall, type Connection } from './connector-hosts.js';
import { harnessApi, createHarnessMcp, callHarnessTool, TOOL_DEFINITIONS } from './connector-tools.js';
import { releaseLock } from './release-lock.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { portableCommand } from './platform.js';

const cliArgs = (c: Connection) => [join(CODE_ROOT, 'connect.mjs'), c.agent, '--workspace', c.workspace, '--connection', c.id, '--generation', c.generation, '--serve'];
async function native(command: string, args: string[]) {
  const spec = portableCommand(command, args);
  await promisify(execFile)(spec.command, spec.args, { cwd: CODE_ROOT, timeout: 60000, maxBuffer: 1024 * 1024 });
}
const connectionGenerations = new Map<string, number>();
const hostOperations = new Map<string, Promise<any>>();
function hostOperation<T>(root: string, id: string, run: () => Promise<T>): Promise<T> {
  const key = root + ':' + id;
  const next = (hostOperations.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const unlock = releaseLock(root, 'host-' + id);
    try { return await run(); } finally { unlock(); }
  }).finally(() => { if (hostOperations.get(key) === next) hostOperations.delete(key); });
  hostOperations.set(key, next); return next;
}
export function configureConnection(root: string, agent: string, token: string): Promise<Connection> {
  const actor = authenticate(root, token);
  const id = connectionId(agent, actor.id), key = root + ':' + id, generation = connectionGenerations.get(key) || 0;
  const validate = () => { if ((connectionGenerations.get(key) || 0) !== generation) throw new Error('Connection setup cancelled by disconnect'); };
  return hostOperation(root, id, () => { validate(); return configure(root, agent, token, validate); });
}
async function configure(root: string, agent: string, token: string, validate: () => void): Promise<Connection> {
  const actor = authenticate(root, token), host = hostFor(agent);
  if (host.kind === 'remote') throw new Error('Configure the customer-owned tunnel in the local browser');
  const id = connectionId(agent, actor.id), file = connectionPath(root, id);
  const ready = () => { validate(); const unlock = releaseLock(root, 'connect-' + id); try { const c = { ...loadConnection(root, id), ready: true }; atomicJson(file, c); return c; } finally { unlock(); } };
    let c = read<Connection | null>(file, null);
    if (c && !c.revoked) {
      loadConnection(root, id);
      if (c.agent === 'codex' && !c.ready) {
        await native('codex', ['plugin', 'marketplace', 'add', join(c.plugin!, '../..')]);
        await native('codex', ['plugin', 'add', 'content-harness@' + c.marketplace]);
        c = ready();
      }
      return c;
    }
    c = { id, agent, actor: actor.id, token, generation: randomBytes(16).toString('hex'), workspace: read<{ id: string }>(contained(root, 'workspace.json'), { id: '' }).id, installedAt: new Date().toISOString() };
    if (!c.workspace) throw new Error('Create a named workspace before connecting');
    const name = 'content-harness-' + createHash('sha256').update(root + ':' + id).digest('hex').slice(0, 16);
    if (host.kind === 'plugin') {
      const marketplace = contained(root, 'state/connectors/native', name), plugin = join(marketplace, 'plugins', 'content-harness');
      mkdirSync(plugin, { recursive: true, mode: 0o700 }); cpSync(join(CODE_ROOT, 'plugins/content-harness'), plugin, { recursive: true });
      const mcpServers = { [name]: { command: process.execPath, args: cliArgs(c) } };
      atomicJson(join(plugin, '.mcp.json'), { mcpServers });
      c.plugin = plugin;
      if (agent === 'codex') {
        const manifest = join(plugin, '.codex-plugin/plugin.json');
        atomicJson(manifest, { ...read<Record<string, unknown>>(manifest, {}), mcpServers });
        c.marketplace = name;
        atomicJson(join(marketplace, '.agents/plugins/marketplace.json'), { name, interface: { displayName: 'Content Harness' }, plugins: [{ name: 'content-harness', source: { source: 'local', path: './plugins/content-harness' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }] });
      }
    } else if (host.kind === 'extension') {
      c.plugin = contained(root, 'state/connectors/native', name, 'harness.ts');
      mkdirSync(join(c.plugin, '..'), { recursive: true, mode: 0o700 });
      const moduleUrl = pathToFileURL(join(CODE_ROOT, 'src/connector-local.ts')).href;
      writeFileSync(c.plugin, `import { createRequire } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nconst require = createRequire(${JSON.stringify(pathToFileURL(join(CODE_ROOT, 'connect.mjs')).href)});\nconst { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href); register();\nexport default async function(pi) { const { installPiTools } = await import(${JSON.stringify(moduleUrl)}); return installPiTools(pi, ${JSON.stringify(root)}, ${JSON.stringify(id)}, ${JSON.stringify(c.generation)}); }\n`, { mode: 0o600 });
    } else c.config = configureHost(agent, root, CODE_ROOT, name, process.execPath, cliArgs(c));
    // Record before native installation, so even an interrupted install remains revocable.
    const unlock = releaseLock(root, 'connect-' + id); try { atomicJson(file, c); } finally { unlock(); }
    if (agent === 'codex') {
      await native('codex', ['plugin', 'marketplace', 'add', join(c.plugin!, '../..')]);
      await native('codex', ['plugin', 'add', 'content-harness@' + c.marketplace]);
    }
    return ready();
}
/**
 * A plugin installed from the repository's own marketplace binds itself on first launch (plugins/content-harness/bin/serve.mjs →
 * `connect.mjs <agent> --serve-self`): the local owner's token, a private connection record under the workspace, no edits to
 * the agent's settings and no native install. An existing launcher-made connection for the same agent and actor is reused.
 */
export function selfServeConnection(root: string, agent: string, token: string): Connection {
  const actor = authenticate(root, token); hostFor(agent);
  const id = connectionId(agent, actor.id), file = connectionPath(root, id);
  const unlock = releaseLock(root, 'connect-' + id);
  try {
    const existing = read<Connection | null>(file, null);
    if (existing && !existing.revoked) return loadConnection(root, id);
    const workspace = read<{ id: string }>(contained(root, 'workspace.json'), { id: '' }).id;
    if (!workspace) throw new Error('Create a named workspace before connecting');
    const c: Connection = { id, agent, actor: actor.id, token, generation: randomBytes(16).toString('hex'), workspace, installedAt: new Date().toISOString(), ready: true, selfServe: true };
    atomicJson(file, c);
    return c;
  } finally { unlock(); }
}
export async function disconnectConnection(root: string, agent: string, token: string) {
  const actor = authenticate(root, token), file = connectionPath(root, connectionId(agent, actor.id));
  const key = root + ':' + connectionId(agent, actor.id); connectionGenerations.set(key, (connectionGenerations.get(key) || 0) + 1);
  const unlock = releaseLock(root, 'connect-' + connectionId(agent, actor.id));
  let c: Connection | null;
  try { c = read<Connection | null>(file, null); if (!c) return { message: 'No harness configuration to restore' }; atomicJson(file, { ...c, token: '', revoked: true }); }
  finally { unlock(); }
  const connection = c;
  return hostOperation(root, connectionId(agent, actor.id), async () => {
  if (connection.config) restoreHost(connection.config);
  if (connection.agent === 'codex' && connection.marketplace) {
    await native('codex', ['plugin', 'remove', 'content-harness@' + connection.marketplace]);
    await native('codex', ['plugin', 'marketplace', 'remove', connection.marketplace]);
  }
  return { message: 'Connection revoked. Only harness-owned configuration was restored. Close the agent to end its session.' };
  });
}

export async function embeddedConnector(root: string, id: string, generation?: string) {
  const c = loadConnection(root, id, generation);
  const { createControlServer } = await import('./control.js');
  const http = createControlServer();
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No loopback listener');
  const api = harnessApi('http://127.0.0.1:' + address.port, c.workspace, c.token);
  const context = { root, token: c.token, connection: c.id, origin: { kind: 'local' as const, id: c.id, generation: c.generation }, validate: () => { loadConnection(root, id, c.generation); }, api: (path: string, data?: unknown, key?: string) => { loadConnection(root, id, c.generation); return api(path, data, key); } };
  return { context, close: () => { http.closeAllConnections(); http.close(); } };
}
export async function serveConnection(root: string, id: string, generation: string) {
  const embedded = await embeddedConnector(root, id, generation);
  const server = createHarnessMcp(embedded.context, (client, tool) => recordToolCall(root, id, client, tool, generation));
  const transport = new StdioServerTransport();
  server.server.onclose = () => embedded.close();
  const close = () => { void server.close(); embedded.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close); process.stdin.once('end', close);
  await server.connect(transport);
}
export async function verifyConnection(root: string, c: Connection) {
  const client = new Client({ name: 'Harness verification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: cliArgs(c), stderr: 'pipe' });
  let diagnostic = ''; transport.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
  try {
    await client.connect(transport, { timeout: 30000 });
    const result = await client.callTool({ name: 'harness_status', arguments: {} }, undefined, { timeout: 30000 });
    if (result.isError) throw new Error('Harness tool call failed');
    return { message: 'Actual MCP tool call passed. Launch the host and call harness_status to verify its integration.', tool: 'harness_status', workspace: c.workspace };
  } catch (error) { throw new Error((diagnostic || (error as Error).message).split(c.token).join('[redacted]')); }
  finally { await client.close(); await transport.close(); }
}
export async function installPiTools(pi: any, root: string, id: string, generation?: string) {
  const { z } = await import('zod');
  const embedded = await embeddedConnector(root, id, generation);
  for (const [name, definition] of Object.entries(TOOL_DEFINITIONS)) pi.registerTool({
    name, label: name.replaceAll('_', ' '), description: definition.description, parameters: z.toJSONSchema(definition.schema),
    execute: async (_callId: string, args: unknown) => {
      try { loadConnection(root, id); const result = await callHarnessTool(embedded.context, name, args); recordToolCall(root, id, 'Pi', name, embedded.context.origin.generation); return { content: [{ type: 'text', text: JSON.stringify({ trust: 'untrusted-data', result }) }], details: {} }; }
      catch (error) { return { content: [{ type: 'text', text: (error as Error).message.split(embedded.context.token).join('[redacted]') }], isError: true, details: {} }; }
    },
  });
  pi.on('session_shutdown', () => embedded.close());
}
export function launchSpec(c: Connection) {
  const host = hostFor(c.agent);
  const args = c.agent === 'claude' ? ['--plugin-dir', c.plugin!] : c.agent === 'pi' ? ['-e', c.plugin!] : c.agent === 'openclaw' ? ['tui'] : c.agent === 'vscode' || c.agent === 'cursor' ? [CODE_ROOT] : [];
  if (['codex', 'claude'].includes(c.agent)) args.push('Call harness_setup, read the saved use case and guidance, then help me set up my publication. Ask only missing questions one at a time. Use harness_configure for safe settings; credentials, channel consent, access changes and publishing stay in my browser.');
  return portableCommand(host.bin, args);
}
export async function launchFromBrowser(root: string, agent: string, token: string) {
  const actor = authenticate(root, token); hostFor(agent);
  const id = connectionId(agent, actor.id);
  // Bind identity before opening a terminal; the terminal never receives the member token.
  const c = await configureConnection(root, agent, token);
  if (!executable(hostFor(agent).bin)) return { message: 'Configuration saved. Install the host, then run the displayed setup command.' };
  const args = [join(CODE_ROOT, 'connect.mjs'), agent, '--workspace', c.workspace, '--connection', id, '--launch-only'];
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  if (process.platform === 'darwin') {
    const script = contained(root, 'state/connectors', id + '.command');
    writeFileSync(script, '#!/bin/sh\ncd ' + quote(CODE_ROOT) + '\nexec ' + [process.execPath, ...args].map(quote).join(' ') + '\n', { mode: 0o700 });
    await promisify(execFile)('open', ['-a', 'Terminal', script]);
  } else if (process.platform === 'win32') {
    const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    const script = 'Set-Location -LiteralPath ' + q(CODE_ROOT) + '; & ' + [process.execPath, ...args].map(q).join(' ');
    const child = spawn('powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore' }); await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  } else {
    const child = spawn('x-terminal-emulator', ['-e', process.execPath, ...args], { cwd: CODE_ROOT, detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  }
  return { message: 'Host launched with its native login/trust prompts. Ask it to call harness_status, then refresh connection status.' };
}
