#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const prepared = spawnSync(process.execPath, [join(root, 'start.mjs'), '--prepare-only', '--configure-only'], { stdio: 'inherit' });
if (prepared.status !== 0) process.exit(prepared.status ?? 1);
const app = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/executive-app.ts')], { cwd: root, stdio: 'inherit' });
process.exit(app.status ?? 1);
