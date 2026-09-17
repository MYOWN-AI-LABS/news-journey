#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'workdir'), { recursive: true });
const env = { ...process.env, HARNESS_IDENTITY_FILE: join(root, 'workdir/free-test-identity.json') };
delete env.HARNESS_TOKEN; delete env.HARNESS_WORKSPACE;
const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/free-release-check.mts'], { cwd: root, env, stdio: 'inherit', timeout: 60000 });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
