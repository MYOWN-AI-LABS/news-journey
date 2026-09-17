// Private local Voicebox runtime. The browser stays in the harness throughout setup.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))), dir = join(root, '.tools/voicebox');
const startOnly = process.argv.includes('--start-only');
const revision = '51f49dea198384b4eb6087b72c17057c6eb1c1cd', sourceHash = 'fe1b047562f98f22dd97be5a7291196aff3e061b0f6aff8eb7974507fcf90148';
const source = join(dir, 'voicebox-' + revision), python = join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const env = {};
for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
env.PATH = join(root, '.tools/bin') + delimiter + (env.PATH || '');
const statusFile = join(root, 'state/local-voice-setup.json');
// The first-time stages in order; the studio shows "step n of N" and the elapsed time from startedAt.
const STAGES = ['Preparing local speech tools', 'Downloading the pinned Voicebox runtime', 'Unpacking local Voicebox', 'Creating the private Voicebox environment', 'Installing Voicebox speech dependencies', 'Preparing Apple Silicon speech', 'Preparing the local cloning engine', 'Starting the local voice studio', 'Checking your voices'];
// Stages 6 and 7 exist only on Apple silicon; elsewhere the studio marks them "not needed on this computer" instead of jumping.
const skipped = process.platform === 'darwin' && process.arch === 'arm64' ? [] : [6, 7];
const startedAt = new Date().toISOString();
function progress(stage, status = 'running') { mkdirSync(dirname(statusFile), { recursive: true }); writeFileSync(statusFile + '.tmp', JSON.stringify({ stage, status, step: STAGES.includes(stage) ? STAGES.indexOf(stage) + 1 : null, steps: STAGES.length, stages: STAGES, skipped, startedAt, updatedAt: new Date().toISOString() }), { mode: 0o600 }); renameSync(statusFile + '.tmp', statusFile); console.log(stage); }
function run(command, args, stage) { progress(stage); const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 }); if (result.error || result.status !== 0) throw new Error(stage + ': ' + (result.error?.message || result.stderr?.slice(-1500) || result.status)); }
/** "Ready" means the studio answered with its voice list, not only that the port is open. */
async function verified() {
  progress('Checking your voices');
  for (let attempt = 1; ; attempt++) { // one retry: a studio that has just started can miss its first request
    try {
      const r = await fetch('http://127.0.0.1:18000/profiles', { redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (r.ok && Array.isArray(await r.json())) break;
    } catch { /* retried below */ }
    if (attempt === 2) throw new Error('Local Voicebox started but did not return its voice list. Close and reopen the voice studio to check again.');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  progress('Local Voicebox is connected.', 'ready'); process.exit(0);
}
async function available() {
  try {
    const r = await fetch('http://127.0.0.1:18000/', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!r.ok || !(await r.json()).message?.toLowerCase().includes('voicebox')) throw new Error('Port 18000 is occupied by another service. It has been left running.');
    return true;
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('The local voice service is busy or could not be verified. It has not been restarted. ' + error.message);
  }
}
try {
  if (await available()) await verified();
  const stamp = join(dir, 'installed.json'), installKey = `${revision}:${process.platform}:${process.arch}`;
  const installed = existsSync(stamp) && readFileSync(stamp, 'utf8') === installKey && existsSync(python) && existsSync(join(source, 'backend/main.py'));
  if (!installed && startOnly) throw new Error('Local Voicebox needs setup on this computer. Open the voice studio in this journey and choose Prepare local Voicebox. Your saved voice selection is kept.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!installed) {
    run(process.execPath, [join(root, 'start.mjs'), '--prepare-only'], 'Preparing local speech tools');
    progress('Downloading the pinned Voicebox runtime');
    const archive = join(dir, 'source.zip');
    if (!existsSync(archive) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== sourceHash) {
      const response = await fetch(`https://codeload.github.com/jamiepine/voicebox/zip/${revision}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error('Voicebox download HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== sourceHash) throw new Error('Voicebox download did not match its pinned checksum.');
      writeFileSync(archive, bytes, { mode: 0o600 });
    }
    const toolsPython = join(root, 'tts/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    run(toolsPython, ['-c', 'import sys,zipfile,pathlib; z=zipfile.ZipFile(sys.argv[1]); root=pathlib.Path(sys.argv[2]).resolve(); assert all((root/n).resolve().is_relative_to(root) for n in z.namelist()); z.extractall(root)', archive, dir], 'Unpacking local Voicebox');
    if (!existsSync(python)) run('uv', ['venv', join(dir, 'venv'), '--python', '3.12'], 'Creating the private Voicebox environment');
    run('uv', ['pip', 'install', '--python', python, '-r', join(source, 'backend/requirements.txt')], 'Installing Voicebox speech dependencies');
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      run('uv', ['pip', 'install', '--python', python, '-r', join(source, 'backend/requirements-mlx.txt')], 'Preparing Apple Silicon speech');
      run('uv', ['pip', 'install', '--python', python, '--no-deps', 'mlx-lm==0.31.1', 'mlx-audio==0.4.1'], 'Preparing the local cloning engine');
    }
    writeFileSync(stamp, installKey);
  }
  if (await available()) await verified();
  progress('Starting the local voice studio');
  const log = openSync(join(dir, 'server.log'), 'a', 0o600);
  const child = spawn(python, ['-m', 'backend.main', '--host', '127.0.0.1', '--port', '18000', '--data-dir', join(dir, 'data')], { cwd: source, env, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  closeSync(log);
  let launchError; child.on('error', error => { launchError = error; }); child.unref();
  for (let i = 0; i < 90; i++) {
    if (launchError) throw launchError;
    if (await available()) await verified();
    if (child.exitCode !== null) throw new Error('Local Voicebox stopped during startup. Check .tools/voicebox/server.log.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Voicebox is still starting. Wait a moment and use Find my local voices; no second service was started.');
} catch (error) { progress(error.message, 'failed'); console.error(error.message); process.exitCode = 1; }
