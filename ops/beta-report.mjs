#!/usr/bin/env node
// Sanitized beta report a tester commits to their own branch (`beta/<name>`), so findings arrive with the
// exact commit, machine, writer, and job outcomes — and never a token, key, profile id, home path or brief.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { platform, arch, release, totalmem } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './redact.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sh = (cmd, cmdArgs, timeout = 60_000) => { try { return execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (error) { const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim(); return out ? `${out}\n(exit ${error.status ?? '?'})` : `(unavailable: ${String(error.message).split('\n')[0].slice(0, 120)})`; } }; // a failing doctor is exactly what the report must show
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

const name = (flag('--name') || sh('git', ['config', 'user.name']) || 'tester').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tester';
const date = new Date().toISOString().slice(0, 10);
const commit = sh('git', ['rev-parse', '--short', 'HEAD']);
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const version = readJson(join(root, 'package.json'), {}).version || '?';
const node = process.version;

// Local models actually downloaded (names only).
let ollama = '(not running)';
try {
  const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
  const tags = await response.json();
  ollama = (tags.models || []).map(m => m.name).join(', ') || '(no models downloaded)';
} catch { /* not running */ }

// Voicebox reachable? (never the profile list)
let voicebox = 'not running';
try { const r = await fetch('http://127.0.0.1:18000/', { signal: AbortSignal.timeout(3000) }); voicebox = r.ok ? 'running' : `http ${r.status}`; } catch { /* not running */ }

const doctor = redact(sh(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'doctor'], 120_000)).split('\n').filter(Boolean).slice(0, 40).join('\n');

const workspacesDir = join(root, 'workspaces');
const workspaces = existsSync(workspacesDir) ? readdirSync(workspacesDir).filter(id => !id.startsWith('journey-check') && !id.startsWith('native-check') && existsSync(join(workspacesDir, id, 'workspace.json'))) : [];
const sections = [];
for (const id of workspaces) {
  const w = join(workspacesDir, id);
  const model = readJson(join(w, 'config/model.json'), {});
  const avatar = readJson(join(w, 'config/avatar.json'), {});
  const personalization = readJson(join(w, 'config/personalization.json'), {});
  const quick = readJson(join(w, 'state/quick-preview.json'), null);
  const jobsDir = join(w, 'state/journey-jobs');
  const jobs = existsSync(jobsDir) ? readdirSync(jobsDir).filter(f => f.endsWith('.json')).map(f => readJson(join(jobsDir, f), {})).filter(j => j.startedAt).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).slice(-12) : [];
  const calls = existsSync(join(w, 'state/model-calls.jsonl')) ? readFileSync(join(w, 'state/model-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const byProvider = {};
  for (const c of calls) byProvider[c.provider || '?'] = (byProvider[c.provider || '?'] || 0) + 1;
  const recoveries = existsSync(join(w, 'state/model-recovery.jsonl')) ? readFileSync(join(w, 'state/model-recovery.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
  const videosDir = join(w, 'workdir/videos');
  const packages = existsSync(videosDir) ? readdirSync(videosDir).map(p => ({ id: p, ...readJson(join(videosDir, p, 'meta.json'), {}) })).filter(p => p.status).slice(-6) : [];
  const jobRows = jobs.map(j => `| ${String(j.startedAt).slice(0, 16)} | ${j.operation} | ${j.status} | ${j.finishedAt ? Math.round((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000) + ' s' : '—'} | ${redact(j.error || j.result?.message || '').replace(/\|/g, '/').slice(0, 160)} |`).join('\n');
  sections.push(`### Workspace \`${id}\`
- Writer: ${model.provider || '?'}${model.providers?.[model.provider]?.model ? ' / ' + model.providers[model.provider].model : ''}; local rescue: ${model.rescue?.enabled === true ? 'on' : 'off'}
- Narration: ${avatar.voiceProvider || '?'}${avatar.voiceProvider === 'voicebox' ? ' (own profile selected: ' + (avatar.voicebox?.profile ? 'yes' : 'no') + ')' : ''}; presenter mode: ${avatar.mode || '?'}
- Brand: theme ${personalization.theme || 'light'}, accent ${personalization.accent || 'edition'}, fonts ${personalization.fontPairing || 'sans'}, logo ${personalization.logoFile ? 'yes' : 'no'}, own newsletter shell ${existsSync(join(w, 'branding/newsletter.html')) ? 'yes' : 'no'}
- Quick preview: ${quick ? `${quick.status} — ${redact(quick.stage || '')}` : 'never run'}
- Model calls: ${calls.length} (${Object.entries(byProvider).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); rescues recorded: ${recoveries}
- Packages: ${packages.map(p => `${p.id.slice(0, 20)}… ${p.status}`).join('; ') || 'none'}

| started (UTC) | job | status | took | message |
|---|---|---|---|---|
${jobRows || '| — | — | — | — | no jobs yet |'}`);
}

const report = `# Beta report — ${name} — ${date}

- Harness: v${version}, commit \`${commit}\` on \`${branch}\`
- Machine: ${platform()}/${arch()} ${release()}, ${Math.round(totalmem() / 1024 ** 3)} GB RAM, Node ${node}
- Ollama models: ${ollama}
- Local Voicebox: ${voicebox}

## What I tested and what happened
<!-- Fill this in: the numbered items from docs/beta-testing.md you ran, what you expected, what you saw. Screenshots go in the same folder. -->

## Doctor
\`\`\`
${doctor}
\`\`\`

## Workspaces (sanitized: no briefs, tokens, keys, profile ids or home paths)
${sections.join('\n\n') || '_No workspaces yet — run `node start.mjs` first._'}
`;

const outDir = join(root, 'beta-reports');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${name}-${date}.md`);
writeFileSync(out, redact(report));
console.log(`Beta report written → beta-reports/${name}-${date}.md`);
console.log('Fill in "What I tested and what happened", then: git add beta-reports && git commit -m "beta report" && git push -u origin beta/' + name);
