import { execFile, spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CODE_ROOT } from './workspaces.js';
import { releaseLock } from './release-lock.js';

// Dedicated harness port: never adopt another project's Voicebox on the common port 8000.
const HEALTH_URL = 'http://127.0.0.1:18000/health';
const UNAVAILABLE = 'Local Voicebox is not ready. Open the voice studio in this journey and choose Prepare local Voicebox. Your saved voice selection is kept.';

let startingManaged: Promise<void> | undefined;
function startManaged(): Promise<void> {
  if (startingManaged) return startingManaged;
  startingManaged = (async () => {
    let unlock: () => void;
    try { unlock = releaseLock(CODE_ROOT, 'voicebox-start'); }
    catch { throw new Error('Local Voicebox setup is already running. Wait for it to finish, then reopen the voice studio in this journey.'); }
    try {
      await promisify(execFile)(process.execPath, [resolve(CODE_ROOT, 'ops/prepare-local-voice.mjs'), '--start-only'], { cwd: CODE_ROOT, timeout: 145000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      const detail = (error as Error & { stderr?: string }).stderr?.trim();
      throw new Error(detail || UNAVAILABLE);
    } finally { unlock(); }
  })().finally(() => { startingManaged = undefined; });
  return startingManaged;
}

async function up(fetcher: typeof fetch): Promise<boolean> {
  try {
    return (await fetcher(HEALTH_URL, { redirect: 'error', signal: AbortSignal.timeout(3000) })).ok;
  } catch { return false; }
}

function argv(value: string): [string, ...string[]] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('VOICEBOX_START_COMMAND must be a JSON array containing an absolute executable and its arguments.'); }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every(part => typeof part === 'string' && !part.includes('\0')) || !isAbsolute(parsed[0])) {
    throw new Error('VOICEBOX_START_COMMAND must be a JSON array containing an absolute executable and its arguments.');
  }
  return parsed as [string, ...string[]];
}

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((done, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); done(); });
  });
}

export async function ensureVoicebox(options: {
  fetcher?: typeof fetch;
  startCommand?: string;
  runCommand?: (executable: string, args: string[]) => Promise<void>;
  startManaged?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
} = {}): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  if (await up(fetcher)) return;
  const configured = options.startCommand ?? process.env.VOICEBOX_START_COMMAND;
  if (!configured?.trim()) {
    await (options.startManaged ?? startManaged)();
    if (await up(fetcher)) return;
    throw new Error(UNAVAILABLE);
  }
  try {
    const [executable, ...args] = argv(configured);
    await (options.runCommand ?? run)(executable, args);
  } catch (error) {
    throw new Error(`${UNAVAILABLE} ${(error as Error).message}`);
  }
  const sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.waitMs ?? 150000);
  const pollMs = options.pollMs ?? 3000;
  while (now() < deadline) {
    await sleep(Math.min(pollMs, deadline - now()));
    if (await up(fetcher)) return;
  }
  throw new Error(UNAVAILABLE);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureVoicebox().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
