import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Topic, Script, RenderProps } from '../types.js';
import { beginParentWork, reserveParentModelAttempt, roleHash } from '../llm/role-router.js';
import { approvedMediaScript, finalMediaFileFindings, reviewFinalMediaPackage, renderInputIsNewer, type FinalMediaAdapters } from './final-media-qc.js';
import { preparedScriptReceipt, type packageWritingContext } from './writing-context.js';
import { SCRIPT_FIRST_EDITORIAL_VERSION } from './daily-editorial.js';
import { reviewedJourneyScript } from './narration.js';
import { ensureVisualCandidates, lockVisualChoices, selectedSourceSnapshots } from './visual-choice.js';

test('refreshing the real visual catalog does not invalidate unchanged selected media; changed choices and assets still hold', async () => {
 const f=fixture();try {
  f.script.body[0]!.motion={kind:'flow',who:'City',what:'Route',how:'Proposal',impact:'Proposed route',status:'Requires a vote'};
  f.props.segments[0]!.motion=f.script.body[0]!.motion;f.topic.stories![0]!.assetRef='og-0';
  f.save('script.json',f.script);f.save('topic.json',f.topic);f.save('companion-writing-receipt.json',preparedScriptReceipt(f.topic,f.context.writerKey,f.script));
  const candidates=ensureVisualCandidates(f.dir,f.script.body,[],true);lockVisualChoices(f.dir,candidates,{'0':'snapshot'},'user');
  f.props.segments[0]!.sourceSnapshot=selectedSourceSnapshots(f.dir).get(0);f.save('props.json',f.props);
  const videoBytes=readFileSync(join(f.dir,'final.mp4'));
  ensureVisualCandidates(f.dir,f.script.body,[],false);
  const future=new Date(Date.now()+2000);utimesSync(join(f.dir,'visual-candidates.json'),future,future);
  assert.equal(finalMediaFileFindings(f.dir,f.topic,f.script,f.props).length,0);
  const checked=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(checked.ok,true);assert.equal(f.calls(),1);assert.ok(readFileSync(join(f.dir,'final.mp4')).equals(videoBytes));
  const choices=JSON.parse(readFileSync(join(f.dir,'visual-choices.json'),'utf8'));choices.stories['0'].candidateHash='changed';f.save('visual-choices.json',choices);
  await assert.rejects(reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters),/no longer matches/);assert.equal(f.calls(),1);
  f.save('assets.json',{photo:'photo.png'});f.save('photo.png','changed rendered asset');utimesSync(join(f.dir,'photo.png'),future,future);
  assert.ok(finalMediaFileFindings(f.dir,f.topic,f.script,f.props).some(row=>row.detail==='final.mp4 is older than photo.png'));
 }finally{f.close();}
});
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'final-media-qc-')), id='20260915-test', dir=join(root,'workdir/videos',id);mkdirSync(dir,{recursive:true});
 const topic={id,kind:'news',headline:'A proposed route',primaryUrl:'https://example.org/plan',stories:[{n:1,headline:'A proposed route',primaryUrl:'https://example.org/plan',verifiedClaims:['The route is proposed and requires a vote.'],claimEvidence:[{url:'https://example.org/plan',status:200,sha256:'a'.repeat(64),restrictions:[{sourceSentenceId:1,text:'The route requires a vote before it can open.'}]}]}]} as Topic;
 const script={hook:'A proposed route',intro:'Your local briefing.',cta:'Read the source.',fullVoiceoverText:'The route is proposed and requires a vote.',body:[{voiceover:'The route is proposed and requires a vote.',scene:'news_card',assetRef:'og-0',onScreen:{title:'A proposed route'}}],publish:{title:'A proposed route',description:'AI disclosure',linkedinPost:'AI disclosure',hashtags:[]}} as Script;
 const props={headline:topic.headline,hook:script.hook,cta:script.cta,segments:[{...script.body[0],startSec:0,endSec:5,assetFile:null}],words:[],durationSec:5,audioFile:`${id}/audio.wav`,accent:'#000000'} as RenderProps;
 const audio=Buffer.from('isolated exact audio fixture');
 const save=(name:string,data:unknown)=>writeFileSync(join(dir,name),typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data));
 save('topic.json',topic);save('script.json',script);save('props.json',props);save('meta.json',{id,durationSec:5,status:'rendered'});save('assets.json',{});save('audio.wav',audio);
 save('timestamps.json',{narrationSha256:sha(script.fullVoiceoverText)});save('audio-qc.json',{version:1,method:'raw-asr-script-comparison',status:'pass',blocking:[],heardWords:[{w:'route',start:0,end:1}],requestedText:script.fullVoiceoverText,scriptSha256:sha(script.fullVoiceoverText),audioSha256:sha(audio),listeningApproved:false});save('final.mp4','isolated video fixture; decoders injected');
 save('companion-writing-receipt.json',preparedScriptReceipt(topic,'exact-selected-model',script));
 const parent={root,parentId:id,parentIdentity:roleHash('fixed parent'),limits:{totalSeconds:120,maxPhysicalCalls:8,maxToolCalls:16}};
 let calls=0;let answer:unknown={findings:[]};let error:string|undefined;let mutate:(()=>void)|undefined;
 const context={topic,parent,writerKey:'exact-selected-model',call:()=>async()=>{throw new Error('No writing during final review');},vision:async<T>(prompt:string,_images:string[],validate:(value:T)=>string|null,task:any,bounds:any):Promise<T>=>{
   calls++;assert.equal(task.taskId,'final-media-review');assert.deepEqual(bounds,{maxPromptBytes:131072});assert.match(prompt,/The route is proposed and requires a vote/);assert.equal(task.role,'media-review');assert.equal(task.capability,'frame-alignment');assert.ok(!prompt.includes('PINNED_CLAIMS'));assert.ok(!prompt.includes('SOURCE_EVIDENCE'));assert.match(prompt,/Do not research, verify sources, reassess facts/);assert.match(prompt,/cannot establish how audio sounds/);
   reserveParentModelAttempt(parent,`review-${calls}`,{provider:'openai-compatible',model:'fixture-vision',attempt:1,rescue:false,promptBytes:Buffer.byteLength(prompt),promptHash:sha(prompt)});
   if(error)throw new Error(error);mutate?.();assert.equal(validate(answer as T),null);return structuredClone(answer) as T;
 }} as unknown as Awaited<ReturnType<typeof packageWritingContext>>;
 const adapters:FinalMediaAdapters={technical:(_meta,opts)=>{opts.beforeTool?.('mock-decode');return{pass:true,issues:[]};},contrast:async()=>[],frames:async(_dir,out,_props,beforeTool)=>{beforeTool('mock-extract-frame');const path=join(out,'story-1.png');writeFileSync(path,Buffer.from('exact frame fixture'));return[path];}};
 return {root,dir,topic,script,props,save,parent,context,adapters,calls:()=>calls,setAnswer:(value:unknown)=>{answer=value;},setError:(value:string|undefined)=>{error=value;},setMutate:(value:()=>void)=>{mutate=value;},close:()=>rmSync(root,{recursive:true,force:true})};
}

test('final media review retains exact evidence and provider attempts; unchanged acceptance resumes with zero calls',async()=>{
 const f=fixture();try{
  const first=await reviewFinalMediaPackage(f.dir,f.context,'AI disclosure',false,f.adapters);assert.equal(first.ok,true);assert.equal(first.publicationReady,false);assert.equal(first.audioListeningApproved,false);assert.equal(f.calls(),1);
  assert.equal((first.reviewer.attempts[0] as any).model,'fixture-vision');assert.equal(first.reviewer.writerKey,f.context.writerKey);
  const request=JSON.parse(readFileSync(join(f.dir,first.evidencePath,'review-request.json'),'utf8'));assert.equal(request.promptHash,sha(request.prompt));
  const before=beginParentWork(f.parent);const cached=await reviewFinalMediaPackage(f.dir,f.context,'AI disclosure',false,f.adapters);assert.equal(cached.inputHash,first.inputHash);assert.equal(f.calls(),1);assert.deepEqual(beginParentWork(f.parent),before);
  f.save('final.mp4','a changed video requires a new review');const changed=await reviewFinalMediaPackage(f.dir,f.context,'AI disclosure',false,f.adapters);assert.equal(changed.ok,true);assert.notEqual(changed.inputHash,first.inputHash);assert.equal(f.calls(),2);
 }finally{f.close();}
});

test('content findings retain actual reviewer reasons and repair targets, while transport failures request no rewrite',async()=>{
 const f=fixture();try{
  f.setAnswer({findings:[{severity:'blocking',target:'visual',detail:'Frame 1 omits the approved words requires a vote.'}]});
  const held=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(held.failureKind,'content');assert.deepEqual(held.repairTargets,['visual']);
  assert.match(readFileSync(join(f.dir,held.evidencePath,'review-response.json'),'utf8'),/requires a vote/);
  const original=readFileSync(join(f.dir,'script.json'));f.setError('Selected vision transport timed out');
  const failed=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(failed.failureKind,'infrastructure');assert.deepEqual(failed.repairTargets,[]);assert.ok(readFileSync(join(f.dir,'script.json')).equals(original));assert.equal(beginParentWork(f.parent).physicalAttempts,2);
 }finally{f.close();}
});

test('technical/audio/stale render defects stop before another media-alignment call',async()=>{
 const f=fixture();try{
  f.save('audio-qc.json',{status:'hold',blocking:['Missing qualifying word'],heardWords:[]});
  const out=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(out.ok,false);assert.ok(out.repairTargets.includes('audio'));assert.equal(f.calls(),0);
  assert.equal(renderInputIsNewer(2001,1000),true);assert.equal(renderInputIsNewer(2000,1000),false);
  const future=new Date(Date.now()+2000);utimesSync(join(f.dir,'script.json'),future,future);assert.ok(finalMediaFileFindings(f.dir,f.topic,f.script,f.props).some(row=>row.detail==='final.mp4 is older than script.json'));
 }finally{f.close();}
});

test('review cannot accept concurrently changed media or modified cached midpoint evidence',async()=>{
 const f=fixture();try{
  f.setMutate(()=>f.save('final.mp4','changed while reviewing'));const out=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(out.ok,false);assert.equal(out.failureKind,'infrastructure');assert.match(out.findings.at(-1)!.detail,/changed during review/);
  f.setMutate(()=>{});const accepted=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(accepted.ok,true);
  f.save(`${accepted.evidencePath}/story-1.png`,'replaced frame');await assert.rejects(reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters),/Reviewed frame changed/);assert.equal(f.calls(),2);
 }finally{f.close();}
});

test('unavailable technical checks are infrastructure holds; changed script acceptance never dispatches',async()=>{
 const f=fixture();try{
  const out=await reviewFinalMediaPackage(f.dir,f.context,'',false,{...f.adapters,technical:()=>{throw new Error('ffmpeg unavailable');}});assert.equal(out.failureKind,'infrastructure');assert.deepEqual(out.repairTargets,[]);assert.equal(f.calls(),0);
  f.script.fullVoiceoverText='Different unapproved text';f.save('script.json',f.script);await assert.rejects(reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters),/not bound/);assert.equal(f.calls(),0);
 }finally{f.close();}
});

test('final media never reads source captures or sends source claims to another factual judge',async()=>{
 const f=fixture();try{
  f.save('journey-editorial-input.json','malformed sentinel: final media must not read this source input');
  mkdirSync(join(f.dir,'journey-editorial-sources'));f.save('journey-editorial-sources/unread.raw','RAW_ARTICLE_SENTINEL: source checks already happened during script writing.');
  const sourceAccount={version:1 as const,claims:['NESTED_SOURCE_PACKET_SENTINEL'],sourceUrl:f.topic.primaryUrl,packetHash:sha('packet'),evidenceHash:sha('evidence')};
  f.script.body[0]!.sourceAccount=sourceAccount;f.props.segments[0]!.sourceAccount=sourceAccount;
  f.save('script.json',f.script);f.save('props.json',f.props);f.save('companion-writing-receipt.json',preparedScriptReceipt(f.topic,f.context.writerKey,f.script));
  const result=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(result.ok,true);assert.equal(f.calls(),1);
  const request=JSON.parse(readFileSync(join(f.dir,result.evidencePath,'review-request.json'),'utf8'));
  assert.ok(!request.prompt.includes('RAW_ARTICLE_SENTINEL'));assert.ok(!request.prompt.includes('NESTED_SOURCE_PACKET_SENTINEL'));assert.ok(!request.prompt.includes('claimEvidence'));assert.ok(!request.prompt.includes('SOURCE_EVIDENCE'));assert.equal(request.task.role,'media-review');
  f.save('journey-editorial-sources/unread.raw','The raw capture is still outside final-media checks.');
  const reused=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(reused.inputHash,result.inputHash);assert.equal(f.calls(),1);
 }finally{f.close();}
});

test('Journey media binds the existing approved checkpoint and final script without rereading any article',()=>{
 const f=fixture();try{
  const candidate=structuredClone(f.script), final=reviewedJourneyScript(candidate,f.topic.stories!.map(story=>story.primaryUrl));
  const state={status:'accepted',writes:1,origin:'model',candidates:[candidate],reviews:[{candidateHash:roleHash(candidate),reviewer:{provider:'codex',model:'fixture'},output:{verdict:'supported',reviewedStoryIds:['topic-1'],findings:[]}}],failures:[]};
  const artifacts={script:state,newsletter:{status:'accepted',writes:1,origin:'model',candidates:[{sections:[]}],reviews:[],failures:[]}};
  const checkpoint={version:1,identityHash:roleHash('original-step-four'),contentHash:roleHash(artifacts),artifacts};
  const receipt={version:3,reviewProtocol:'daily-editorial',editorialVersion:SCRIPT_FIRST_EDITORIAL_VERSION,topicHash:roleHash(f.topic),writerKey:f.context.writerKey,scriptHash:roleHash(final),checkpointHash:roleHash(checkpoint),inputHash:roleHash('original source inputs')};
  f.save('journey-editorial-checkpoint.json',checkpoint);f.save('companion-writing-receipt.json',receipt);
  assert.deepEqual(approvedMediaScript(f.dir,f.context,final),receipt);
  assert.throws(()=>approvedMediaScript(f.dir,f.context,{...final,fullVoiceoverText:'Changed narration'}),/exact accepted script/);
  state.status='held';f.save('journey-editorial-checkpoint.json',checkpoint);assert.throws(()=>approvedMediaScript(f.dir,f.context,final),/exact accepted script/);
  state.status='accepted';state.reviews[0]!.output.verdict='changes-required';checkpoint.contentHash=roleHash(artifacts);receipt.checkpointHash=roleHash(checkpoint);f.save('journey-editorial-checkpoint.json',checkpoint);f.save('companion-writing-receipt.json',receipt);
  assert.throws(()=>approvedMediaScript(f.dir,f.context,final),/recorded script approval/);
 }finally{f.close();}
});

test('the final media schema cannot request a script factual rewrite',async()=>{
 const f=fixture();try{
  f.setAnswer({findings:[{severity:'blocking',target:'script',detail:'Recheck the source for a fact.'}]});
  const result=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(result.ok,false);assert.equal(result.failureKind,'infrastructure');assert.deepEqual(result.repairTargets,[]);
 }finally{f.close();}
});

test('selected presentation is retained as a user choice without importing candidate source context',async()=>{
 const f=fixture();try{
  f.save('visual-choices.json',{version:1,videoId:f.topic.id,stories:{'0':{candidateId:'snapshot',candidateHash:'selected-card',chosenBy:'user',at:'2026-09-15T00:00:00Z'}}});
  f.save('visual-candidates.json',{version:1,videoId:f.topic.id,stories:[{index:0,candidates:[{id:'snapshot',hash:'selected-card',caption:'A proposed route',context:['DO_NOT_RESEND_PINNED_SOURCE_CONTEXT']}]}]});
  const result=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(result.ok,true);
  const request=JSON.parse(readFileSync(join(f.dir,result.evidencePath,'review-request.json'),'utf8'));assert.match(request.prompt,/"kind":"snapshot","selectedBy":"user"/);assert.ok(!request.prompt.includes('DO_NOT_RESEND_PINNED_SOURCE_CONTEXT'));
  f.save('visual-choices.json',{version:1,videoId:f.topic.id,stories:{'0':{candidateId:'snapshot',candidateHash:'different-choice',chosenBy:'user'}}});
  await assert.rejects(reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters),/no longer matches/);assert.equal(f.calls(),1);
 }finally{f.close();}
});

test('a missing rendered script field is a repairable content finding rather than a hashing exception',async()=>{
 const f=fixture();try{
  delete (f.props.segments[0] as unknown as Record<string,unknown>).onScreen;f.save('props.json',f.props);
  const result=await reviewFinalMediaPackage(f.dir,f.context,'',false,f.adapters);assert.equal(result.ok,false);assert.deepEqual(result.repairTargets,['render']);assert.equal(f.calls(),0);assert.match(result.findings[0]!.detail,/differs from its saved script/);
 }finally{f.close();}
});

test('selected snapshot metadata and contrast follow the displayed card rather than its hidden diagram',async()=>{
 const f=fixture();try{
  const snapshot={caption:'A proposed route — example.org',publisher:'example.org',sourceUrl:f.topic.primaryUrl};
  f.props.segments[0]!.sourceSnapshot=snapshot;
  f.props.segments[0]!.diagram={svg:'UNSELECTED_DIAGRAM_MUST_NOT_RENDER',reading:'UNSELECTED_DIAGRAM_DESCRIPTION'} as any;
  f.save('props.json',f.props);
  f.save('visual-choices.json',{version:1,videoId:f.topic.id,stories:{'0':{candidateId:'snapshot',candidateHash:'selected-card',chosenBy:'user'}}});
  f.save('visual-candidates.json',{version:1,videoId:f.topic.id,stories:[{index:0,candidates:[{id:'snapshot',hash:'selected-card',caption:snapshot.caption}]}]});
  // Use the real contrast implementation: an unselected SVG must not launch a browser or reserve contrast work.
  const result=await reviewFinalMediaPackage(f.dir,f.context,'',false,{...f.adapters,contrast:undefined});
  assert.equal(result.ok,true);assert.equal(f.calls(),1);
  const inputs=JSON.parse(readFileSync(join(f.dir,result.evidencePath,'inputs.json'),'utf8'));
  assert.equal(inputs.presentation.rendered[0].visual,'source-snapshot');assert.deepEqual(inputs.presentation.rendered[0].sourceSnapshot,snapshot);
  assert.equal(inputs.presentation.rendered[0].description,snapshot.caption);assert.deepEqual(inputs.presentation.rendered[0].labels,[]);
  const request=JSON.parse(readFileSync(join(f.dir,result.evidencePath,'review-request.json'),'utf8'));
  const tools=()=>JSON.parse(readFileSync(join(f.root,'state/role-tasks',f.topic.id,roleHash({version:1,parent:f.parent.parentIdentity}),'budget.json'),'utf8')).tools as {tool:string}[];
  assert.ok(!request.prompt.includes('UNSELECTED_DIAGRAM_DESCRIPTION'));assert.ok(!tools().some(row=>row.tool==='measure-contrast'));
  delete f.props.segments[0]!.sourceSnapshot;f.save('props.json',f.props);
  let contrastCalls=0;
  const visible=await reviewFinalMediaPackage(f.dir,f.context,'',false,{...f.adapters,contrast:async()=>{contrastCalls++;return[{severity:'blocking',kind:'content',target:'visual',detail:'Visible diagram fails contrast'}];}});
  assert.equal(visible.ok,false);assert.equal(contrastCalls,1);assert.ok(visible.findings.some(row=>row.detail==='Visible diagram fails contrast'));
  assert.ok(tools().some(row=>row.tool==='measure-contrast'));
 }finally{f.close();}
});
