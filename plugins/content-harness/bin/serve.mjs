#!/usr/bin/env node
// The plugin's MCP server entry, launched by Claude Code or Codex over stdio.
// It finds the harness checkout, binds this agent to the owner's workspace on first launch (a private
// connection record under the workspace's state, nothing written into the agent's own settings) and
// serves the bounded harness tools. No credential lives in this file or in any manifest.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const looksLikeHarness = dir => dir && existsSync(join(dir, 'connect.mjs')) && existsSync(join(dir, 'src/connector-cli.ts'));
const candidates = [process.env.CONTENT_HARNESS_ROOT, resolve(here, '../../..')];
const root = candidates.find(looksLikeHarness);
if (!root) {
  console.error('Content Harness checkout not found. Set CONTENT_HARNESS_ROOT to the folder that contains connect.mjs.');
  process.exit(2);
}
if (!existsSync(join(root, 'node_modules/tsx'))) {
  console.error(`Content Harness at ${root} has no installed dependencies. Run "npm install" there once, or set CONTENT_HARNESS_ROOT to your working checkout.`);
  process.exit(2);
}
// Claude Code exposes CLAUDE_PLUGIN_ROOT to plugin servers; anything else is treated as Codex unless overridden.
const agent = process.env.CONTENT_HARNESS_AGENT || (process.env.CLAUDE_PLUGIN_ROOT ? 'claude' : 'codex');
const workspace = process.env.HARNESS_WORKSPACE || 'default';
const child = spawn(process.execPath, [join(root, 'connect.mjs'), agent, '--workspace', workspace, '--serve-self'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, HARNESS_WORKSPACE: workspace },
});
child.once('error', error => { console.error(error.message); process.exit(1); });
child.once('exit', code => process.exit(code ?? 1));
