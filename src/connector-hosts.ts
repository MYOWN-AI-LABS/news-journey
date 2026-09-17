import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import JSON5 from 'json5';
import TOML from '@iarna/toml';
import { parseDocument } from 'yaml';
import { atomicJson, contained, read, safeId, authenticate } from './workspaces.js';
import { releaseLock } from './release-lock.js';

export const HOSTS = [
  { id: 'codex', name: 'Codex', bin: 'codex', kind: 'plugin', docs: 'https://developers.openai.com/codex/plugins' },
  { id: 'claude', name: 'Claude Code', bin: 'claude', kind: 'plugin', docs: 'https://code.claude.com/docs/en/plugins' },
  { id: 'cursor', name: 'Cursor', bin: 'cursor', kind: 'json', path: '.cursor/mcp.json', keys: ['mcpServers'], docs: 'https://docs.cursor.com/context/model-context-protocol' },
  { id: 'vscode', name: 'VS Code Copilot', bin: 'code', kind: 'json', path: '.vscode/mcp.json', keys: ['servers'], project: true, docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers' },
  // Antigravity (IDE and the agy CLI) share one global MCP file; Google's Gemini CLI no longer serves individual subscriptions.
  { id: 'antigravity', name: 'Antigravity', bin: 'agy', kind: 'json', path: '.gemini/config/mcp_config.json', keys: ['mcpServers'], docs: 'https://docs.antigravity.google/docs/mcp/' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', kind: 'json', path: '.config/opencode/opencode.json', keys: ['mcp'], docs: 'https://opencode.ai/docs/mcp-servers/' },
  { id: 'zcode', name: 'Z.AI / ZCode', bin: 'zcode', kind: 'json', path: '.zcode/cli/config.json', keys: ['mcp', 'servers'], docs: 'https://zcode.z.ai/en/docs/mcp-services' },
  { id: 'hermes', name: 'Hermes', bin: 'hermes', kind: 'yaml', path: '.hermes/config.yaml', keys: ['mcp_servers'], docs: 'https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference' },
  { id: 'openclaw', name: 'OpenClaw', bin: 'openclaw', kind: 'json5', path: '.openclaw/openclaw.json', keys: ['mcp', 'servers'], docs: 'https://docs.openclaw.ai/cli/mcp' },
  { id: 'droid', name: 'Droid', bin: 'droid', kind: 'json', path: '.factory/mcp.json', keys: ['mcpServers'], docs: 'https://docs.factory.ai/harness/mcp' },
  { id: 'copilot', name: 'Copilot CLI', bin: 'copilot', kind: 'json', path: '.copilot/mcp-config.json', keys: ['mcpServers'], docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-server' },
  { id: 'grok', name: 'Grok Build', bin: 'grok', kind: 'toml', path: '.grok/config.toml', keys: ['mcp_servers'], docs: 'https://docs.x.ai/build/features/mcp-servers' },
  { id: 'pi', name: 'Pi', bin: 'pi', kind: 'extension', docs: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md' },
  { id: 'grok-bot', name: 'Grok Bot', bin: '', kind: 'remote', docs: 'https://docs.x.ai/grok-bot/overview' },
] as const;
export type HostId = typeof HOSTS[number]['id'];
export function hostFor(value: string) { const host = HOSTS.find(h => h.id === value); if (!host) throw new Error('Unknown agent: ' + value); return host; }
export function executable(name: string): string | undefined {
  if (!name) return undefined;
  for (const dir of (process.env.PATH || '').split(delimiter)) for (const suffix of process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']) {
    const file = join(dir, name + suffix); try { if (statSync(file).isFile()) return file; } catch { /* next PATH entry */ }
  }
}
export const connectionId = (agent: string, actor: string) => safeId(agent) + '-' + createHash('sha256').update(actor).digest('hex').slice(0, 12);
export const connectionPath = (root: string, id: string) => contained(root, 'state/connectors', safeId(id) + '.json');
export interface Connection { id: string; agent: string; actor: string; token: string; workspace: string; generation: string; revoked?: boolean; ready?: boolean; selfServe?: boolean; installedAt: string; proof?: { client: string; tool: string; at: string; pid: number }; config?: ConfigReceipt; plugin?: string; marketplace?: string }
export function loadConnection(root: string, id: string, generation?: string): Connection {
  const value = read<Connection | null>(connectionPath(root, id), null);
  if (!value || value.revoked || !/^[a-f0-9]{32}$/.test(value.generation || '') || generation !== undefined && value.generation !== generation || authenticate(root, value.token).id !== value.actor) throw new Error('Unauthorized: connection revoked, superseded or membership changed');
  return value;
}
export function recordToolCall(root: string, id: string, client: string, tool: string, generation?: string) {
  const unlock = releaseLock(root, 'connect-' + id);
  try { const c = loadConnection(root, id, generation);
    if (client === 'Harness verification' && c.proof && c.proof.client !== client) { try { process.kill(c.proof.pid, 0); return; } catch {} }
    atomicJson(connectionPath(root, id), { ...c, proof: { client, tool, at: new Date().toISOString(), pid: process.pid } }); }
  finally { unlock(); }
}
export interface ConfigReceipt { file: string; kind: string; keys: string[]; before?: unknown; installed: unknown; backup: string; created: boolean; block?: string }
function parseConfig(raw: string, kind: string): any {
  if (kind === 'yaml') { const doc = parseDocument(raw); if (doc.errors.length) throw new Error('Invalid existing YAML; configuration left unchanged'); return doc.toJS() || {}; }
  if (kind === 'toml') return TOML.parse(raw);
  if (kind === 'json5') { const value = JSON5.parse(raw || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON5 object'); return value; }
  const errors: ParseError[] = []; const value = parse(raw || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid existing JSON configuration; left unchanged');
  return value;
}
const valueAt = (value: any, keys: string[]) => keys.reduce((v, k) => v?.[k], value);
function writeConfig(file: string, raw: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.harness-' + randomBytes(6).toString('hex');
  writeFileSync(temp, raw, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 }); renameSync(temp, file);
}
function changed(raw: string, kind: string, keys: string[], value: unknown): string {
  if (kind === 'yaml') { const doc = parseDocument(raw); value === undefined ? doc.deleteIn(keys) : doc.setIn(keys, value); return doc.toString(); }
  if (kind === 'json5') {
    const obj = parseConfig(raw, kind); let parent = obj;
    for (const key of keys.slice(0, -1)) { if (parent[key] === undefined) parent[key] = {}; parent = parent[key]; }
    if (value === undefined) delete parent[keys.at(-1)!]; else parent[keys.at(-1)!] = value;
    return JSON.stringify(obj, null, 2) + '\n';
  }
  return applyEdits(raw || '{}\n', modify(raw || '{}\n', keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}
/** Change one connector key, with a private original-byte backup. Restore never replaces the whole settings file. */
export function configureHost(agent: string, root: string, codeRoot: string, name: string, command: string, args: string[], home = homedir()): ConfigReceipt {
  const host = hostFor(agent);
  if (!('path' in host)) throw new Error('This agent uses a native plugin/extension or remote connection');
  const configuredFile = join('project' in host ? codeRoot : home, host.path);
  const file = existsSync(configuredFile) ? realpathSync(configuredFile) : configuredFile;
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : host.kind === 'json' ? '{}\n' : '';
  const current = parseConfig(raw, host.kind), keys = [...host.keys, name];
  if (valueAt(current, keys) !== undefined) throw new Error('A connector already uses this name; no settings changed');
  const installed = agent === 'opencode' ? { type: 'local', command: [command, ...args], enabled: true } : { ...(agent === 'vscode' || agent === 'copilot' || agent === 'droid' ? { type: 'stdio' } : {}), command, args, ...(agent === 'copilot' ? { tools: ['*'] } : {}) };
  const backup = contained(root, 'state/connectors/backups', name + '-' + Date.now() + '.json');
  const receipt: ConfigReceipt = { file, kind: host.kind, keys, installed, backup, created: !existsSync(file) };
  let next;
  if (host.kind === 'toml') {
    // Append a unique table; parse the complete result, preserving every existing TOML byte.
    receipt.block = '\n# content-harness ' + name + '\n[' + keys.join('.') + ']\ncommand = ' + JSON.stringify(command) + '\nargs = ' + JSON.stringify(args) + '\n';
    next = raw + receipt.block;
  } else next = changed(raw, host.kind, keys, installed);
  parseConfig(next, host.kind);
  atomicJson(backup, { file, raw, receipt });
  // Refuse concurrent edits rather than replacing a newly written provider credential.
  if ((existsSync(file) ? readFileSync(file, 'utf8') : host.kind === 'json' ? '{}\n' : '') !== raw) throw new Error('Configuration changed concurrently; retry');
  writeConfig(file, next); return receipt;
}
export function restoreHost(receipt: ConfigReceipt): void {
  if (!existsSync(receipt.file)) return;
  const raw = readFileSync(receipt.file, 'utf8'), config = parseConfig(raw, receipt.kind), value = valueAt(config, receipt.keys);
  if (value === undefined) return;
  if (!isDeepStrictEqual(value, receipt.installed)) throw new Error('Harness entry was edited after connection. Grant revoked; configuration retained for manual review.');
  const original = read<{ raw: string }>(receipt.backup, { raw: '' }).raw;
  let next: string;
  if (receipt.kind === 'toml') {
    if (!receipt.block || !raw.includes(receipt.block)) throw new Error('Harness TOML block changed; retained for review');
    next = raw.replace(receipt.block, '');
  } else {
    next = changed(raw, receipt.kind, receipt.keys, receipt.before);
    // Remove only empty parents which the connector itself created.
    const before = parseConfig(original, receipt.kind);
    for (let n = receipt.keys.length - 1; n > 0; n--) {
      const parent = receipt.keys.slice(0, n), value = valueAt(parseConfig(next, receipt.kind), parent);
      if (valueAt(before, parent) === undefined && value && Object.keys(value).length === 0) next = changed(next, receipt.kind, parent, undefined);
    }
  }
  if (readFileSync(receipt.file, 'utf8') !== raw) throw new Error('Configuration changed concurrently; retry restore');
  if (receipt.created && Object.keys(parseConfig(next, receipt.kind)).length === 0) unlinkSync(receipt.file);
  else writeConfig(receipt.file, next);
}

export function connectorCards(root: string, codeRoot: string, token: string) {
  const actor = authenticate(root, token);
  const workspace = read<{ id: string }>(contained(root, 'workspace.json'), { id: 'default' }).id;
  return HOSTS.map(host => {
    const c = read<Connection | null>(connectionPath(root, connectionId(host.id, actor.id)), null);
    let live = false; if (c?.proof) try { process.kill(c.proof.pid, 0); live = true; } catch { /* process ended */ }
    const installed = Boolean(executable(host.bin));
    return { id: host.id, name: host.name, kind: host.kind, installed, documentation: host.docs,
      status: c?.revoked ? 'disconnected' : c?.proof && live && c.proof.client !== 'Harness verification' ? 'connected' : c?.proof ? 'tool verified; host connection pending' : c ? 'configured; awaiting tool call' : installed ? 'detected' : host.kind === 'remote' ? 'cloud setup required' : 'not detected',
      proof: c?.proof ? { client: c.proof.client, tool: c.proof.tool, at: c.proof.at } : null,
      setup: `node connect.mjs ${host.id} --workspace ${workspace}`, verify: `node connect.mjs ${host.id} --workspace ${workspace} --verify`, restore: `node connect.mjs ${host.id} --workspace ${workspace} --restore`,
    };
  });
}
