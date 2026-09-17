import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runScriptFirstEditorial, type DailyEditorialCheckpoint, type DailyEditorialInput, type DailyScriptFormat, type DailyFactualRecovery, type DailyEditorialReview } from './daily-editorial.js';
import { prepareEditorialCopyExpansion } from './editorial-length-recovery.js';
import { assertTargetedFactualRepairCandidate, prepareEditorialFactualPatch, editorialFactualReplacementsValidator, applyEditorialFactualPatch } from './editorial-factual-repair.js';
import type { DraftCall } from './script.js';
import type { PreparedModelTask } from './writing-task.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const count = (text: string) => text.trim().split(/\s+/).length;
const prose = (name: string, n: number) => [name,...Array.from({length:n-2},(_,i)=>`detail${i}`),'ends.'].join(' ');
// Synthetic control: the erroneous completed outcome must remain a factual rejection.
const excerpt='The club had already received the recorded audio and video.';
const sourceQuote='The official had contacted the club to share the recorded audio and video.';
const fixed='The official had contacted the club to share the recorded audio and video.';
const base={text:prose('Narration',50),editorialCopy:[{storyId:'Alpha',text:prose('Original',85)}],presentation:'Unchanged presentation.'};
const source=base.editorialCopy[0]!.text+' '+sourceQuote+' '+prose('Extra',80);
const input:DailyEditorialInput={day:'2026-09-15',brief:'Synthetic orchestration fixture.',stories:[{id:'Alpha',headline:'Club notice',primaryUrl:'https://fixture.example/alpha',sources:[{id:'Alpha-source',url:'https://fixture.example/alpha',text:source,textSha256:sha(source),rawSha256:sha('raw'+source),publishedAt:'2026-09-14',capturedAt:'2026-09-15T00:00:00Z'}]}]};
const shape=(v:unknown)=>{const x=v as typeof base;return !x||typeof x.text!=='string'||!Array.isArray(x.editorialCopy)||x.editorialCopy.length!==1?'bad shape':null;};
const format:DailyScriptFormat={identity:hash('factual-fixture'),instructions:'Complete script.',schema:{type:'object',additionalProperties:false,required:['text','editorialCopy','presentation'],properties:{text:{type:'string'},presentation:{type:'string'},editorialCopy:{type:'array',items:{type:'object',additionalProperties:false,required:['storyId','text'],properties:{storyId:{type:'string'},text:{type:'string'}}}}}},validateShape:shape,
 validate(v){const bad=shape(v);if(bad)return bad;const x=v as typeof base,n=count(x.text),c=count(x.editorialCopy[0]!.text);if(n<40||n>60)return `script too short: ${n} spoken words (need 40-60). Add sourced body words.`;return c<100||c>200?`Complete editorialCopy has ${c} words; required 100–200, separately from spoken narration`:null;},spokenText:v=>(v as typeof base).text,reviewText:v=>JSON.stringify(v),newsletterCopy:v=>structuredClone((v as typeof base).editorialCopy)};
const options={scriptFormat:format,scriptBudget:{min:40,max:60},newsletterBudget:{min:100,max:200}};
const identity={provider:'codex',model:'synthetic-selected',runtimeHash:hash('runtime')};
const badReview:DailyEditorialReview={verdict:'changes-required',reviewedStoryIds:['Alpha'],findings:[{storyId:'Alpha',kind:'unsupported',candidateExcerpt:excerpt,evidence:[{sourceId:'Alpha-source',quote:sourceQuote}],reason:'Contact to share does not establish completed receipt.'}]};
const okay:DailyEditorialReview={verdict:'supported',reviewedStoryIds:['Alpha'],findings:[]};
const addition={additions:[{storyId:'Alpha',text:excerpt+' '+prose('Additional',35-count(excerpt))}]};
const badCandidate={...base,editorialCopy:[{storyId:'Alpha',text:base.editorialCopy[0]!.text+'\n\n'+addition.additions[0]!.text}]};
const replacements={replacements:[{storyId:'Alpha',excerpt,replacement:fixed}]};
const auth=(cp:DailyEditorialCheckpoint):DailyFactualRecovery=>({authorizationHash:hash('explicit current repair'),checkpointHash:hash(cp),inputHash:hash(input),writerHash:hash(identity),reviewerHash:hash(identity),parentIdentity:hash('same child'),assertCurrentParent(){}});
function routes(mode:'normal'|'length'|'factual',rejectAgain=false){const calls:string[]=[];let reviewed=0,latest=badCandidate;
 const writer:DraftCall=async<T>(_p:string,validate:(v:T)=>string|null,task?:PreparedModelTask)=>{calls.push(task!.taskId);let v:unknown;
 if(task!.taskId.includes('factual-patch')){v=replacements;latest=applyEditorialFactualPatch(badCandidate,prepareEditorialFactualPatch(input,badCandidate,badReview,format)!,replacements,format);}
 else if(task!.taskId.includes('authorized-length'))v=addition;
 else if(task!.role==='newsletter-draft')v={sections:latest.editorialCopy};else v=mode==='length'?base:badCandidate;
 const err=validate(v as T);if(err)throw new Error(err);return structuredClone(v) as T;};
 const reviewer:DraftCall=async<T>(_p:string,validate:(v:T)=>string|null,task?:PreparedModelTask)=>{calls.push(task!.taskId);reviewed++;const v=(mode==='length'||mode==='normal'&&reviewed===1||rejectAgain?{...badReview,findings:badReview.findings.map(f=>({...f,candidateExcerpt:rejectAgain&&mode==='factual'?fixed:f.candidateExcerpt}))}:okay) as T;const err=validate(v);if(err)throw new Error(err);return structuredClone(v);};
 return {calls,writer:{identity,call:writer},reviewer:{identity,call:reviewer}};}
async function heldAfterLength(){let cp:DailyEditorialCheckpoint|undefined;
 await assert.rejects(runScriptFirstEditorial(input,{...routes('length'),...options,save:v=>{cp=v;throw new Error('save initial identity');}}),/save initial/);
 cp!.artifacts.script={status:'held',writes:2,origin:'model',candidates:[base,{...base,text:prose('Short',30)}],reviews:[],failures:[format.validate(base)!,format.validate({...base,text:prose('Short',30)})!]};cp!.contentHash=hash(cp!.artifacts);
 const length=routes('length');await assert.rejects(runScriptFirstEditorial(input,{...length,...options,checkpoint:cp,lengthRecovery:auth(cp!),save:v=>{cp=v;}}),/Contact to share/);return cp!;}

test('normal factual repair changes only the owned rejected sentence then re-reviews the complete script',async()=>{
 const r=routes('normal'),out=await runScriptFirstEditorial(input,{...r,...options});assert.equal(r.calls.filter(x=>x.includes('factual-patch')).length,1);assert.equal(out.script.wordCount,50);
 const c=out.script.structured as typeof base;assert.equal(c.text,base.text);assert.equal(c.presentation,base.presentation);assert.equal(c.editorialCopy[0]!.text,badCandidate.editorialCopy[0]!.text.replace(excerpt,fixed));
 assert.equal(out.checkpoint.artifacts.script.writes,2);assert.equal(out.checkpoint.artifacts.script.reviews.length,2);assert.equal(out.checkpoint.artifacts.newsletter.reviews.length,0);
});

test('explicit same-parent factual recovery retains all length failures and receipts without refunding writes',async()=>{
 const cp=await heldAfterLength(),before=structuredClone(cp),r=routes('factual');let reserved=false;
 assert.doesNotThrow(()=>assertTargetedFactualRepairCandidate(cp,input,hash(identity)));
 const out=await runScriptFirstEditorial(input,{...r,...options,checkpoint:cp,factualRecovery:auth(cp),save:v=>{if(v.artifacts.script.factualRecovery?.status==='started'){reserved=true;assert.equal(v.artifacts.script.candidates.length,3);}}});
 assert.ok(reserved);assert.equal(out.checkpoint.artifacts.script.writes,2);assert.equal(out.checkpoint.artifacts.script.candidates.length,4);
 assert.deepEqual(out.checkpoint.artifacts.script.candidates.slice(0,3),before.artifacts.script.candidates);assert.deepEqual(out.checkpoint.artifacts.script.reviews[0],before.artifacts.script.reviews[0]);assert.deepEqual(out.checkpoint.artifacts.script.lengthRecovery,before.artifacts.script.lengthRecovery);
 assert.deepEqual(r.calls,['daily-editorial-script-authorized-factual-patch','daily-editorial-script-review-2','daily-editorial-newsletter-write-1']);
 const replay=routes('factual');await runScriptFirstEditorial(input,{...replay,...options,checkpoint:out.checkpoint});assert.equal(replay.calls.length,0);
});

test('factual rejection after the one patch remains held; no repeated scope or newsletter call',async()=>{
 const cp=await heldAfterLength(),r=routes('factual',true);let held:DailyEditorialCheckpoint|undefined;
 await assert.rejects(runScriptFirstEditorial(input,{...r,...options,checkpoint:cp,factualRecovery:auth(cp),save:v=>{held=v;}}),/Contact to share/);assert.equal(r.calls.length,2);assert.equal(held!.artifacts.newsletter.writes,0);
 const again=routes('factual');await assert.rejects(runScriptFirstEditorial(input,{...again,...options,checkpoint:held,factualRecovery:auth(held!)}));assert.equal(again.calls.length,0);
});

test('wrong source ownership, fabricated quotes, partial/ambiguous sentences and changed models fail before calls',async()=>{
 for(const variant of ['source','quote','partial','other-story']){const review=structuredClone(badReview);if(variant==='source')review.findings[0]!.evidence[0]!.sourceId='other-source';if(variant==='quote')review.findings[0]!.evidence[0]!.quote='Never supplied';if(variant==='partial')review.findings[0]!.candidateExcerpt='already received';if(variant==='other-story')review.findings[0]!.storyId='Bravo';assert.equal(prepareEditorialFactualPatch(input,badCandidate,review,format),null);}
 const cp=await heldAfterLength(),r=routes('factual'),permission=auth(cp);permission.writerHash=hash('different model');await assert.rejects(runScriptFirstEditorial(input,{...r,...options,checkpoint:cp,factualRecovery:permission}),/selected model changed/);assert.equal(r.calls.length,0);
 const plan=prepareEditorialFactualPatch(input,badCandidate,badReview,format)!;const changed={...badCandidate,presentation:'Changed'};assert.throws(()=>applyEditorialFactualPatch(changed,plan,replacements,format),/candidate changed/);
 const tooMany=structuredClone(replacements);tooMany.replacements[0]!.replacement=fixed+' Another sentence.';assert.ok(editorialFactualReplacementsValidator(plan)(tooMany));
});
