import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AntigravityCliFailure, antigravityEffort, antigravityText } from './antigravity.js';
import { resolveModelRuntime, type ModelRuntime } from './model.js';

const fixtureDirs: string[] = [];
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });
/** A stand-in `agy` that records its arguments and prints the given terminal JSON (or misbehaves on request). */
function fakeAgy(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-agy-')); fixtureDirs.push(dir);
  if (process.platform === 'win32') { const cmd = join(dir, 'agy.cmd'); writeFileSync(cmd, `@echo off\r\n${script}\r\n`); return cmd; }
  const bin = join(dir, 'agy'); writeFileSync(bin, script); chmodSync(bin, 0o755); return bin;
}
const printing = (value: unknown, extra = '') => fakeAgy(process.platform === 'win32'
  ? `echo ${JSON.stringify(value)}`
  : `#!/usr/bin/env node\n${extra}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(value))});\n`);
const runtime = (command: string, extra: Partial<ModelRuntime> = {}): ModelRuntime => ({ provider: 'antigravity', label: 'Antigravity CLI fixture', command, model: 'gemini-3.6-flash-low', timeoutMs: 10_000, ...extra });

describe('Antigravity CLI writer', () => {
  it('resolves from providers.antigravity with the CLI default, no key and the 900 s CLI default', () => {
    const selected = resolveModelRuntime({ provider: 'antigravity', providers: { antigravity: { model: 'gemini-3.6-flash-high', reasoningEffort: 'low' } } }, {});
    assert.equal(selected.command, 'agy'); assert.equal(selected.model, 'gemini-3.6-flash-high'); assert.equal(selected.apiKey, undefined);
    assert.equal(selected.timeoutMs, 900_000); assert.equal(selected.reasoningEffort, 'low'); assert.match(selected.label, /Antigravity CLI/);
    assert.equal(resolveModelRuntime({ provider: 'antigravity', timeoutSeconds: 120, providers: { antigravity: { model: 'x' } } }, {}).timeoutMs, 120_000);
    // No configured model defaults to Gemini 3.8 Flash (a fresh beta workspace strips provider config), never an error.
    assert.equal(resolveModelRuntime({ provider: 'antigravity', providers: {} }, {}).model, 'gemini-3.8-flash-high');
    assert.throws(() => resolveModelRuntime({ provider: 'antigravity', providers: { antigravity: { model: 'x' } } }, { AI_CONTENT_MODEL_API_KEY: 'k' }), /not a Model URL or API key/);
  });

  it('maps reasoning effort onto the CLI\'s three levels', () => {
    assert.equal(antigravityEffort(undefined), undefined); assert.equal(antigravityEffort('none'), 'low'); assert.equal(antigravityEffort('low'), 'low');
    assert.equal(antigravityEffort('medium'), 'medium'); assert.equal(antigravityEffort('high'), 'high'); assert.equal(antigravityEffort('max'), 'high');
    assert.equal(antigravityEffort('low', 'gemini-3.6-flash-high'), undefined, 'a model id that carries its effort refuses a separate --effort');
    assert.equal(antigravityEffort('low', 'gemini-3.1-pro'), 'low');
  });

  it('passes the prompt as the -p argument, prints JSON, sandboxes, and returns the response with mapped usage', async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), 'harness-agy-args-')), 'args.json'); fixtureDirs.push(join(argsFile, '..'));
    const cli = printing({ conversation_id: 'c', status: 'SUCCESS', response: '{"ok":true}\n', duration_seconds: 1.2, num_turns: 1, usage: { input_tokens: 18625, output_tokens: 68, thinking_tokens: 65, cache_read_tokens: 0, total_tokens: 18693 } },
      `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), key: process.env.GEMINI_API_KEY ?? null }));`);
    const result = await antigravityText('Return JSON only.', runtime(cli, { model: 'gemini-3.6-flash', reasoningEffort: 'none' }));
    assert.equal(result.text, '{"ok":true}');
    assert.deepEqual(result.usage, { prompt_tokens: 18625, completion_tokens: 68, thinking_tokens: 65, total_tokens: 18693 });
    if (process.platform !== 'win32') {
      const seen = JSON.parse(readFileSync(argsFile, 'utf8'));
      assert.deepEqual(seen.args.slice(0, 2), ['-p', 'Return JSON only.']);
      for (const flag of ['--output-format', 'json', '--disable-slash-commands', '--sandbox', '--print-timeout', '10s', '--model', 'gemini-3.6-flash', '--effort', 'low']) assert.ok(seen.args.includes(flag), flag);
      assert.match(seen.cwd, /harness-antigravity-writer-/); assert.equal(seen.key, null, 'API keys never reach the CLI');
    }
  });

  it('rejects anything but one SUCCESS turn and keeps a private diagnostic', async () => {
    for (const [value, expected] of [
      [{ status: 'ERROR', response: '', error: 'quota' }, /did not complete one direct response \(status ERROR\)/],
      [{ status: 'SUCCESS', response: 'x', num_turns: 3 }, /turns outside the one reserved round/],
    ] as const) {
      let caught: unknown; try { await antigravityText('Write.', runtime(printing(value))); } catch (error) { caught = error; }
      assert.ok(caught instanceof AntigravityCliFailure); assert.match((caught as Error).message, expected); assert.ok(caught.receiptPath); rmSync(caught.receiptPath!, { force: true });
    }
    await assert.rejects(antigravityText('', runtime('agy')), /nonempty prompt/);
    await assert.rejects(antigravityText('Look.', runtime('agy'), ['/tmp/x.png']), /text only/);
  });

  it('stops a CLI that never answers at the deadline', async () => {
    const cli = fakeAgy(process.platform === 'win32' ? 'timeout /t 30 >nul' : '#!/usr/bin/env node\nsetTimeout(() => {}, 30000);\n');
    await assert.rejects(antigravityText('Write.', runtime(cli, { timeoutMs: 800 })), /timed out after 0\.8s/);
  });
});
