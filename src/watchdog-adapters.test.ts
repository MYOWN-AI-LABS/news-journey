import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CODE_ROOT, atomicJson } from './workspaces.js';

// Keep even an accidentally accepted fixture response out of operator usage receipts.
mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
const workspace = mkdtempSync(join(CODE_ROOT, 'workspaces/watchdog-adapters-'));
atomicJson(join(workspace, 'workspace.json'), { id: basename(workspace), name: 'Watchdog adapter fixtures' });
mkdirSync(join(workspace, 'state'), { recursive: true });
const token = 'a'.repeat(64);
atomicJson(join(workspace, 'members.json'), [{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]);
const priorWorkspace = process.env.HARNESS_WORKSPACE, priorToken = process.env.HARNESS_TOKEN;
process.env.HARNESS_TOKEN = token;
process.env.HARNESS_WORKSPACE = basename(workspace);
const { codexText } = await import('./llm/codex.js');
const { grokText } = await import('./llm/grok.js');
const { opencodeText } = await import('./llm/opencode.js');
const { invokeModelText } = await import('./llm/model.js');
const { terminateManagedChildren } = await import('./managed-process.js');
after(() => {
  rmSync(workspace, { recursive: true, force: true });
  if (priorWorkspace === undefined) delete process.env.HARNESS_WORKSPACE;
  else process.env.HARNESS_WORKSPACE = priorWorkspace;
  if (priorToken === undefined) delete process.env.HARNESS_TOKEN;
  else process.env.HARNESS_TOKEN = priorToken;
});

for (const provider of ['codex', 'grok', 'opencode', 'claude'] as const) {
  test(`${provider} rejects valid final output and exit zero after watchdog termination`, { skip: process.platform === 'win32' ? 'POSIX graceful SIGTERM fixture; Windows taskkill does not deliver SIGTERM' : false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'watchdog-adapter-')), command = join(dir, provider + '.cjs');
    const ready = join(dir, 'ready'), emitted = join(dir, 'emitted');
    writeFileSync(command, `#!/usr/bin/env node
const fs=require('node:fs');
const provider=${JSON.stringify(provider)};
process.on('SIGTERM',()=>{
 let output='';
 if(provider==='codex'){
  const at=process.argv.indexOf('--output-last-message');
  fs.writeFileSync(process.argv[at+1],'{"ok":true}');
  output=JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\\n';
 }else if(provider==='opencode'){
  const emit=(type,part)=>JSON.stringify({type,sessionID:'fixture-session',part:{sessionID:'fixture-session',messageID:'fixture-message',...part}})+'\\n';
  output=emit('step_start',{type:'step-start'})+emit('text',{type:'text',id:'text-1',text:'{"ok":true}',time:{start:1,end:2}})+emit('step_finish',{type:'step-finish',reason:'stop',tokens:{input:1,output:1,total:2},cost:0});
 }else if(provider==='claude')output=JSON.stringify({type:'result',result:'{"ok":true}',is_error:false,usage:{input_tokens:1,output_tokens:1}})+'\\n';
 else output='{"ok":true}\\n';
 fs.writeFileSync(${JSON.stringify(emitted)},'valid output; intentional exit 0');
 process.stdout.write(output,()=>process.exit(0));
});
process.stdin.resume();
fs.writeFileSync(${JSON.stringify(ready)},'ready');
setInterval(()=>{},1000);
`);
    chmodSync(command, 0o700);
    const runtime = { provider, label: 'Fixture only', command, model: 'fixture', timeoutMs: 5000 };
    const result = provider === 'codex' ? codexText('fixture only', runtime)
      : provider === 'grok' ? grokText('fixture only', runtime)
      : provider === 'opencode' ? opencodeText('fixture only', { command, model: 'ollama/fixture:4b', timeoutMs: 5000 })
      : invokeModelText('fixture only', { provider: 'claude', timeoutSeconds: 5, rescue: { enabled: false }, providers: { claude: { command, model: 'fixture' } } }, {});
    const outcome = result.then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error }));
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(existsSync(ready), 'fake CLI installed its SIGTERM handler');
      await terminateManagedChildren(new Error('watchdog test stop'));
      const settled = await outcome;
      assert.equal(readFileSync(emitted, 'utf8'), 'valid output; intentional exit 0');
      assert.equal(settled.accepted, false, 'a terminated response cannot become accepted content');
      if (!settled.accepted) assert.match(String(settled.error?.message), /watchdog test stop/);
    } finally {
      await terminateManagedChildren(new Error('fixture cleanup'));
      await outcome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
