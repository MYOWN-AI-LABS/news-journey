import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exercise real voice/render stage control flow with only the expensive subprocess replaced. */
function fixture(program: string): void {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces/test-media-timeout-'));
  const slug = workspace.split(/[\\/]/).at(-1)!, token = 'e'.repeat(64);
  try {
    mkdirSync(join(workspace, 'config/editions'), { recursive: true });
    writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: slug }));
    writeFileSync(join(workspace, 'members.json'), JSON.stringify([{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]));
    writeFileSync(join(workspace, 'config/pipeline.json'), JSON.stringify({ voice: 'af_heart', ttsEngine: 'kokoro' }));
    writeFileSync(join(workspace, 'config/editions/daily-roundup.json'), readFileSync(join(root, 'config/editions/daily-roundup.json')));
    const child = `
      import assert from 'node:assert/strict'; import { mock } from 'node:test';
      import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'; import { join } from 'node:path';
      const source = ${JSON.stringify(new URL('./', import.meta.url).href)}, workspace = ${JSON.stringify(workspace)};
      const media = await import(new URL('../managed-process.ts', source));
      let calls = [], fail = true;
      mock.module(new URL('../managed-process.ts', source), { namedExports: { ...media, runManagedProcess: async (command,args,options) => {
        calls.push({command,args,options});
        if (options.operation === 'Video rendering') {
          const output = args.find(arg => /render-attempt-.*\\.mp4$/.test(arg)); assert.ok(output);
          writeFileSync(output, fail ? 'partial attempt' : 'completed render');
        }
        if (fail) throw new media.ManagedProcessTimeoutError(options.operation, options.timeoutMs);
        return {stdout:'',stderr:'',code:0};
      } } });
      const deny = () => { throw new Error('No source/model/network calls in media timeout regression'); }; globalThis.fetch = deny;
      const model = await import(new URL('../llm/model.ts', source));
      mock.module(new URL('../llm/model.ts', source), { namedExports: {...model, modelCanReadImages:async()=>false,modelJson:deny,modelVisionJson:deny} });
      const diagrams = await import(new URL('story-diagram.ts',source));
      mock.module(new URL('story-diagram.ts',source), {namedExports:{...diagrams,ensureEditionDiagrams:async()=>[]}});
      const id = '20260915-media-timeout', dir = join(workspace,'workdir/videos',id);mkdirSync(dir,{recursive:true});
      const save = (name,value) => writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value));
      const script = {hook:'Hello.',body:[{voiceover:'A reported story.',scene:'news_card',onScreen:{title:'Reported story'}}],cta:'Goodbye.',fullVoiceoverText:'Hello. A reported story. Goodbye.',publish:{title:'Reported story',description:'Source attribution',linkedinPost:'Source attribution',hashtags:[]}};
      save('script.json',script); save('topic.json',{id,kind:'news',headline:'Reported story',primaryUrl:'https://example.org/story'});
      save('meta.json',{id,status:'assets_ready',posts:{}});save('companion-newsletter.json','accepted newsletter');
      save('timestamps.json',{durationSec:5,engine:'kokoro',words:[{w:'Hello.',start:0,end:1},{w:'A',start:1,end:2},{w:'reported',start:2,end:3},{w:'story.',start:3,end:4},{w:'Goodbye.',start:4,end:5}]});
      save('audio.wav','previous narration');save('final.mp4','previous completed render');
      const text = readFileSync(join(dir,'script.json')), newsletter = readFileSync(join(dir,'companion-newsletter.json'));
      ${program}
      assert.ok(readFileSync(join(dir,'script.json')).equals(text)); assert.ok(readFileSync(join(dir,'companion-newsletter.json')).equals(newsletter));
      process.stdout.write('MEDIA_TIMEOUT_STAGE_PASSED');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const output = execFileSync(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--input-type=module', '-e', child], { cwd: root, timeout: 20_000, encoding: 'utf8', env: { ...env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token, HARNESS_IDENTITY_FILE: join(workspace,'identity.json') } });
    assert.match(output, /MEDIA_TIMEOUT_STAGE_PASSED/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

test('narration timeout preserves accepted text and selected voice, without marking narration complete', () => fixture(`
  const { voice } = await import(new URL('voice.ts',source));
  await assert.rejects(voice(id),media.ManagedProcessTimeoutError);
  assert.equal(calls.length,1);assert.equal(calls[0].options.timeoutMs,media.MEDIA_PROCESS_LIMITS.narration);
  assert.equal(calls[0].args[calls[0].args.indexOf('--engine')+1],'kokoro');assert.equal(calls[0].args[calls[0].args.indexOf('--voice')+1],'af_heart');
  assert.equal(JSON.parse(readFileSync(join(dir,'meta.json'),'utf8')).status,'assets_ready');
  assert.equal(readFileSync(join(dir,'audio.wav'),'utf8'),'previous narration');
`));

test('render timeout preserves the completed video and records no success; successful retry adopts only its own output', () => fixture(`
  const { render } = await import(new URL('render.ts',source));
  await assert.rejects(render(id),media.ManagedProcessTimeoutError);
  assert.equal(calls.length,1);assert.equal(calls[0].options.timeoutMs,media.MEDIA_PROCESS_LIMITS.render);
  assert.equal(JSON.parse(readFileSync(join(dir,'meta.json'),'utf8')).status,'assets_ready');
  assert.equal(readFileSync(join(dir,'final.mp4'),'utf8'),'previous completed render');
  assert.equal(readdirSync(dir).filter(name=>name.startsWith('render-attempt-')).length,1);
  fail=false;assert.equal(await render(id),join(dir,'final.mp4'));
  assert.equal(readFileSync(join(dir,'final.mp4'),'utf8'),'completed render');
  assert.equal(JSON.parse(readFileSync(join(dir,'meta.json'),'utf8')).status,'rendered');
  assert.equal(readdirSync(dir).filter(name=>name.startsWith('render-attempt-')).length,1,'Failed attempt evidence remains after successful retry');
`));


test('a completed media continuation refuses standalone rendering before any subprocess', () => fixture(`
  save('media-continuation.json',{explicit:'routing fixture; authorization covered by continuation tests'});
  save('meta.json',{id,status:'pending_review',posts:{}});
  mock.module(new URL('media-continuation.ts',source),{namedExports:{openMediaContinuation:()=>({assertUnchanged:()=>{}})}});
  const {render}=await import(new URL('render.ts',source));
  await assert.rejects(render(id),/already reached preview; new rendering is closed/);
  assert.equal(calls.length,0);assert.equal(readFileSync(join(dir,'final.mp4'),'utf8'),'previous completed render');
  assert.equal(JSON.parse(readFileSync(join(dir,'meta.json'),'utf8')).status,'pending_review');
`));
