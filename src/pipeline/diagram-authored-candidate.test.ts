import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readAuthoredDiagramCandidate, saveAuthoredDiagramCandidate, type DiagramCandidateBinding } from './diagram-authored-candidate.js';
import { authorStoryDiagram, type AuthoredDiagram } from './story-diagram.js';
import { reviewDiagramSource } from './diagram-source-support.js';
import { createSourceSupportContext } from './source-support.js';
import { preparedModelTask } from './writing-task.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const binding: DiagramCandidateBinding = { parentIdentity:'a'.repeat(64), writerKey:'codex-fixture', scriptHash:'b'.repeat(64), sourceCaptureHash:'c'.repeat(64), promptHash:'d'.repeat(64), story:1 };
function diagram(n=1): AuthoredDiagram { return {svg:`<svg class="tm-story-svg tm-svg-authored" data-visual-primitive="authored-${n}" viewBox="0 0 720 340" role="img" aria-labelledby="tm-visual-${n}"><title id="tm-visual-${n}">Proposed route</title><rect class="tm-sc-node" x="20" y="60" width="100" height="70"/><rect class="tm-sc-node" x="180" y="60" width="100" height="70"/><circle class="tm-sc-core-dot" cx="70" cy="95" r="8"/><circle class="tm-sc-core-dot" cx="230" cy="95" r="8"/><line class="tm-native-route" x1="120" y1="95" x2="180" y2="95"/><path class="tm-native-trace" d="M120 110 L180 110"/></svg>`, label:'PILOT', reading:'The pilot guarantees improved service.', legend:[{kind:'source',label:'City'},{kind:'result',label:'Pilot'}]}; }

test('retained candidates are unreviewed, immutable, and bound to each exact source/script/writer/parent', () => {
 const dir=mkdtempSync(join(tmpdir(),'svg-candidate-'));
 try {
  saveAuthoredDiagramCandidate(dir,binding,{...diagram(),sourceReview:{version:1,hash:'fake',reviewedFields:[]}} as AuthoredDiagram);
  assert.deepEqual(readAuthoredDiagramCandidate(dir,binding),diagram());
  for (const key of ['parentIdentity','scriptHash','sourceCaptureHash','promptHash'] as const) assert.equal(readAuthoredDiagramCandidate(dir,{...binding,[key]:'e'.repeat(64)}),null);
  assert.equal(readAuthoredDiagramCandidate(dir,{...binding,writerKey:'different-model'}),null);
  assert.throws(()=>saveAuthoredDiagramCandidate(dir,binding,{...diagram(),reading:'Changed'}),/Never replace/);
  const file=join(dir,'diagram-authored-candidates',readdirSync(join(dir,'diagram-authored-candidates'))[0]!);
  const value=JSON.parse(readFileSync(file,'utf8'));value.diagram.svg+='changed';writeFileSync(file,JSON.stringify(value));
  assert.throws(()=>readAuthoredDiagramCandidate(dir,binding),/candidate changed/);
  value.diagram.sourceReview={passed:true};const {hash:_,...body}=value;value.hash=hash(body);writeFileSync(file,JSON.stringify(value));
  assert.throws(()=>readAuthoredDiagramCandidate(dir,binding),/cannot carry factual or phone approval/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('symlinked storage directories and candidate files cannot escape the package', () => {
 const base=mkdtempSync(join(tmpdir(),'svg-candidate-link-')),dir=join(base,'package'),outside=join(base,'outside');mkdirSync(dir);mkdirSync(outside);
 try {
  symlinkSync(outside,join(dir,'diagram-authored-candidates'));
  assert.throws(()=>saveAuthoredDiagramCandidate(dir,binding,diagram()),/escaped its package/);assert.deepEqual(readdirSync(outside),[]);
  rmSync(join(dir,'diagram-authored-candidates'));saveAuthoredDiagramCandidate(dir,binding,diagram());
  const file=join(dir,'diagram-authored-candidates',readdirSync(join(dir,'diagram-authored-candidates'))[0]!);const bytes=readFileSync(file);rmSync(file);writeFileSync(join(outside,'copy.json'),bytes);symlinkSync(join(outside,'copy.json'),file);
  assert.throws(()=>readAuthoredDiagramCandidate(dir,binding),/escaped its package/);
 } finally {rmSync(base,{recursive:true,force:true});}
});

test('actual author path persists all completed drawings before source rejection, then reuses prose without approving it', async () => {
 const dir=mkdtempSync(join(tmpdir(),'svg-author-resume-'));let authorCalls=0,reviewCalls=0;
 const story={onScreen:{title:'Proposed pilot'},motion:{kind:'flow' as const,who:'City',what:'Pilot',how:'Bus route',impact:'Not measured',status:'Proposed'}};
 const evidence={claims:['The city announced a proposed transit pilot.'],sourceContext:createSourceSupportContext('2026-09-15','https://example.org/pilot',[]),writerKey:binding.writerKey,presentation:story};
 const store={directory:dir,parentIdentity:binding.parentIdentity,writerKey:binding.writerKey,scriptHash:binding.scriptHash,sourceCaptureHash:binding.sourceCaptureHash};
 const author=async<T>(_prompt:string,_validate:unknown,task:any)=>{authorCalls++;return diagram(Number(task.taskId.split('-').at(-1))) as T;};
 const review=async<T>(prompt:string)=>{reviewCalls++;const fields=JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!);return {fields:fields.map((row:any)=>({id:row.id,supported:row.id!=='reading',claimIds:[1],reason:row.id==='reading'?'The source does not guarantee improved service.':'Source context supports this label.'}))} as T;};
 try {
  const drawings=[];for(let n=1;n<=3;n++)drawings.push(await authorStoryDiagram({...story.motion,title:story.onScreen.title},n,author,evidence,store));
  assert.equal(authorCalls,3);assert.equal(readdirSync(join(dir,'diagram-authored-candidates')).length,3);
  const task=preparedModelTask({role:'source-review',capability:'source-review',taskId:'diagram-1',topicIds:['story-1'],protocol:{version:1},evidence,candidate:drawings[0]});
  await assert.rejects(reviewDiagramSource(drawings[0]!,evidence,review,task),/does not guarantee improved service/);
  const retained=await authorStoryDiagram({...story.motion,title:story.onScreen.title},1,author,evidence,store);assert.deepEqual(retained,drawings[0]);assert.equal(authorCalls,3);
  await assert.rejects(reviewDiagramSource(retained,evidence,review,task),/does not guarantee improved service/);assert.equal(reviewCalls,2);
  assert.equal(readdirSync(join(dir,'diagram-authored-candidates')).length,3,'first review failure preserves both sibling drawings');
 } finally {rmSync(dir,{recursive:true,force:true});}
});
