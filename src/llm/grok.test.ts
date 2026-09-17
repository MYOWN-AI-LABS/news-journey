import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { GrokCliFailure, GROK_CLI_REVIEW_TRANSPORT_VERSION, grokText } from './grok.js';
import type { ModelRuntime } from './model.js';
import { modelJson, resolveModelRuntime, type ModelConfig } from './model.js';

const fixtureDirs: string[] = [];
after(() => { for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true }); });
function fakeGrok(scriptBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-grok-cli-'));
  fixtureDirs.push(dir);
  if (process.platform === 'win32') {
    const cmd = join(dir, 'grok.cmd');
    writeFileSync(cmd, `@echo off\r\n${scriptBody}\r\n`);
    return cmd;
  }
  const bin = join(dir, 'grok');
  writeFileSync(bin, scriptBody);
  chmodSync(bin, 0o755);
  return bin;
}
function terminal(text: string, extra: Record<string, unknown> = {}) {
  return { text, stopReason: 'end_turn', sessionId: 'session-fixture', requestId: 'request-fixture', ...extra };
}
function outputCommand(value: unknown): string {
  const raw = JSON.stringify(value);
  return fakeGrok(process.platform === 'win32' ? `echo ${raw}` : `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(raw)});\n`);
}
function runtime(command: string): ModelRuntime { return { provider: 'grok', label: 'Grok CLI', command, timeoutMs: 10_000 }; }
async function rejectedReceipt(run: () => Promise<unknown>, expected: RegExp): Promise<{ error: GrokCliFailure; receipt: any }> {
  let caught: unknown;
  try { await run(); } catch (error) { caught = error; }
  assert.ok(caught instanceof GrokCliFailure, 'failure must retain a private transport diagnostic');
  assert.match(caught.message, expected);
  assert.ok(caught.receiptPath);
  try {
    if (process.platform !== 'win32') assert.equal(statSync(caught.receiptPath).mode & 0o777, 0o600);
    return { error: caught, receipt: JSON.parse(readFileSync(caught.receiptPath, 'utf8')) };
  } finally { rmSync(caught.receiptPath, { force: true }); }
}

describe('Grok CLI writer', () => {
  it('resolveModelRuntime prefers command and does not require XAI_API_KEY', () => {
    const selected = resolveModelRuntime({ provider: 'grok', providers: { grok: { command: 'grok', model: 'fixture-model' } } }, {});
    assert.equal(selected.command, 'grok');
    assert.equal(selected.apiKey, undefined);
  });

  it('accepts the official minimal terminal envelope without optional usage counters', async () => {
    const result = await grokText('Write JSON only.', runtime(outputCommand(terminal('{"text":"ok","claimIds":[1]}'))));
    assert.equal(result.text, '{"text":"ok","claimIds":[1]}');
    assert.equal(result.usage, null);
  });

  it('returns recorded usage from a completed single-round result', async () => {
    const usage = { input_tokens: 100, output_tokens: 25 };
    const result = await grokText('Write.', runtime(outputCommand(terminal('Finished.', { usage, num_turns: 1, modelUsage: { fixture: { modelCalls: 1 } } }))));
    assert.equal(result.text, 'Finished.');
    assert.deepEqual(result.usage, usage);
    assert.equal((await grokText('Write.', runtime(outputCommand(terminal('Finished.', { modelUsage: {} }))))).text, 'Finished.');
  });

  it('modelJson parses the task JSON inside the Grok terminal envelope without an API key', async () => {
    const command = outputCommand(terminal('{"text":"Harbor lead","claimIds":[1,2,3]}'));
    const settings: ModelConfig = { provider: 'grok', timeoutSeconds: 10, providers: { grok: { command, model: 'fixture' } }, rescue: { enabled: false } };
    const parsed = await modelJson<{ text: string; claimIds: number[] }>('Return {"text":"...","claimIds":[1]}',
      value => (!value?.text || !Array.isArray(value.claimIds) ? 'bad shape' : null), settings, {});
    assert.equal(parsed.text, 'Harbor lead');
    assert.deepEqual(parsed.claimIds, [1, 2, 3]);
  });

  it('retains a canceled planning prelude without accepting it or starting another call', { skip: process.platform === 'win32' }, async () => {
    const command = fakeGrok(`#!/usr/bin/env node
const fs=require('fs');fs.appendFileSync(__filename+'.calls','1');
process.stdout.write(JSON.stringify({text:'I will compare the frames.',stopReason:'cancelled',num_turns:1}));
process.stderr.write('Max turns reached\\nError: max turns reached');process.exit(1);
`);
    const { receipt } = await rejectedReceipt(() => grokText('PRIVATE supplied frame instructions', runtime(command)), /Grok CLI exit 1: Max turns reached/);
    assert.equal(receipt.transportVersion, GROK_CLI_REVIEW_TRANSPORT_VERSION);
    assert.equal(receipt.exitCode, 1);
    assert.equal(receipt.stdout.text, JSON.stringify({ text: 'I will compare the frames.', stopReason: 'cancelled', num_turns: 1 }));
    assert.match(receipt.stderr.text, /max turns reached/);
    assert.match(receipt.prompt.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(receipt).includes('PRIVATE supplied frame instructions'), false);
    assert.equal(receipt.argv, undefined); assert.equal(receipt.env, undefined); assert.equal(receipt.config, undefined);
    assert.equal(readFileSync(command + '.calls', 'utf8'), '1');
  });

  for (const [name, value, expected] of [
    ['cancellation', terminal('prelude', { stopReason: 'cancelled' }), /did not complete/],
    ['tool-only turn', terminal('I will inspect it', { stopReason: 'tool_use' }), /did not complete/],
    ['truncation', terminal('partial', { stopReason: 'max_tokens' }), /did not complete/],
    ['empty answer', terminal('  '), /did not complete/],
    ['missing stop reason', { text: 'prelude' }, /did not complete/],
    ['two turns', terminal('done', { num_turns: 2 }), /turns outside/],
    ['two physical calls', terminal('done', { modelUsage: { one: { modelCalls: 1 }, two: { modelCalls: 1 } } }), /model calls outside/],
    ['null usage row', terminal('done', { modelUsage: { one: null } }), /malformed model usage/],
    ['negative count', terminal('done', { modelUsage: { one: { modelCalls: -1 } } }), /malformed model usage/],
  ] as const) {
    it(`rejects ${name} even with exit zero`, async () => {
      await rejectedReceipt(() => grokText('Inspect.', runtime(outputCommand(value))), expected);
    });
  }

  it('rejects raw task JSON without its terminal completion envelope', { skip: process.platform === 'win32' }, async () => {
    const command = fakeGrok('#!/usr/bin/env node\nprocess.stdout.write("not terminal JSON");\n');
    await rejectedReceipt(() => grokText('Inspect.', runtime(command)), /terminal JSON result/);
  });

  it('passes exact ACP frame bytes privately and pins a one-round profile with tool deny rules', { skip: process.platform === 'win32' }, async () => {
    const inherited = process.env.GROK_SUBAGENTS;
    const command = fakeGrok(`#!/usr/bin/env node
const fs=require('fs'),assert=require('assert/strict'),args=process.argv.slice(2),p=args[args.indexOf('--prompt-file')+1],flag=k=>args[args.indexOf(k)+1];
assert.ok(p.endsWith('.json'));assert.equal(fs.statSync(p).mode&0o777,0o600);
const blocks=JSON.parse(fs.readFileSync(p,'utf8'));assert.equal(blocks.length,2);assert.deepEqual(blocks[0],{type:'text',text:'Inspect only this frame.'});
assert.equal(blocks[1].type,'image');assert.equal(blocks[1].mimeType,'image/png');assert.equal(blocks[1].data,'iVBORw0KGgo=');
assert.equal(flag('--output-format'),'json');assert.equal(flag('--agent'),'general-purpose');assert.match(flag('--system-prompt-override'),/one model response/);
assert.equal(flag('--tools'),'read_file');const denied=flag('--disallowed-tools').split(',');
for(const name of ['read_file','todo_write','ask_user_question','search_tool','use_tool','Agent'])assert.ok(denied.includes(name));
assert.equal(flag('--max-turns'),'1');assert.equal(flag('--deny'),'MCPTool');assert.equal(flag('--permission-mode'),'dontAsk');
for(const name of ['--no-subagents','--no-ask-user','--no-memory','--no-auto-update','--disable-web-search'])assert.ok(args.includes(name));
assert.ok(!args.some(v=>v.includes('base64')||v.includes('iVBOR')||v.includes('Inspect only this frame')));
for(const name of ['GROK_SUBAGENTS','GROK_WORKFLOWS','GROK_CLAUDE_MCPS_ENABLED','GROK_CURSOR_MCPS_ENABLED','GROK_MANAGED_MCPS_ENABLED','GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED','GROK_CLAUDE_HOOKS_ENABLED','GROK_CURSOR_HOOKS_ENABLED'])assert.equal(process.env[name],'0');
assert.equal(process.env.XAI_API_KEY,undefined);assert.ok(process.env.HOME||process.env.USERPROFILE);
process.stdout.write(JSON.stringify({text:'Frame received',stopReason:'end_turn',num_turns:1}));
`);
    const path = join(dirname(command), 'frame.png'); writeFileSync(path, Buffer.from('iVBORw0KGgo=', 'base64'));
    assert.equal((await grokText('Inspect only this frame.', runtime(command), [path])).text, 'Frame received');
    assert.equal(process.env.GROK_SUBAGENTS, inherited);
    await assert.rejects(grokText('Inspect', runtime(command), Array(7).fill(path)), /at most six/);
    writeFileSync(path, 'not a PNG'); await assert.rejects(grokText('Inspect', runtime(command), [path]), /PNG, JPEG or WebP/);
  });
});
