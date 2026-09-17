import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { runScriptFirstEditorial, type DailyEditorialCheckpoint, type DailyEditorialInput, type DailyScriptFormat, type DailyEditorialReview } from './daily-editorial.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const sentence='The tournament organizer confirmed that the published schedule remains a provisional plan subject to inspection before any matches may take place.';
const prefix='The tournament organizer confirmed that the published schedule remains a provisional plan.';
const bad='The tournament schedule has been approved.';
const good='The tournament schedule remains subject to inspection.';
const source={id:'topic-1-source-1',url:'https://example.org/news',publishedAt:null,capturedAt:'2026-09-15T00:00:00Z',text:sentence,textSha256:sha(sentence),rawSha256:sha(sentence)};
const input:DailyEditorialInput={day:'2026-09-15',brief:'Test source.',stories:[{id:'topic-1',headline:'Schedule',primaryUrl:source.url,sources:[source]}]};
const candidate={hook:'Organizer announces provisional schedule.',body:[{voiceover:'The published schedule awaits the required venue inspection.',onScreen:{title:'Provisional schedule'}}],editorialCopy:[{storyId:'topic-1',text:`${bad} Officials still need to carry out a venue inspection.`}]};
const rejected:DailyEditorialReview={verdict:'changes-required',reviewedStoryIds:['topic-1'],findings:[{storyId:'topic-1',kind:'missing-condition',candidateExcerpt:bad,reason:'Inspection remains a condition.',evidence:[{sourceId:source.id,quote:prefix}]}]};
const format:DailyScriptFormat={identity:'citation-test',instructions:'Complete candidate',schema:{type:'object',additionalProperties:false,required:['hook','body','editorialCopy'],properties:{hook:{type:'string'},body:{type:'array',items:{type:'object',additionalProperties:false,required:['voiceover','onScreen'],properties:{voiceover:{type:'string'},onScreen:{type:'object',additionalProperties:false,required:['title'],properties:{title:{type:'string'}}}}}},editorialCopy:{type:'array',items:{type:'object',additionalProperties:false,required:['storyId','text'],properties:{storyId:{type:'string'},text:{type:'string'}}}}}},validate:()=>null,spokenText:v=>(v as typeof candidate).body[0]!.voiceover,reviewText:v=>JSON.stringify(v),newsletterCopy:v=>(v as typeof candidate).editorialCopy};
const identity={provider:'codex',model:'selected-model',runtimeHash:'b'.repeat(64)};
const invalid=(kind:'parse'|'validation')=>Object.assign(new Error(`retained ${kind} error`),{code:'MODEL_OUTPUT_INVALID',kind});
async function held(){
 let checkpoint!:DailyEditorialCheckpoint;
 const base={scriptFormat:format,newsletterBudget:{min:8,max:50},scriptBudget:{min:8,max:50},save:(cp:DailyEditorialCheckpoint)=>{checkpoint=cp;}};
 await assert.rejects(runScriptFirstEditorial(input,{...base,writer:{identity,call:async()=>structuredClone(candidate) as never},reviewer:{identity,call:async()=>{throw invalid('parse');}}}), /retained parse error/);
 const original=structuredClone(checkpoint);
 await assert.rejects(runScriptFirstEditorial(input,{...base,checkpoint,writer:{identity,call:async()=>{throw new Error('No rewrite');}},reviewer:{identity,call:async()=>{throw invalid('validation');}},reviewRecovery:{authorizationHash:'c'.repeat(64),checkpointHash:hash(checkpoint),candidateHash:hash(candidate),inputHash:hash(input),reviewerHash:hash(identity),parentIdentity:'d'.repeat(64),assertCurrentParent:()=>{}}}));
 return {base,original,checkpoint:()=>checkpoint,recovery:()=>({authorizationHash:'e'.repeat(64),checkpointHash:hash(checkpoint),inputHash:hash(input),writerHash:hash(identity),reviewerHash:hash(identity),parentIdentity:'d'.repeat(64),rawHash:'f'.repeat(64),originalReview:rejected,assertCurrentParent:()=>{}})};
}
test('citation recovery keeps rejection, spends original second write and requires same complete factual review before formatting',async()=>{
 const f=await held(),before=structuredClone(f.checkpoint()),calls:string[]=[];
 const result=await runScriptFirstEditorial(input,{...f.base,checkpoint:before,citationRecovery:f.recovery(),writer:{identity,call:async(_p,validate,task)=>{
  calls.push(task!.taskId);const value=task!.taskId==='daily-editorial-script-original-field-repair-2'?{replacements:[{id:'field_1',text:good}]}:{sections:[{storyId:'topic-1',text:candidate.editorialCopy[0]!.text.replace(bad,good)}]};assert.equal(validate(value as never),null);return value as never;
 }},reviewer:{identity,call:async(_p,validate,task)=>{calls.push(task!.taskId);const value={verdict:'supported',reviewedStoryIds:['topic-1'],findings:[]};assert.equal(validate(value as never),null);return value as never;}}});
 assert.deepEqual(calls,['daily-editorial-script-original-field-repair-2','daily-editorial-script-review-2','daily-editorial-newsletter-write-1']);
 const state=result.checkpoint.artifacts.script;assert.equal(state.writes,2);assert.equal(state.candidates.length,2);assert.deepEqual(state.candidates[0],before.artifacts.script.candidates[0]);assert.deepEqual(state.failures.slice(0,2),before.artifacts.script.failures);assert.equal(state.reviews[0]!.output.verdict,'changes-required');assert.equal(state.reviews[1]!.output.verdict,'supported');assert.equal(result.checkpoint.artifacts.newsletter.reviews.length,0);assert.equal(state.citationRecovery!.originalReview.findings[0]!.evidence[0]!.quote,prefix);assert.deepEqual((state.candidates[1] as unknown as typeof candidate).body,candidate.body);
});
test('failed original field repair stays spent and cannot resume another call',async()=>{
 const f=await held();let calls=0;
 await assert.rejects(runScriptFirstEditorial(input,{...f.base,checkpoint:f.checkpoint(),citationRecovery:f.recovery(),writer:{identity,call:async()=>{calls++;throw new Error('Injected field failure');}},reviewer:{identity,call:async()=>{throw new Error('Must not review');}}}),/Injected field failure/);
 assert.equal(f.checkpoint().artifacts.script.writes,2);assert.equal(f.checkpoint().artifacts.script.reviews[0]!.output.verdict,'changes-required');
 await assert.rejects(runScriptFirstEditorial(input,{...f.base,checkpoint:f.checkpoint(),writer:{identity,call:async()=>{calls++;throw new Error('Must not call');}},reviewer:{identity,call:async()=>{throw new Error('Must not review');}}}),/retained held/);assert.equal(calls,1);
});
test('citation reconciliation cannot convert findings to acceptance or mutate source ownership',async()=>{
 for(const mode of ['supported','source','reviewer']as const){const f=await held(),recovery=structuredClone({...f.recovery(),assertCurrentParent:undefined});if(mode==='supported')recovery.originalReview.verdict='supported';if(mode==='source')recovery.originalReview.findings[0]!.evidence[0]!.sourceId='wrong';if(mode==='reviewer')recovery.reviewerHash='0'.repeat(64);let calls=0;
 await assert.rejects(runScriptFirstEditorial(input,{...f.base,checkpoint:f.checkpoint(),citationRecovery:{...recovery,assertCurrentParent:()=>{}},writer:{identity,call:async()=>{calls++;throw new Error('No call');}},reviewer:{identity,call:async()=>{calls++;throw new Error('No call');}}}));assert.equal(calls,0);assert.equal(f.checkpoint().artifacts.script.writes,1);}
});
