import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exercise the real durable controller and byte hashes in a fresh scoped workspace;
 * only provider/renderer work is replaced. No model, audio or video is generated. */
function run(program: string): void {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  mkdirSync(join(root, 'workspaces'), { recursive: true });
  const workspace = mkdtempSync(join(root, 'workspaces/test-media-completion-'));
  const slug = workspace.split(/[\\/]/).at(-1)!, token = 'a'.repeat(64);
  try {
    mkdirSync(join(workspace, 'config'), { recursive: true });
    writeFileSync(join(workspace, 'config/pipeline.json'), JSON.stringify({ ttsEngine:'kokoro', voice:'af_heart' }));
    writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: slug }));
    writeFileSync(join(workspace, 'members.json'), JSON.stringify([{ id: 'fixture-owner', role: 'owner', tokenHash: createHash('sha256').update(token).digest('hex') }]));
    const child = `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
      import { join } from 'node:path';
      import http from 'node:http'; import https from 'node:https';
      import { syncBuiltinESMExports } from 'node:module';
      let network = 0;
      const deny = () => { network++; throw new Error('Unexpected provider request'); };
      globalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny; syncBuiltinESMExports();
      const { completeMediaReview, renderedMediaHash, rememberRenderedMedia, canReuseRenderedMedia, canReuseNarration, beginSnapshotRenderRepair, renderedSnapshotsMatch, assertRetainedMediaReview, authorizeImageAdapterCorrection, inspectVisualPresentationRevision, beginVisualPresentationRevision, assertVisualPresentationRevision } = await import(${JSON.stringify(new URL('./media-completion.ts', import.meta.url).href)});
      const id = '20260915-isolated-media', dir = join(${JSON.stringify(workspace)}, 'workdir/videos', id);
      mkdirSync(join(dir, 'assets'), { recursive: true });
      const save = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
      const read = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const hash = value => createHash('sha256').update(value).digest('hex');
      const script = { hook:'Reported proposal', fullVoiceoverText:'The city announced a proposal.', body:[{ voiceover:'The city announced a proposal.', assetRef:'photo', scene:'news_card', onScreen:{title:'Reported proposal'}, motion:{kind:'flow',who:'City',what:'Proposal',how:'Announcement',impact:'Unknown',status:'Proposed'} }] };
      const topic = {id,headline:'Reported proposal',kind:'roundup',stories:[{n:1,headline:'The city announced a proposal',primaryUrl:'https://example.org/report',assetRef:'photo',verifiedClaims:[]}]};
      save('script.json',script);save('topic.json',topic);save('meta.json',{id,status:'rendered'});
      save('props.json',{headline:topic.headline,segments:[{...script.body[0],startSec:0,endSec:10,assetFile:null}],durationSec:10});
      save('timestamps.json',{narrationSha256:hash(script.fullVoiceoverText),durationSec:10,words:[{w:'The',start:0,end:1}]});
      save('audio-qc.json',{version:1,status:'pass',method:'raw-asr-script-comparison',blocking:[],heardWords:[{w:'The',start:0,end:1}],requestedText:script.fullVoiceoverText,scriptSha256:hash(script.fullVoiceoverText),audioSha256:hash('unchanged audio fixture'),engine:'kokoro',voice:'af_heart'});
      save('audio.wav', 'unchanged audio fixture'); save('final.mp4', 'unchanged render fixture');
      save('assets/photo.png', 'unchanged local source image'); save('assets.json', { photo: 'assets/photo.png' });
      const context = { parent: { parentId: id, parentIdentity: 'same-original-parent', root: ${JSON.stringify(workspace)} }, topic: { id }, writerKey: 'same-selected-writer' };
      const result = (n, kind = null, targets = []) => ({ version: 1, ok: kind === null, failureKind: kind,
        findings: kind ? [{ severity: 'blocking', kind, target: targets[0] ?? 'visual', detail: 'Fixture ' + kind + ' finding ' + n }] : [],
        repairTargets: targets, checkedAt: '2026-09-15T00:00:00Z', inputHash: renderedMediaHash(dir), evidencePath: 'review-' + n,
        reviewer: { writerKey: context.writerKey, parentIdentity: context.parent.parentIdentity, attempts: [] }, audioListeningApproved: false, publicationReady: false });
      const forbidden = async () => { throw new Error('Unexpected text/media regeneration'); };
      const state = () => read('media-completion.json');
      const configPath = join(${JSON.stringify(workspace)},'config/pipeline.json');
      const selectSnapshot = async () => {
        const {ensureVisualCandidates,lockVisualChoices,selectedSourceSnapshots}=await import(${JSON.stringify(new URL('./visual-choice.ts', import.meta.url).href)});
        const candidates=ensureVisualCandidates(dir,script.body,[],false);lockVisualChoices(dir,candidates,{'0':'snapshot'},'user');
        return selectedSourceSnapshots(dir).get(0);
      };
      const failedReview = () => {const review=result(1,'content',['visual']);save('media-completion.json',{version:1,parent:context.parent.parentIdentity,attempts:[{status:'finished',result:review}],repairs:[]});return review;};
      const authorizeFinalCheck = () => {
        const attempts = [1,2,3].map(n=>({status:'finished',result:result(n,'infrastructure')}));
        const original={version:1,parent:context.parent.parentIdentity,attempts,repairs:[]};
        save('media-completion.json',original);const bytes=readFileSync(join(dir,'media-completion.json')),priorHash=hash(bytes);
        mkdirSync(join(dir,'media-continuation-evidence'),{recursive:true});writeFileSync(join(dir,'media-continuation-evidence',priorHash+'.json'),bytes);
        const identity=hash('explicit-authorized-continuation'),receipt={version:1,originalCompletionHash:priorHash,mediaHash:renderedMediaHash(dir),receiptHash:hash(readFileSync(join(dir,'rendered-media.json'))),attempts:3,evidence:{}};
        save('media-completion.json',{...original,parent:identity,continuation:{identity,priorCompletionHash:priorHash,priorAttempts:3}});
        const continued={...context,parent:{...context.parent,parentIdentity:identity},mediaReviewRecovery:{identity,receipt,assertUnchanged:()=>assertRetainedMediaReview(dir,identity,receipt)}};
        return {continued,attempts,bytes,priorHash};
      };
      const catalogPreflight = async continued => {
        const {reviewFinalMediaPackage}=await import(${JSON.stringify(new URL('./final-media-qc.ts', import.meta.url).href)});
        const {preparedScriptReceipt}=await import(${JSON.stringify(new URL('./writing-context.ts', import.meta.url).href)});
        const {roleHash}=await import(${JSON.stringify(new URL('../llm/role-router.ts', import.meta.url).href)});
        save('companion-writing-receipt.json',preparedScriptReceipt(topic,context.writerKey,script));
        const scoped={...continued,topic,parent:{...continued.parent,limits:{totalSeconds:120,maxPhysicalCalls:8,maxToolCalls:16}},vision:forbidden};
        const failure=await reviewFinalMediaPackage(dir,scoped,'',false,{technical:()=>({pass:false,issues:['final.mp4 is older than visual-candidates.json']}),contrast:async()=>[]});
        assert.equal(failure.reviewer.attempts.length,0);assert.equal(failure.findings.length,1);
        const inputs=read(failure.evidencePath+'/inputs.json');inputs.version=2;save(failure.evidencePath+'/inputs.json',inputs);failure.inputHash=roleHash(inputs);
        save(failure.evidencePath+'/result.json',{...failure,frames:[]});
        const current=state();current.attempts.push({status:'finished',result:failure});save('media-completion.json',current);return failure;
      };
      ${program}
      assert.equal(network, 0);
      process.stdout.write('MEDIA_COMPLETION_FIXTURE_PASSED');
    `;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: root, timeout: 20_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, HARNESS_WORKSPACE: slug, HARNESS_TOKEN: token, HARNESS_IDENTITY_FILE: join(workspace, 'identity.json') },
    });
    assert.match(output, /MEDIA_COMPLETION_FIXTURE_PASSED/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

test('infrastructure retries retain identical media and stop after two retries across resume', () => run(`
  const initial = renderedMediaHash(dir); let reviews = 0;
  const actions = { render: forbidden, voice: forbidden, rebuild: forbidden, review: async () => {
    reviews++; assert.equal(renderedMediaHash(dir), initial); return result(reviews, 'infrastructure');
  } };
  await assert.rejects(completeMediaReview(id, context, actions), /unavailable after two retries/);
  assert.equal(reviews, 3); assert.equal(state().attempts.length, 3); assert.equal(state().repairs.length, 0);
  const saved = readFileSync(join(dir, 'media-completion.json'), 'utf8');
  await assert.rejects(completeMediaReview(id, context, actions), /unavailable after two retries/);
  assert.equal(reviews, 3); assert.equal(renderedMediaHash(dir), initial);
  assert.equal(readFileSync(join(dir, 'media-completion.json'), 'utf8'), saved);
`));

test('content correction routes only the required work and cannot exceed two repairs', () => run(`
  let reviews = 0, renders = 0, voices = 0, rebuilds = 0;
  const originalScript = readFileSync(join(dir, 'script.json'), 'utf8');
  const actions = {
    render: async () => { renders++; save('final.mp4', 'corrected render ' + renders); },
    voice: async () => { voices++; save('audio.wav', 'corrected audio ' + voices); },
    rebuild: async () => { rebuilds++; },
    review: async () => { reviews++; return result(reviews, 'content', reviews === 1 ? ['render'] : reviews === 2 ? ['audio', 'render'] : ['visual']); },
  };
  await assert.rejects(completeMediaReview(id, context, actions), /still needs correction/);
  assert.deepEqual({ reviews, renders, voices, rebuilds }, { reviews: 3, renders: 2, voices: 1, rebuilds: 0 });
  assert.equal(state().repairs.length, 2); assert.ok(state().repairs.every(row => row.status === 'finished'));
  assert.equal(readFileSync(join(dir, 'script.json'), 'utf8'), originalScript);
  await assert.rejects(completeMediaReview(id, context, actions), /still needs correction/);
  assert.equal(reviews, 3); assert.equal(renders, 2);
`));

test('an interrupted content repair stays reserved and cannot be purchased again on resume', () => run(`
  let reviews = 0, repairs = 0;
  const actions = { render: forbidden, voice: forbidden,
    visual: async findings => { repairs++; assert.deepEqual(findings, ['Fixture content finding 1']); throw new Error('Fixture visual repair interrupted'); },
    review: async () => { reviews++; return result(reviews, 'content', ['visual']); } };
  await assert.rejects(completeMediaReview(id, context, actions), /visual repair interrupted/);
  assert.equal(state().repairs[0].status, 'started');
  await assert.rejects(completeMediaReview(id, context, actions), /reserved media repair was interrupted/);
  assert.deepEqual({ reviews, repairs }, { reviews: 1, repairs: 1 });
  await assert.rejects(completeMediaReview(id, { ...context, parent: { ...context.parent, parentIdentity: 'replacement-parent' } }, actions), /receipt changed/);
  assert.deepEqual({ reviews, repairs }, { reviews: 1, repairs: 1 });
`));

test('repeated accepted resumes use exact cached review without spending the attempt allowance', () => run(`
  rememberRenderedMedia(id); let reviewCalls = 0, physical = 0; let cached;
  const actions = { render: forbidden, voice: forbidden, rebuild: forbidden, review: async () => {
    reviewCalls++; if (!cached || cached.inputHash !== renderedMediaHash(dir)) { physical++; cached = result(physical); } return cached;
  } };
  await completeMediaReview(id, context, actions);
  const saved = readFileSync(join(dir, 'media-completion.json'), 'utf8');
  for (let i = 0; i < 12; i++) await completeMediaReview(id, context, actions);
  assert.equal(physical, 1); assert.equal(state().attempts.length, 1); assert.ok(reviewCalls >= 1);
  assert.equal(readFileSync(join(dir, 'media-completion.json'), 'utf8'), saved);
  save('final.mp4', 'different video bytes require another independent review');
  await completeMediaReview(id, context, actions);
  assert.equal(physical, 2); assert.equal(state().attempts.length, 2);
`));

test('render reuse requires exact narration, audio, timing, props, asset and video bytes', () => run(`
  assert.equal(canReuseRenderedMedia(id), false); rememberRenderedMedia(id); assert.equal(canReuseRenderedMedia(id), true);
  for (const name of ['script.json', 'topic.json', 'audio.wav', 'audio-qc.json', 'timestamps.json', 'props.json', 'assets/photo.png', 'final.mp4']) {
    const original = readFileSync(join(dir, name)); writeFileSync(join(dir, name), Buffer.concat([original, Buffer.from(' changed')]));
    assert.equal(canReuseRenderedMedia(id), false, name + ' change must invalidate render reuse');
    writeFileSync(join(dir, name), original); assert.equal(canReuseRenderedMedia(id), true);
  }
  save('avatar.mp4', 'new presenter video'); assert.equal(canReuseRenderedMedia(id), false);
  rememberRenderedMedia(id); assert.equal(canReuseRenderedMedia(id), true);
  rmSync(join(dir, 'assets/photo.png')); assert.equal(canReuseRenderedMedia(id), false);
  assert.throws(() => rememberRenderedMedia(id), /missing required media/);
`));

test('narration reuse binds selected voice, configuration and exact audio evidence; legacy needs its explicit guard', () => run(`
  rememberRenderedMedia(id); assert.equal(canReuseNarration(id),true);
  const receipt=read('rendered-media.json'); save('rendered-media.json',{version:1,hash:receipt.hash});
  assert.equal(canReuseNarration(id),false);assert.equal(canReuseRenderedMedia(id),false);
  let guarded=0;assert.equal(canReuseNarration(id,()=>{guarded++;}),true);assert.equal(guarded,1);
  assert.equal(canReuseNarration(id,()=>{throw new Error('changed original configuration');}),false);
  save('rendered-media.json',receipt);
  const cfg=readFileSync(configPath);writeFileSync(configPath,JSON.stringify({ttsEngine:'kokoro',voice:'another_voice'}));
  assert.equal(canReuseNarration(id),false);assert.equal(canReuseRenderedMedia(id),false);writeFileSync(configPath,cfg);
  for(const name of ['audio.wav','audio-qc.json','timestamps.json','script.json']) {
    const before=readFileSync(join(dir,name));writeFileSync(join(dir,name),Buffer.concat([before,Buffer.from(' changed')]));
    assert.equal(canReuseNarration(id),false,name);writeFileSync(join(dir,name),before);
  }
  save('avatar.mp4','different presenter');assert.equal(canReuseNarration(id),false);rmSync(join(dir,'avatar.mp4'));
  const qc=read('audio-qc.json');save('audio-qc.json',{...qc,voice:'unselected_voice'});rememberRenderedMedia(id);
  assert.equal(canReuseNarration(id,()=>{}),false,'a newly stored hash cannot bless the wrong selected voice');
`));

test('snapshot repair spends an existing slot before render and retains its failed review through mandatory fresh QC', () => run(`
  rememberRenderedMedia(id);const snapshot=await selectSnapshot(),previous=failedReview();const originalAudio=readFileSync(join(dir,'audio.wav'));
  const finish=beginSnapshotRenderRepair(id,context.parent.parentIdentity);assert.equal(typeof finish,'function');
  assert.equal(state().repairs.length,1);assert.equal(state().repairs[0].status,'started');assert.deepEqual(state().attempts[0].result,previous);
  assert.throws(()=>beginSnapshotRenderRepair(id,context.parent.parentIdentity),/interrupted/);
  assert.throws(()=>finish(),/did not preserve/);
  const props=read('props.json');props.segments[0].sourceSnapshot=snapshot;save('props.json',props);save('final.mp4','corrected locked snapshot video');
  finish();rememberRenderedMedia(id);assert.equal(state().repairs[0].status,'finished');assert.ok(readFileSync(join(dir,'audio.wav')).equals(originalAudio));
  let checks=0;await completeMediaReview(id,context,{voice:forbidden,render:forbidden,review:async()=>{checks++;return result(2);}});
  assert.equal(checks,1);assert.equal(state().attempts.length,2);assert.deepEqual(state().attempts[0].result,previous);assert.equal(state().repairs.length,1);
`));

test('snapshot reservation refuses nonvisual holds, exhausted allowances, changed parent and protected package decisions', () => run(`
  rememberRenderedMedia(id);await selectSnapshot();failedReview();const clean=readFileSync(join(dir,'media-completion.json'));
  for(const target of ['audio','script']) {
    const row=state();row.attempts[0].result.findings[0].target=target;save('media-completion.json',row);
    assert.throws(()=>beginSnapshotRenderRepair(id,context.parent.parentIdentity),/non-visual hold/);writeFileSync(join(dir,'media-completion.json'),clean);
  }
  const row=state();row.repairs=[{review:'old-a',status:'finished',targets:['render']},{review:'old-b',status:'finished',targets:['render']}];save('media-completion.json',row);
  assert.throws(()=>beginSnapshotRenderRepair(id,context.parent.parentIdentity),/allowance/);writeFileSync(join(dir,'media-completion.json'),clean);
  assert.throws(()=>beginSnapshotRenderRepair(id,'different-parent'),/receipt changed/);
  const meta=read('meta.json');for(const extra of [{status:'rejected'},{status:'approved'},{status:'posted'},{reviewHold:{reason:'hold'}},{rejectReason:'hold'},{approvedBy:'owner'},{explicitApproval:{actor:'owner'}},{posts:{linkedin:{id:'existing'}}},{delivery:{linkedin:{state:'started'}}}]) {
    save('meta.json',{...meta,...extra});const bytes=readFileSync(join(dir,'meta.json'));assert.throws(()=>beginSnapshotRenderRepair(id,context.parent.parentIdentity),/held/);assert.ok(readFileSync(join(dir,'meta.json')).equals(bytes));
  }
  save('meta.json',meta);assert.ok(readFileSync(join(dir,'media-completion.json')).equals(clean));
`));


test('authorized expired-preflight continuation appends one fresh success without regenerating or erasing any prior attempt', () => run(`
  rememberRenderedMedia(id);const initial=renderedMediaHash(dir),{continued,attempts,bytes,priorHash}=authorizeFinalCheck();let reviews=0;
  const actions={voice:forbidden,render:forbidden,review:async()=>{reviews++;return result(4);}};
  await completeMediaReview(id,continued,actions);
  assert.equal(reviews,1);assert.equal(state().attempts.length,4);assert.deepEqual(state().attempts.slice(0,3),attempts);assert.deepEqual(state().repairs,[]);
  assert.equal(renderedMediaHash(dir),initial);assert.ok(readFileSync(join(dir,'media-continuation-evidence',priorHash+'.json')).equals(bytes));
  await assert.rejects(completeMediaReview(id,{...continued,mediaReviewRecovery:undefined},actions),/exact authorized context/);
  assert.equal(reviews,1);
`));

test('one continued final review cannot renew infrastructure retries, repairs, or an interrupted attempt', () => run(`
  for(const mode of ['infrastructure','content','interrupted']) {
    rememberRenderedMedia(id);const {continued,attempts}=authorizeFinalCheck();let reviews=0;
    const actions={voice:forbidden,render:forbidden,visual:forbidden,review:async()=>{reviews++;if(mode==='interrupted')throw new Error('fixture interrupted');return result(4,mode,['render']);}};
    await assert.rejects(completeMediaReview(id,continued,actions),/one authorized|fixture interrupted/);
    assert.equal(reviews,1);assert.equal(state().attempts.length,4);assert.deepEqual(state().attempts.slice(0,3),attempts);assert.deepEqual(state().repairs,[]);
    await assert.rejects(completeMediaReview(id,continued,actions),/one authorized/);assert.equal(reviews,1);
  }
`));

test('continued final review checks preserved prefix and media before dispatch and before accepting its result', () => run(`
  rememberRenderedMedia(id);const {continued}=authorizeFinalCheck();let reviews=0;
  const original=readFileSync(join(dir,'media-completion.json'));
  const changed=state();changed.attempts[0].result.ok=true;save('media-completion.json',changed);
  await assert.rejects(completeMediaReview(id,continued,{voice:forbidden,render:forbidden,review:async()=>{reviews++;return result(4);}}),/allowance changed/);assert.equal(reviews,0);
  writeFileSync(join(dir,'media-completion.json'),original);
  await assert.rejects(completeMediaReview(id,continued,{voice:forbidden,render:forbidden,review:async()=>{reviews++;save('audio.wav','changed during review');return result(4);}}),/evidence changed/);
  assert.equal(reviews,1);assert.equal(state().attempts[3].status,'started');assert.equal(state().attempts[3].result,undefined);
`));

test('one versioned catalog-only preflight correction preserves every failed row and cannot renew a failed model check', () => run(`
  const snapshot=await selectSnapshot();const props=read('props.json');props.segments[0].sourceSnapshot=snapshot;save('props.json',props);
  rememberRenderedMedia(id);const initial=renderedMediaHash(dir),{continued,bytes,priorHash}=authorizeFinalCheck();
  const previous=await catalogPreflight(continued);const prefix=structuredClone(state().attempts);let reviews=0;
  const actions={voice:forbidden,render:forbidden,review:async()=>{reviews++;return result(5,'infrastructure');}};
  await assert.rejects(completeMediaReview(id,continued,actions),/one authorized/);
  assert.equal(reviews,1);assert.equal(state().attempts.length,5);assert.deepEqual(state().attempts.slice(0,4),prefix);assert.equal(state().preflightCorrection.version,1);assert.deepEqual(state().repairs,[]);
  assert.equal(renderedMediaHash(dir),initial);assert.ok(readFileSync(join(dir,'media-continuation-evidence',priorHash+'.json')).equals(bytes));
  await assert.rejects(completeMediaReview(id,continued,actions),/one authorized/);assert.equal(reviews,1);
  save(previous.evidencePath+'/result.json',{...previous,frames:[],ok:true});
  await assert.rejects(completeMediaReview(id,continued,actions),/exact evidence/);assert.equal(reviews,1);
`));

test('catalog preflight correction refuses actual provider calls, other findings, changed choices and user holds', () => run(`
  const snapshot=await selectSnapshot();const props=read('props.json');props.segments[0].sourceSnapshot=snapshot;save('props.json',props);
  rememberRenderedMedia(id);const {continued}=authorizeFinalCheck();const previous=await catalogPreflight(continued);
  const original=readFileSync(join(dir,'media-completion.json')),resultBytes=readFileSync(join(dir,previous.evidencePath,'result.json')),choicesBytes=readFileSync(join(dir,'visual-choices.json'));let reviews=0;
  const actions={voice:forbidden,render:forbidden,review:async()=>{reviews++;return result(5);}};
  for(const kind of ['model','finding','choice','hold']) {
    const current=state(),review=current.attempts[3].result;
    if(kind==='model')review.reviewer.attempts=[{model:'actual provider call'}];
    if(kind==='finding')review.findings[0].detail='Frame caption differs from accepted script';
    if(kind==='choice'){const choices=read('visual-choices.json');choices.stories['0'].candidateHash='changed';save('visual-choices.json',choices);}
    if(kind==='hold')save('meta.json',{...read('meta.json'),reviewHold:{reason:'user hold'}});
    save('media-completion.json',current);if(kind==='model'||kind==='finding')save(previous.evidencePath+'/result.json',{...review,frames:[]});
    await assert.rejects(completeMediaReview(id,continued,actions),/one authorized|held by/);assert.equal(reviews,0);
    writeFileSync(join(dir,'media-completion.json'),original);writeFileSync(join(dir,previous.evidencePath,'result.json'),resultBytes);writeFileSync(join(dir,'visual-choices.json'),choicesBytes);save('meta.json',{id,status:'rendered'});
  }
`));

test('explicit Grok image-adapter correction retains the spent reservation and allows one actual frame check only', () => run(`
  context.writerKey=JSON.stringify({runtime:{provider:'grok',model:'selected-grok',command:'grok'}});
  const snapshot=await selectSnapshot();const props=read('props.json');props.segments[0].sourceSnapshot=snapshot;save('props.json',props);
  rememberRenderedMedia(id);const {continued}=authorizeFinalCheck();
  const {reviewFinalMediaPackage}=await import(${JSON.stringify(new URL('./final-media-qc.ts', import.meta.url).href)});
  const {preparedScriptReceipt}=await import(${JSON.stringify(new URL('./writing-context.ts', import.meta.url).href)});
  const {roleHash,reserveParentModelAttempt,beginParentWork}=await import(${JSON.stringify(new URL('../llm/role-router.ts', import.meta.url).href)});
  save('companion-writing-receipt.json',preparedScriptReceipt(topic,context.writerKey,script));
  let calls=0;const scoped={...continued,topic,parent:{...continued.parent,limits:{totalSeconds:120,maxPhysicalCalls:8,maxToolCalls:16}},vision:async()=>{
    calls++;reserveParentModelAttempt(scoped.parent,'frame-'+calls,{provider:'grok',model:'selected-grok',attempt:1,rescue:false,promptBytes:1,promptHash:hash('prompt')});
    throw new Error(calls===1?'The Grok CLI writer accepts text only. Choose an image-capable HTTP Grok model or another vision writer.':'Provider unavailable');
  }};
  const adapters={technical:()=>({pass:true,issues:[]}),contrast:async()=>[],frames:async(_dir,out)=>{const path=join(out,'frame.png');writeFileSync(path,'frame');return[path]}};
  const failure=await reviewFinalMediaPackage(dir,scoped,'',false,adapters),current=state();current.attempts.push({status:'finished',result:failure});save('media-completion.json',current);
  const prefix=structuredClone(state().attempts),before=beginParentWork(scoped.parent);
  const actions={voice:forbidden,render:forbidden,review:()=>reviewFinalMediaPackage(dir,scoped,'',false,adapters)};
  await assert.rejects(completeMediaReview(id,continued,actions),/one authorized/);assert.equal(calls,1);
  authorizeImageAdapterCorrection(id,continued,roleHash(failure));assert.deepEqual(beginParentWork(scoped.parent),before);
  assert.throws(()=>authorizeImageAdapterCorrection(id,continued,roleHash(failure)),/exact spent/);
  await assert.rejects(completeMediaReview(id,continued,actions),/one authorized/);assert.equal(calls,2);
  assert.deepEqual(state().attempts.slice(0,4),prefix);assert.equal(beginParentWork(scoped.parent).physicalAttempts,2);assert.equal(state().attempts.length,5);assert.equal(state().repairs.length,0);
  await assert.rejects(completeMediaReview(id,continued,actions),/one authorized/);assert.equal(calls,2);
  save(failure.evidencePath+'/frame.png','changed reviewed frame');await assert.rejects(completeMediaReview(id,continued,actions),/exact evidence/);
`));


test('explicit presentation revision retains old results and counts while reviewing only the newly selected presentation', () => run(`
  rememberRenderedMedia(id);
  const old = [1,2].map(n=>{const r=result(n,'infrastructure');r.evidencePath='final-media-qc/aaaaaaaaaaaaaaaa-00000000-0000-0000-0000-00000000000'+n;mkdirSync(join(dir,r.evidencePath),{recursive:true});save(r.evidencePath+'/result.json',{...r,frames:[]});save(r.evidencePath+'/inputs.json',{retained:n});return{status:'finished',result:r};});
  save('media-completion.json',{version:1,parent:context.parent.parentIdentity,attempts:old,repairs:[]});
  const bytes=readFileSync(join(dir,'media-completion.json')), identity=hash('explicit presentation choice');
  const receipt=inspectVisualPresentationRevision(id,context.parent.parentIdentity);
  assert.equal(receipt.priorAttempts,2);
  assert.deepEqual(beginVisualPresentationRevision(id,context.parent.parentIdentity,identity,receipt.archiveHash),receipt);
  assert.ok(readFileSync(join(dir,receipt.archivePath)).equals(bytes));assert.deepEqual(state().attempts,old);
  const revision={...context,mediaVisualRevision:{identity,receipt,assertUnchanged:()=>assertVisualPresentationRevision(id,context.parent.parentIdentity,identity,receipt)}};
  assert.throws(()=>inspectVisualPresentationRevision(id,context.parent.parentIdentity),/completed, unmodified/);
  await assert.rejects(completeMediaReview(id,context,{voice:forbidden,render:forbidden,review:forbidden}),/exact authorized/);
  let calls=0;await completeMediaReview(id,revision,{voice:forbidden,render:forbidden,review:async()=>{calls++;return result(3);}});
  assert.equal(calls,1);assert.equal(state().attempts.length,3);assert.deepEqual(state().attempts.slice(0,2),old);
  assert.deepEqual(read('script.json'),script);assert.equal(readFileSync(join(dir,'audio.wav'),'utf8'),'unchanged audio fixture');
  save(old[0].result.evidencePath+'/inputs.json',{changed:true});
  assert.throws(()=>revision.mediaVisualRevision.assertUnchanged(),/Historical visual review evidence changed/);
`));

test('new presentation starts with zero attempts only when there was no previous completion state', () => run(`
  const identity=hash('first real visuals'),receipt=inspectVisualPresentationRevision(id,context.parent.parentIdentity);
  assert.equal(receipt.priorAttempts,0);beginVisualPresentationRevision(id,context.parent.parentIdentity,identity,receipt.archiveHash);
  const check=()=>assertVisualPresentationRevision(id,context.parent.parentIdentity,identity,receipt);
  const revision={...context,mediaVisualRevision:{identity,receipt,assertUnchanged:check}};let calls=0;
  await assert.rejects(completeMediaReview(id,revision,{voice:forbidden,render:forbidden,review:async()=>{calls++;return result(calls,'infrastructure');}}),/unavailable after two retries/);
  assert.equal(calls,3);await assert.rejects(completeMediaReview(id,revision,{voice:forbidden,render:forbidden,review:forbidden}),/unavailable after two retries/);
  writeFileSync(join(dir,receipt.archivePath),'changed');assert.throws(check,/archive changed/);
`));
