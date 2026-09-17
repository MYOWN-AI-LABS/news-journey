import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { diagramAuthoredFields, reviewDiagramSource, hasDiagramSourceReceipt, type DiagramText, type DiagramReviewEvidence } from './diagram-source-support.js';
import { createSourceSupportContext } from './source-support.js';
import { preparedModelTask, type PreparedModelTask } from './writing-task.js';
import type { FieldSupportCall } from './field-support.js';
const diagram = (): DiagramText => ({ svg: '<svg aria-label="A planned pilot"><title>Pilot layout</title><desc>Illustrated proposed route</desc><g>'+Array.from({length:14},(_,i)=>`<text x="${i}">ROUTE <tspan>${i+1}</tspan></text>`).join('')+'</g></svg>', label:'PILOT', reading:'Read the proposed route from left to right.', legend:[{kind:'source',label:'Origin'},{kind:'route',label:'Proposed route'}] });
const context = createSourceSupportContext('2026-09-09','https://source.example/plan',[{url:'https://source.example/plan',sha256:'a'.repeat(64),textSha256:'b'.repeat(64),restrictions:[{sourceSentenceId:43,text:'The pilotDate must be confirmed before any route starts.'}]}]);
const evidence = {claims:['The source proposes a pilot route.'],sourceContext:context,writerKey:'selected-writer',presentation:{status:'Planned'}};
const task=preparedModelTask({role:'source-review',capability:'source-review',taskId:'diagram-1',topicIds:['topic-1'],protocol:{version:1},evidence});

test('every diagram label, nested text and accessible description is reviewed in bounded batches with full context and byte-exact artwork', async()=>{
 const d=diagram(), before=JSON.stringify(d), all=diagramAuthoredFields(d),seen:string[]=[];let calls=0;
 const call:FieldSupportCall=async<T>(prompt:string,validate:(value:T)=>string|null,descriptor?:PreparedModelTask)=>{
  calls++;assert.equal(descriptor?.role,'source-review');
  const context=JSON.parse(prompt.match(/^PRESENTATION_CONTEXT: (.*)$/m)![1]!);assert.deepEqual(context.allDiagramFields,all);
  assert.equal(JSON.parse(prompt.match(/^SOURCE_CONTEXT: (.*)$/m)![1]!).sources[0].restrictions[0].sourceSentenceId,43);
  const fields=JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);assert.ok(fields.length<=12);seen.push(...fields.map((row:any)=>row.id));
  const value={fields:fields.map((row:any)=>({id:row.id,supported:true,claimIds:[1],reason:'Injected fixture support.'}))} as T;
  assert.equal(validate(value),null);return value;
 };
 const receipt=await reviewDiagramSource(d,evidence,call,task);
 assert.equal(calls,2);assert.deepEqual(seen,all.map(row=>row.id));assert.equal(JSON.stringify(d),before);
 assert.ok(all.some(row=>row.id==='svg.text.14'&&row.text==='ROUTE 14'));assert.ok(all.some(row=>row.id==='svg.aria.1'));
 assert.ok(hasDiagramSourceReceipt({...d,sourceReview:receipt} as DiagramText,evidence,receipt));
 for(const changed of [{...d,reading:'A proven route.'},{...d,svg:d.svg.replace('Planned','Deployed').replace('planned','proven')},{...d,legend:[{kind:'result',label:'Guaranteed benefit'}]}]) assert.equal(hasDiagramSourceReceipt(changed,evidence,receipt),false);
 assert.equal(hasDiagramSourceReceipt(d,{...evidence,writerKey:'changed'},receipt),false);assert.equal(hasDiagramSourceReceipt(d,evidence,undefined),false);
});

test('a failed diagram field stops before any repair or geometry change; incomplete reviews fail closed',async()=>{
 const d=diagram(),before=JSON.stringify(d);let calls=0;
 const call:FieldSupportCall=async<T>(prompt:string,validate:(value:T)=>string|null)=>{
  calls++;const fields=JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
  const value={fields:fields.map((row:any)=>({id:row.id,supported:row.id!=='reading',claimIds:[1],reason:'The text asserts a result where only a plan is supplied.'}))} as T;assert.equal(validate(value),null);return value;
 };
 await assert.rejects(reviewDiagramSource(d,evidence,call,task),/did not pass review/);assert.equal(calls,1);assert.equal(JSON.stringify(d),before);
 await assert.rejects(reviewDiagramSource(d,evidence,async<T>()=>({fields:[]} as T),task),/every supplied field/);
});

test('complete diagram text exceeds bounds by failing, never by truncation or omitted aria text',()=>{
 assert.throws(()=>diagramAuthoredFields({...diagram(),svg:diagram().svg.replace('</g>','<text>Extra</text></g>')}),/at most 14/);
 assert.throws(()=>diagramAuthoredFields({...diagram(),reading:'x'.repeat(2001)}),/complete plain field/);
 assert.throws(()=>diagramAuthoredFields({...diagram(),legend:Array.from({length:9},()=>({kind:'source',label:'source'}))}),/bounded complete/);
});


test('actual rejected rows and exact prepared evidence survive blocked repair without another model call', async () => {
 const d = diagram(), before = JSON.stringify(d), records: DiagramReviewEvidence[] = []; let calls = 0;
 const call: FieldSupportCall = async<T>(prompt: string) => {
  calls++; const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
  return { fields: fields.map((field: {id: string}) => ({ id: field.id, supported: field.id !== 'reading', claimIds: [1], reason: field.id === 'reading' ? 'The route is proposed; guaranteed operation is not established.' : 'Supported fixture label.' })) } as T;
 };
 await assert.rejects(reviewDiagramSource(d, evidence, call, task, { saveEvidence: row => { records.push(row); } }), /reading: The route is proposed; guaranteed operation is not established/);
 assert.equal(calls, 1); assert.equal(JSON.stringify(d), before);
 assert.deepEqual(records.map(row => row.stage), ['review-response', 'repair-blocked']);
 for (const row of records) {
  assert.deepEqual(row.claims, evidence.claims); assert.deepEqual(row.fields, diagramAuthoredFields(d));
  assert.equal(row.promptHash, createHash('sha256').update(row.prompt).digest('hex'));
  assert.equal(row.responseHash, createHash('sha256').update(JSON.stringify(row.response)).digest('hex'));
  assert.ok(row.prompt.includes('pilotDate must be confirmed')); assert.ok(row.task.evidenceHash);
 }
 assert.deepEqual((records[1]!.response as any).flagged.map((row: any) => row.id), ['reading']);
});

test('literal-source contradiction retains its raw critic rows and holds before any repair or diagram acceptance', async () => {
 const d: DiagramText = {svg:'<svg><title>Pilot</title><text>Pilot</text></svg>', label:'Pilot', reading:evidence.claims[0]!, legend:[{kind:'source',label:'Pilot'}]};
 const records: DiagramReviewEvidence[] = []; let returned: any; let calls = 0;
 const call: FieldSupportCall = async<T>(prompt: string) => {
  calls++;
  const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);
  returned = {fields: fields.map((row: any) => ({id:row.id, supported:row.id !== 'reading', claimIds:[1], reason:row.id === 'reading' ? 'No claim mentions a pilot route.' : 'Source label.'}))};
  return returned as T;
 };
 await assert.rejects(reviewDiagramSource(d, evidence, call, task, {saveEvidence: row => {records.push(row);}}), /Source review disputed/);
 assert.equal(records.length, 1);
 const saved = (records[0]!.response as any).fields.find((row: any) => row.id === 'reading');
 assert.equal(saved.supported, false); assert.equal(saved.reason, 'No claim mentions a pilot route.');
 assert.equal(returned.fields.find((row: any) => row.id === 'reading').supported, false, 'Original critic verdict remains unchanged');
 assert.equal(calls, 1, 'No repair or same-critic retry may follow the dispute');
 assert.equal(records[0]!.responseHash, createHash('sha256').update(JSON.stringify(records[0]!.response)).digest('hex'));
});

test('a review-evidence persistence failure stops before an acceptance receipt', async () => {
 let calls = 0;
 const call: FieldSupportCall = async<T>(prompt: string) => { calls++; const fields = JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!); return {fields: fields.map((row: any) => ({id:row.id,supported:true,claimIds:[1],reason:'Fixture support.'}))} as T; };
 await assert.rejects(reviewDiagramSource(diagram(), evidence, call, task, {saveEvidence: () => {throw new Error('Evidence disk unavailable');}}), /Evidence disk unavailable/);
 assert.equal(calls, 1);
});
