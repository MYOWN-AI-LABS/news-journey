import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CODE_ROOT, atomicJson } from './workspaces.js';
import { engagementAction, engagementHash, engagementState } from './engagement.js';

test('engagement deduplicates, scopes review and holds ambiguous sends without touching the network', async () => {
  mkdirSync(join(CODE_ROOT,'workspaces'),{recursive:true});
  const root=mkdtempSync(join(CODE_ROOT,'workspaces/engagement-check-'));
  const oldWorkspace=process.env.HARNESS_WORKSPACE;
  const oldToken=process.env.HARNESS_TOKEN;
  const oldFetch=globalThis.fetch;
  const owner='a'.repeat(64),reviewer='b'.repeat(64),viewer='c'.repeat(64);
  process.env.HARNESS_WORKSPACE=basename(root);process.env.HARNESS_TOKEN=owner;
  cpSync(join(CODE_ROOT,'config'),join(root,'config'),{recursive:true});
  atomicJson(join(root,'workspace.json'),{id:basename(root)});
  atomicJson(join(root,'members.json'),[[owner,'owner'],[reviewer,'reviewer'],[viewer,'viewer']].map(([token,role])=>({id:role,role,desks:['special'],tokenHash:createHash('sha256').update(token).digest('hex')})));
  atomicJson(join(root,'desks.json'),{daily:{editions:['daily-roundup'],channels:['youtube'],twoPersonRule:true},special:{editions:['example-topic'],channels:['linkedin','x'],twoPersonRule:true}});
  const videoId='20260907-example';
  const meta={id:videoId,edition:'example-topic',headline:'Example briefing',posts:{linkedin:{id:'post-1',url:'https://www.linkedin.com/feed/update/post-1/'},x:{id:'123',url:'https://x.com/i/status/123'}}};
  atomicJson(join(root,'workdir/videos',videoId,'meta.json'),meta);
  atomicJson(join(root,'state/tokens/x.json'),{accessToken:'fixture-token'});
  let sends=0, ambiguous=false,wrongParent=false,account='42';
  globalThis.fetch=(async (input: any,options: any={})=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.x.com');
    if(options.method==='POST'){sends++;assert.deepEqual(JSON.parse(options.body),{text:'Thanks for the question.',reply:{in_reply_to_tweet_id:'456'}});if(ambiguous)throw new Error('fixture timeout after provider accepted');return Response.json({data:{id:'789'}});}
    if(url.pathname.endsWith('/users/me'))return Response.json({data:{id:account}});
    if(url.pathname.endsWith('/tweets/123'))return Response.json({data:{author_id:account}});
    const comment={id:'456',author_id:'55',text:'How does this work?',conversation_id:'123',referenced_tweets:[{type:'replied_to',id:wrongParent?'999':'123'}]};
    if(url.pathname.endsWith('/tweets/search/recent'))return Response.json({data:[comment],meta:{}});
    if(url.pathname.endsWith('/tweets/456'))return Response.json({data:comment});
    throw new Error('Unexpected fixture request: '+url.pathname);
  }) as typeof fetch;
  const call=(op:string,data:Record<string,unknown>={},token=owner)=>{process.env.HARNESS_TOKEN=token;return engagementAction('engagement-'+op,{videoId,platform:'linkedin',...data});};
  const item=(id:string)=>engagementState(root).items.find(i=>i.id===id)!;
  try {
    const {applyExecutiveAction}=await import('./executive-actions.js');
    const capture={videoId,platform:'linkedin',url:meta.posts.linkedin.url+'?comment=one',author:'Viewer',text:'How does this work?'};
    // The outer API/action checks must use the selected package's desk, not daily-roundup.
    const first=await applyExecutiveAction('engagement-capture',capture);const itemId=String(first.itemId);
    assert.equal((await call('capture',capture)).itemId,itemId);assert.equal(engagementState(root).total,1);
    await assert.rejects(call('draft',{itemId,reply:'Reply'},viewer),/Forbidden/);
    await call('draft',{itemId,reply:'Please share the step you mean.'});
    await assert.rejects(call('approve',{itemId,expectedHash:item(itemId).hash}),/Independent reviewer/);
    await call('approve',{itemId,expectedHash:item(itemId).hash},reviewer);
    const oldHash=item(itemId).hash;
    await call('draft',{itemId,reply:'Which step needs clarification?'});
    await assert.rejects(call('approve',{itemId,expectedHash:oldHash},reviewer),/changed/);
    await call('approve',{itemId,expectedHash:item(itemId).hash},reviewer);
    await assert.rejects(call('confirm',{itemId,expectedHash:oldHash,url:meta.posts.linkedin.url+'?reply=one'}),/exact manual reply/);
    await call('begin-manual',{itemId,expectedHash:item(itemId).hash});
    await assert.rejects(call('begin-manual',{itemId,expectedHash:item(itemId).hash}),/approved manual reply/);
    await call('confirm',{itemId,expectedHash:item(itemId).hash,url:meta.posts.linkedin.url+'?reply=one'});
    assert.equal(item(itemId).receipt?.state,'unconfirmed');
    const reaction=await call('capture',{...capture,url:meta.posts.linkedin.url,authorUrl:'https://www.linkedin.com/in/viewer/',kind:'reaction',text:'Liked'});
    await assert.rejects(call('draft',{itemId:reaction.itemId,reply:'Hi'}),/no reply thread/);
    await call('draft',{itemId:reaction.itemId,reply:'Thank you. Which step would help your team?',acknowledge:true});
    assert.equal(item(String(reaction.itemId)).deliveryTarget,'post');
    await call('approve',{itemId:reaction.itemId,expectedHash:item(String(reaction.itemId)).hash},reviewer);
    await call('begin-manual',{itemId:reaction.itemId,expectedHash:item(String(reaction.itemId)).hash});
    await assert.rejects(call('draft',{itemId:reaction.itemId,reply:'Duplicate',acknowledge:true}),/earlier reply/);
    await call('confirm',{itemId:reaction.itemId,expectedHash:item(String(reaction.itemId)).hash,url:meta.posts.linkedin.url+'?comment=ack'});
    await call('collect',{platform:'x'});await call('collect',{platform:'x'});
    const x=engagementState(root).items.find(i=>i.platform==='x')!;assert.equal(engagementState(root).total,3);
    await call('draft',{platform:'x',itemId:x.id,reply:'Thanks for the question.'});
    await call('approve',{platform:'x',itemId:x.id,expectedHash:item(x.id).hash},reviewer);
    const target={platform:'x',itemId:x.id,expectedHash:item(x.id).hash};
    account='66';await assert.rejects(call('send',target),/account changed/);account='42';
    wrongParent=true;await assert.rejects(call('send',target),/comment changed/);wrongParent=false;
    assert.equal(sends,0);
    ambiguous=true;await assert.rejects(call('send',target),/uncertain/);
    assert.equal(item(x.id).status,'sending');assert.equal(sends,1);
    await assert.rejects(call('send',target),/earlier reply may have been sent/);
    await call('collect',{platform:'x'});assert.equal(item(x.id).status,'sending');assert.equal(sends,1);
    assert.deepEqual(JSON.parse(readFileSync(join(root,'workdir/videos',videoId,'meta.json'),'utf8')).posts,meta.posts);
    assert.equal(existsSync(join(root,'state/model-calls.jsonl')),false);
    assert.equal(engagementHash(item(x.id)),item(x.id).hash);
  } finally {
    globalThis.fetch=oldFetch;
    if(oldWorkspace===undefined)delete process.env.HARNESS_WORKSPACE;else process.env.HARNESS_WORKSPACE=oldWorkspace;
    if(oldToken===undefined)delete process.env.HARNESS_TOKEN;else process.env.HARNESS_TOKEN=oldToken;
    rmSync(root,{recursive:true,force:true});
  }
});
