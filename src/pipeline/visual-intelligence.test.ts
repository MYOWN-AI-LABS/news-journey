import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { visualMediaProblem } from "./visual-media.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cueWordIndex, narrationTiming, visualBeat, buildSegmentTimes } from "./visual-timing.js";
import { ensureVisualPlans, visualPlanProblem, hydrateVisualImage } from "./visual-director.js";
import type { VisualPlan } from "./visual-plan.js";
import { sourceVideoUrls, loadSourceFootage } from "./source-footage.js";

const fieldReview = (prompt: string) => prompt.startsWith('AUTHORED FIELD SOURCE REVIEW') ? { fields: JSON.parse(prompt.match(/^AUTHORED_FIELDS: (.*)$/m)![1]!).map((row: {id:string}) => ({ id: row.id, supported: true, claimIds: [1], reason: 'Injected source support for this fixture.' })) } : null;

test("visual cues reject ambiguity and align to actual story-scoped transcript tokens", () => {
  assert.equal(cueWordIndex("Its notice says yes. Another notice says no.", "notice says"), null);
  const spoken = "First, the board. Then the chip works.";
  const words = ["Previous", "First,", "the", "board.", "Then", "the", "chip", "works.", "Next"].map((w,i)=>({w,start:i,end:i+.8}));
  const timing = narrationTiming(spoken,["First", "the chip"],words,1,8);
  assert.deepEqual(timing.starts,[0,4]);
  assert.equal(visualBeat(3.9,timing),0);
  assert.equal(visualBeat(4,timing),1);
  assert.equal(visualBeat(.2,timing),0); // seeking backwards is a pure lookup
  assert.equal(narrationTiming(spoken,["Previous"],words,1,8).method,"unmatched");
  assert.equal(narrationTiming(spoken,["missing"],words,1,8).method,"unmatched");
  assert.equal(narrationTiming(spoken,["chip", "First"],words,1,8).method,"unmatched");
});

test("director requires real images and ordered cues, caches valid choices, invalidates changed evidence", async () => {
  const dir=mkdtempSync(join(tmpdir(),"visual-intelligence-"));
  const narration="The board supports the chip. Cooling removes heat.";
  const plan: VisualPlan={version:1,kind:"three",mechanism:"data-flow",intent:"Explain component placement",reason:"The layers overlap in the source view.",labels:["Board","Cooling"],cues:["The board","Cooling removes"],caveat:"Schematic, not to scale",sourceUrl:"https://example.com/source",decision:"model"};
  assert.equal(visualPlanProblem(plan,narration,false,0),null);
  assert.match(visualPlanProblem({...plan,kind:"source"},narration,false,0)!,/actual captured image/);
  assert.match(visualPlanProblem({...plan,cues:["Cooling removes","The board"]},narration,false,0)!,/narration order/);
  let calls=0;
  const choose=async(prompt: string)=>{const reviewed=fieldReview(prompt);if(reviewed)return reviewed;calls++;return plan;};
  try {
    writeFileSync(join(dir,"topic.json"),JSON.stringify({primaryUrl:plan.sourceUrl,stories:[{assetRef:"og-0",primaryUrl:plan.sourceUrl,verifiedClaims:["The board supports the chip. Cooling removes heat. The documented layers overlap."]}]}));
    const body=[{voiceover:narration,assetRef:"og-0",onScreen:{title:"Assembly"},motion:{who:"Manufacturer",what:"Compute assembly",how:narration,impact:"Parts have distinct roles",status:"Schematic"}}] as any;
    const diagrams=[{svg:"",label:"",reading:"",legend:[]}];
    const first=await ensureVisualPlans(dir,body,diagrams,choose as any);
    assert.equal(first[0].kind,"three");
    await ensureVisualPlans(dir,body,diagrams,choose as any);assert.equal(calls,1);
    body[0].onScreen.title="Changed evidence";
    await ensureVisualPlans(dir,body,diagrams,choose as any);assert.equal(calls,2);
    assert.throws(()=>hydrateVisualImage(dir,{...plan,image:{file:"../escape.png",sha256:"bad",kind:"source-image",sourceUrl:plan.sourceUrl}}),/leaves workspace/);
    body[0].voiceover="No matching cues here";
    const failed=await ensureVisualPlans(dir,body,diagrams,choose as any);
    assert.equal(failed[0].kind,"diagram");assert.equal(failed[0].timing?.method,"unmatched");
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test("padded media headers with matching hashes do not count as decoded artwork", () => {
  const fake = Buffer.alloc(128);fake.write("ftyp",4);
  const media:any={hash:"a".repeat(64),mp4:"data:video/mp4;base64,"+fake.toString("base64"),sha256:{mp4:createHash("sha256").update(fake).digest("hex")}};
  assert.match(visualMediaProblem({kind:"three",media} as any)!,/decoded|animation/);
});

test("visual plan caches cannot follow a symlink into another workspace",async()=>{
  const parent=mkdtempSync(join(tmpdir(),"visual-boundary-")),dir=join(parent,"story"),outside=join(parent,"other.json");
  mkdirSync(dir);writeFileSync(outside,'{"unchanged":true}');
  try{
    try{symlinkSync(outside,join(dir,"visual-plans.json"));}catch(e){if(process.platform==="win32"&&(e as NodeJS.ErrnoException).code==="EPERM")return;throw e;}
    await assert.rejects(ensureVisualPlans(dir,[],[]),/Symlink leaves workspace/);
    assert.equal(readFileSync(outside,"utf8"),'{"unchanged":true}');
  }finally{rmSync(parent,{recursive:true,force:true});}
});

test("source footage stays bound to its story, bytes and reviewed excerpt", async () => {
  assert.deepEqual(sourceVideoUrls('<video src="/demo.webm"></video><source src="/unrelated.mp4"><meta property="og:video" content="javascript:bad"><video><source src="/demo.webm"></video>', 'https://example.com/story'), ['https://example.com/demo.webm']);
  const dir=mkdtempSync(join(tmpdir(),'source-footage-')), url='https://example.com/story';
  const bytes=Buffer.from('verified capture bytes'), hash=createHash('sha256').update(bytes).digest('hex');
  try {
    writeFileSync(join(dir,'clip.mp4'),bytes);writeFileSync(join(dir,'frame.png'),bytes);
    const clip={file:'clip.mp4',sha256:hash,sourceUrl:'https://example.com/demo.mp4',pageUrl:url,originalSha256:hash,duration:9,startSec:0,frames:[1,3,6].map(sec=>({file:'frame.png',sha256:hash,sec}))};
    writeFileSync(join(dir,'capture.json'),JSON.stringify({storyUrl:url,clip}));
    assert.ok(loadSourceFootage(dir,'capture.json',url));
    assert.equal(loadSourceFootage(dir,'capture.json','https://example.com/other-story'),undefined);
    assert.equal(loadSourceFootage(dir,'../capture.json',url),undefined);
    writeFileSync(join(dir,'assets.json'),JSON.stringify({'og-0-footage':'capture.json'}));
    writeFileSync(join(dir,'topic.json'),JSON.stringify({stories:[{assetRef:'og-0',primaryUrl:url,verifiedClaims:['React controls the composited layers and captions join the video in the official demonstration.']}]}));
    const body=[{assetRef:'og-0',voiceover:'React controls layers. Captions join the video.',onScreen:{title:'React video'},motion:{how:'Code controls layers'}}] as any;
    const choice={kind:'source',intent:'See code become video',reason:'The captured demo shows composited layers.',labels:['React layers','Captions'],cues:['React controls','Captions join'],caveat:'Official demonstration'};
    let inspected=0;
    const plans=await ensureVisualPlans(dir,body,[{svg:''}] as any,async(prompt: string)=>(fieldReview(prompt)??choice) as any,async()=>{inspected++;return {relevant:true,reason:'Visible animation layers',startSec:3} as any;});
    assert.equal(plans[0].clip?.startSec,3);assert.equal(plans[0].clip?.relevance?.sha256,hash);
    assert.ok(hydrateVisualImage(dir,plans[0]).clip?.dataUri?.startsWith('data:video/mp4;'));
    await ensureVisualPlans(dir,body,[{svg:''}] as any,async()=>{throw new Error('cached choice must not rerun');},async()=>{throw new Error('cached QA must not rerun');});
    assert.equal(inspected,1);
    writeFileSync(join(dir,'topic.json'),JSON.stringify({primaryUrl:url}));
    const single=await ensureVisualPlans(dir,[{...body[0],assetRef:'repo-shot',scene:'repo_card'}],[{svg:''}] as any,async(prompt: string)=>(fieldReview(prompt)??choice) as any,async()=>({relevant:true,reason:'Visible animation layers',startSec:3}) as any);
    assert.equal(single[0].decision,'fallback');assert.equal(single[0].clip,undefined);assert.match(single[0].warning!,/verified source claims/,'a legacy single story cannot infer evidence from its own generated narration');
    writeFileSync(join(dir,'clip.mp4'),'changed bytes');
    assert.equal(loadSourceFootage(dir,'capture.json',url),undefined);
    assert.throws(()=>hydrateVisualImage(dir,plans[0]),/hash changed/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test("section boundaries follow normalized transcript words rather than whitespace counts",()=>{
  const words="Today AI powered robots First robots sense Then robots move Subscribe".split(" ").map((w,i)=>({w,start:i,end:i+.8}));
  const script={hook:"Today: AI-powered robots.",body:[{voiceover:"First robots sense. Then robots move."}],cta:"Subscribe"} as any;
  const bounds=buildSegmentTimes(script,{words,durationSec:11} as any);
  assert.deepEqual(bounds[1],{startSec:4,endSec:9.8});
  assert.deepEqual(narrationTiming(script.body[0].voiceover,["First","Then"],words,4,9.8).starts,[0,3]);
  assert.equal(narrationTiming(script.body[0].voiceover,["First","Then"],words,3,8.8).method,"unmatched");
  assert.throws(()=>buildSegmentTimes(script,{words:words.filter(w=>w.w!=="move"),durationSec:11} as any),/regenerate voice/);
});
