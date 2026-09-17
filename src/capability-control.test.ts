import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, authorize, authenticate, contained, safeId, validDay, workspaceRoot } from './workspaces.js';
import { createControlServer } from './control.js';
import { packageFingerprint } from './release-control.js';
import { createAttribution, attributionCounts } from './attribution.js';
import { dispatchWebhooks, webhookSignature } from './webhooks.js';
import { parsePublicMetrics } from './analytics/public-metrics.js';
import { explicitApprovalMatches } from './pipeline/explicit-approval.js';
const token = 'a'.repeat(64), viewer = 'c'.repeat(64);
function fixture() {
  const code = mkdtempSync(join(tmpdir(), 'content-control-check-'));
  for (const slug of ['alpha', 'beta']) {
    const root = join(code, 'workspaces', slug);
    for (const dir of ['config', 'state', 'workdir/videos/package-1', 'workdir/newsletters']) mkdirSync(join(root, dir), { recursive:true });
    atomicJson(join(root,'workspace.json'),{id:slug});
    atomicJson(join(root,'config/pipeline.json'),{siteUrl:'https://example.com'});
    atomicJson(join(root,'config/platforms.json'),{x:{enabled:true},youtube:{enabled:true}});
    atomicJson(join(root,'desks.json'),{science:{editions:['quantum'],channels:['x'],twoPersonRule:true}});
    atomicJson(join(root,'members.json'),[
      {id:'admin',role:'admin',tokenHash:createHash('sha256').update(slug==='alpha'?token:'b'.repeat(64)).digest('hex')},
      {id:'viewer',role:'viewer',tokenHash:createHash('sha256').update(viewer).digest('hex')},
      {id:'writer',role:'editor',tokenHash:'0'.repeat(64),desks:['science']},
      {id:'reviewer',role:'reviewer',tokenHash:'1'.repeat(64),desks:['science']}
    ]);
    atomicJson(join(root,'workdir/videos/package-1/meta.json'),{id:'package-1',edition:'quantum',createdBy:'writer',status:'pending_review',posts:{}});
    for (const name of ['topic.json','script.json','final.mp4']) writeFileSync(join(root,'workdir/videos/package-1',name), name.endsWith('json')?'{}':'fixture');
  }
  return {code,root:join(code,'workspaces/alpha'),close:()=>rmSync(code,{recursive:true,force:true})};
}
test('workspace isolation, date boundary, roles and independent reviewer',()=>{
 const f=fixture();try {
  assert.throws(()=>safeId('../beta')); assert.throws(()=>validDay('2026-02-30')); assert.equal(validDay('2026-09-07'),'2026-09-07');
  assert.throws(()=>workspaceRoot(f.code,'../alpha')); assert.throws(()=>authenticate(join(f.code,'workspaces/beta'),token));
  symlinkSync(join(f.code,'workspaces/beta'),join(f.root,'escape'));assert.throws(()=>contained(f.root,'escape/state'));
  for (const role of ['owner','admin','editor','reviewer','viewer'] as const) for (const action of ['read','produce','approve','publish','manage','delete'] as const) {
   const permitted = {read:['owner','admin','editor','reviewer','viewer'],produce:['owner','admin','editor'],approve:['owner','admin','reviewer'],publish:['owner','admin'],manage:['owner','admin'],delete:['owner']}[action].includes(role);
   const run=()=>authorize(action,{root:f.root,actor:{id:role==='editor'?'writer':role,role},edition:'quantum',author:'writer'});
   if(permitted) assert.doesNotThrow(run);else assert.throws(run);
  }
  assert.throws(()=>authorize('produce',{root:f.root,actor:{id:'writer',role:'editor'},edition:'orbital'}));
  assert.throws(()=>authorize('approve',{root:f.root,actor:{id:'reviewer',role:'reviewer'},edition:'quantum',author:'reviewer'}));
  assert.throws(()=>authorize('publish',{root:f.root,actor:{id:'admin',role:'admin'},edition:'quantum',platform:'youtube'}));
 }finally{f.close();}
});
test('authenticated API, exact approval, idempotency and constrained attribution',async()=>{
 const f=fixture();let calls=0;const server=createControlServer({codeRoot:f.code,mutate:async()=>({ok:true,call:++calls})});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const request=(path:string,options:RequestInit={})=>fetch(base+path+'?workspace=alpha',{...options,headers:{authorization:`Bearer ${token}`,...options.headers}});
 try{
  assert.equal((await fetch(base+'/v1/state?workspace=alpha')).status,401);
  assert.equal((await request('/v1/state',{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/v1/state',{headers:{authorization:'Bearer '+'b'.repeat(64)}})).status,401);
  const state=await (await request('/v1/state')).text();assert.ok(!state.includes('tokenHash'));
  const action='/v1/packages/package-1/approve';const hash=packageFingerprint(f.root,'package-1');
  const opts={method:'POST',headers:{'content-type':'application/json','idempotency-key':'approve-0001'},body:JSON.stringify({expectedHash:hash})};
  assert.equal((await request(action,{...opts,headers:{...opts.headers,authorization:`Bearer ${viewer}`}})).status,403);
  assert.equal((await request(action,{...opts,body:JSON.stringify({expectedHash:'stale'})})).status,409);
  assert.equal((await request(action,opts)).status,200);assert.equal((await request(action,opts)).status,200);assert.equal(calls,1);
  writeFileSync(join(f.root,'workdir/videos/package-1/script.json'),'changed');
  assert.equal((await request(action,{...opts,headers:{...opts.headers,'idempotency-key':'approve-0002'}})).status,409);
  const link=createAttribution(f.root,'package-1','x','https://example.com/issues/fixture');
  assert.throws(()=>createAttribution(f.root,'package-1','youtube','https://evil.example/'));
  const redirect=await request('/r/'+link.id,{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),link.destination);assert.equal(attributionCounts(f.root)[link.id],1);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});
test('signed webhooks persist failed attempts and never resend acknowledged events',async()=>{
 const f=fixture();try{
  const secret='s'.repeat(40);writeFileSync(join(f.root,'.env'),`HOOK_SECRET=${secret}\n`);
  atomicJson(join(f.root,'config/webhooks.json'),[{id:'test',url:'http://127.0.0.1:1/events',secretEnv:'HOOK_SECRET'}]);
  writeFileSync(join(f.root,'workdir/videos/package-1/delivery-events.jsonl'),JSON.stringify({type:'release.approved',videoId:'package-1',timestamp:'2026-09-07T12:00:00Z'})+'\n');
  let sends=0;const send=(async(_url:unknown,init:RequestInit)=>{sends++;const h=init.headers as Record<string,string>;assert.equal(h['x-content-signature'],webhookSignature(secret,h['x-content-timestamp'],String(init.body)));return new Response('',{status:sends===1?503:200});}) as typeof fetch;
  assert.equal((await dispatchWebhooks(f.root,send)).pending,1);
  const path=join(f.root,'state/webhook-deliveries.json');const saved=JSON.parse(readFileSync(path,'utf8'));for(const value of Object.values(saved) as any[])value.nextAt=0;atomicJson(path,saved);
  assert.equal((await dispatchWebhooks(f.root,send)).delivered,1);await dispatchWebhooks(f.root,send);assert.equal(sends,2);
 }finally{f.close();}
});
test('public metrics and approval hashes reject unrelated/new artifacts',()=>{
 const page='<script type="application/json">'+JSON.stringify({id:'123',stats:{playCount:11,diggCount:0}})+'</script>';
 assert.deepEqual(parsePublicMetrics(page,'tiktok','123'),{views:11,likes:0});assert.equal(parsePublicMetrics(page,'tiktok','999'),null);assert.equal(parsePublicMetrics('<p>123 views: 500</p>','tiktok','123'),null);
 const hashes={topicSha256:'t',scriptSha256:'s',videoSha256:'v'};assert.equal(explicitApprovalMatches({approvedAt:'now',...hashes},{...hashes,newsletterHtmlSha256:'new'}),false);
});

test('actual CLI and API worker preserve workspace and approval boundaries', async()=>{
 const { spawnSync } = await import('node:child_process');
 const { CODE_ROOT } = await import('./workspaces.js');
 const { workerAction } = await import('./control.js');
 const scratch=mkdtempSync(join(tmpdir(),'control-cli-'));const slug='check-'+process.pid;const root=join(CODE_ROOT,'workspaces',slug);
 const env: NodeJS.ProcessEnv={...process.env,HARNESS_IDENTITY_FILE:join(scratch,'identity.json')};delete env.HARNESS_TOKEN;delete env.HARNESS_WORKSPACE;
 const cli=(args:string[],override:Record<string,string>={})=>spawnSync(process.execPath,['--import','tsx',join(CODE_ROOT,'src/cli.ts'),...args],{cwd:CODE_ROOT,env:{...env,...override},encoding:'utf8',timeout:30000});
 try{
  let result=cli(['workspace','create',slug]);assert.equal(result.status,0,result.stderr);
  result=cli(['--workspace',slug,'api:token','--output',join(scratch,'token')]);assert.equal(result.status,0,result.stderr);
  const credential=readFileSync(join(scratch,'token'),'utf8').trim();const dir=join(root,'workdir/videos/package-1');mkdirSync(dir,{recursive:true});
  const { releaseLock } = await import('./release-lock.js'); const unlock = releaseLock(root);
  try { result=cli(['--workspace',slug,'workspace','create',slug+'-neighbor'],{HARNESS_TOKEN:credential}); assert.equal(result.status,0,result.stderr); }
  finally { unlock(); }
  atomicJson(join(dir,'meta.json'),{id:'package-1',edition:'daily-roundup',status:'pending_review',posts:{},createdBy:'fixture'});for(const file of ['topic.json','script.json','final.mp4'])writeFileSync(join(dir,file),file.endsWith('json')?'{}':'video');
  const receipt=await workerAction(root,credential,{action:'approve',id:'package-1',expectedHash:packageFingerprint(root,'package-1')});assert.equal(receipt.approved,true);
  let meta=JSON.parse(readFileSync(join(dir,'meta.json'),'utf8'));assert.equal(meta.explicitApproval.videoSha256,createHash('sha256').update('video').digest('hex'));assert.ok(meta.approvedBy.id.startsWith('control-'));
  result=cli(['--workspace',slug,'reject','package-1']);assert.equal(result.status,0,result.stderr);meta=JSON.parse(readFileSync(join(dir,'meta.json'),'utf8'));assert.equal(meta.status,'rejected');assert.equal(meta.explicitApproval,undefined);assert.ok(meta.reviewHold);
  mkdirSync(join(root,'state/tokens'),{recursive:true});atomicJson(join(root,'state/tokens/x.json'),{accessToken:'fixture',expiresAt:'2099-01-01T00:00:00Z'});atomicJson(join(dir,'script.json'),{publish:{title:'Fixture',hashtags:[]}});
  const probe=`import assert from 'node:assert/strict';import {postX} from './src/post/x.ts';import {validateAcceptedReceipt} from './src/post/provider-support.ts';import {certainlyNotSubmitted} from './src/post/attempt.ts';let mode;globalThis.fetch=async(url)=>{url=String(url);if(url.endsWith('/initialize')&&mode==='before')throw new Error('This operation was aborted');if(url.endsWith('/tweets')){if(mode==='after')throw new Error('This operation was aborted');if(mode==='json')return new Response('bad JSON');if(mode==='shape')return Response.json({data:{}});return new Response('credits depleted',{status:402});}return Response.json({data:{id:'fixture-media'}});};for(mode of ['before','after','json','shape','refused']){try{validateAcceptedReceipt('x',await postX({id:'package-1'}));assert.fail('expected refusal');}catch(e){assert.equal(certainlyNotSubmitted(e),mode==='before'||mode==='refused',mode+': '+e.message);}}`;
  const probed=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',probe,'--','--workspace',slug],{cwd:CODE_ROOT,env:{...env,HARNESS_TOKEN:credential},encoding:'utf8',timeout:30000});assert.equal(probed.status,0,probed.stderr);
  const bad=cli(['--workspace',slug,'newsletter','--date','../../escape','--rerender']);assert.notEqual(bad.status,0);assert.match(bad.stderr,/Invalid date/);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(root+'-neighbor',{recursive:true,force:true});rmSync(scratch,{recursive:true,force:true});}
});


test('credential repair resumes blocked API delivery and X verification rejects reflected shells', async()=>{
 const { credentialFingerprint, retryDecision, validateAcceptedReceipt } = await import('./post/provider-support.js');
 const { createProbes } = await import('./post/probes.mjs');
 const f=fixture();try{
  for (const receipt of [{platform:'x',id:''},{platform:'x'},{platform:'youtube',id:'123'}]) assert.throws(()=>validateAcceptedReceipt('x',receipt as any),/no valid matching receipt/);
  const meta={id:'package-1'} as import('./types.js').VideoMeta;
  const event={platform:'youtube',outcome:{state:'failed',retryable:false,credentialFingerprint:credentialFingerprint('youtube','google',f.root)}};
  writeFileSync(join(f.root,'workdir/videos/package-1/delivery-events.jsonl'),JSON.stringify(event)+'\n');
  assert.equal(retryDecision(meta,'youtube',{auth:'oauth',authProvider:'google'},false,f.root).retry,false);
  assert.equal(retryDecision(meta,'youtube',{auth:'oauth',authProvider:'google'},true,f.root).retry,true);
  assert.equal(retryDecision(meta,'youtube',{auth:'oauth-then-browser',authProvider:'google'},false,f.root).retry,true);
  writeFileSync(join(f.root,'.env'),'FIXTURE_CREDENTIAL=repaired\n');assert.equal(retryDecision(meta,'youtube',{auth:'oauth',authProvider:'google'},false,f.root).retry,true);
  const receipt={id:'123',url:'https://x.com/example/status/123'};
  const probe=(body:string)=>createProbes(f.root,{get:async()=>({status:200,body})}).x(receipt);
  assert.equal((await probe('<html>123</html>')).state,'unverifiable');
  assert.equal((await probe(JSON.stringify({author_url:'https://x.com/example',html:'<a href="https://x.com/example/status/123">post</a>'}))).state,'live');
  assert.equal((await probe(JSON.stringify({author_url:'https://x.com/example',html:'<a href="https://x.com/example/status/1234">post</a>'}))).state,'unverifiable');
 }finally{f.close();}
});


test('killed delivery leaves a persistent hold and cannot produce a blind duplicate', async()=>{
 const { spawn } = await import('node:child_process');const { pendingAttempt, beginAttempt, finishAttempt, certainlyNotSubmitted, NotSubmittedError } = await import('./post/attempt.js');
 const f=fixture();const dir=join(f.root,'workdir/videos/package-1');
 const code=`import { beginAttempt } from ${JSON.stringify(new URL('./post/attempt.ts',import.meta.url).href)};beginAttempt(${JSON.stringify(dir)},'x');process.stdout.write('ready');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 try{await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>reject(new Error('child exited '+code)));});child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('close',()=>resolve()));assert.ok(pendingAttempt(dir,'x'));assert.throws(()=>beginAttempt(dir,'x'),/Unresolved delivery/);for(const message of ['ECONNRESET after request','This operation was aborted','Unexpected end of JSON input','Post not found on profile after posting'])assert.equal(certainlyNotSubmitted(new Error(message)),false);assert.equal(certainlyNotSubmitted(new NotSubmittedError(new Error('No token before upload'))),true);finishAttempt(dir,'x');assert.equal(pendingAttempt(dir,'x'),false);}finally{child.kill('SIGKILL');f.close();}
});
