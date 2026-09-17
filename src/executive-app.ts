import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { CODE_ROOT, createWorkspace, workspaceRoot, localToken, authenticate, safeId } from './workspaces.js';

const slug = safeId(process.env.HARNESS_WORKSPACE || 'default');
if (!existsSync(join(CODE_ROOT, 'workspaces', slug, 'workspace.json'))) {
  if (process.env.HARNESS_TOKEN || process.env.HARNESS_WORKSPACE) throw new Error('This workspace does not exist. Open an existing workspace to create another publication.');
  createWorkspace(slug);
}
const root = workspaceRoot(CODE_ROOT, slug);
const token = localToken(root);
authenticate(root, token);
process.env.HARNESS_WORKSPACE = slug;
process.env.PATH = join(CODE_ROOT, '.tools/bin') + delimiter + (process.env.PATH || '');
const { createControlServer } = await import('./control.js');
const server = createControlServer();
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No browser address');
const url = `http://127.0.0.1:${address.port}/journey?workspace=${encodeURIComponent(slug)}`;
console.log(`Content workspace: ${url}\nKeep this window open. Close with Ctrl+C.`);
// The fragment never reaches the HTTP server or its request logs; the page removes it immediately.
const { openExternal } = await import('./platform.js');
openExternal(url + '#token=' + token, error => console.error(`Browser could not open: ${error.message}. Restart from a desktop terminal.`));
