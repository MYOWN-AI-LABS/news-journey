// Exercise the actual selection path with in-memory HTTP and claim-judge responses only.
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_ROOT, createWorkspace } from "../workspaces.js";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const identity = mkdtempSync(join(tmpdir(), "rank-test-identity-"));
const prior = { HARNESS_WORKSPACE: process.env.HARNESS_WORKSPACE, HARNESS_IDENTITY_FILE: process.env.HARNESS_IDENTITY_FILE, HARNESS_TOKEN: process.env.HARNESS_TOKEN, HARNESS_STORY_CHOICE: process.env.HARNESS_STORY_CHOICE };
delete process.env.HARNESS_WORKSPACE; delete process.env.HARNESS_TOKEN; delete process.env.HARNESS_STORY_CHOICE;
process.env.HARNESS_IDENTITY_FILE = join(identity, "identity.json");
const slug = "rank-test-" + process.pid, root = createWorkspace(slug, false, CODE_ROOT);
process.env.HARNESS_WORKSPACE = slug;
const realFetch = globalThis.fetch;
// Article downloads use the guarded HTTPS transport; keep the selection test entirely in memory.
// DNS/redirect/size policy is exercised independently in validate.test.ts.
const publicHttp = mock.method(https, "request", (url: string, options: { method?: string }, callback: Function) => {
  assert.ok(String(url).startsWith("https://news.example.org/"), `Unexpected public request: ${url}`);
  const req: any = new EventEmitter();
  req.destroy = (error: Error) => { req.emit("error", error); return req; };
  req.end = () => { void (async () => {
    const fixture = await globalThis.fetch(url, { method: options.method || "GET" });
    const body = Buffer.from(await fixture.arrayBuffer());
    const response: any = new EventEmitter(); response.statusCode = fixture.status; response.headers = {}; response.resume = () => {};
    callback(response);
    if (fixture.status < 300) { if (options.method !== "HEAD") response.emit("data", body); response.emit("end"); }
  })().catch(error => req.emit("error", error)); };
  return req;
});
syncBuiltinESMExports();
after(() => {
  publicHttp.mock.restore(); syncBuiltinESMExports();
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true }); rmSync(identity, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const write = (rel: string, value: unknown) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(value, null, 2)); };
const model = JSON.parse(readFileSync(join(root, "config/model.json"), "utf8"));
write("config/model.json", { ...model, provider: "ollama", timeoutSeconds: 5, rescue: { enabled: false }, providers: { ...model.providers, ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "fixture-model" } } });
const pipeline = JSON.parse(readFileSync(join(root, "config/pipeline.json"), "utf8"));
write("config/pipeline.json", { ...pipeline, format: "roundup", roundup: { ...pipeline.roundup, minStories: 3, maxStories: 4, alternates: 2 } });
const sources = JSON.parse(readFileSync(join(root, "config/sources.json"), "utf8"));


const letters = ["a","b","c","d","e","f","g"];
async function harvestAndRank(p: string, opts: {manual?:boolean;alternates?:number;interstitial?:string[];unverified?:string[]} = {}) {
  write("config/sources.json",{...sources,enabledSources:["rss"],ranking:{mode:opts.manual?"manual":"newest"}});
  write("config/pipeline.json",{...pipeline,format:"roundup",roundup:{minStories:3,maxStories:4,alternates:opts.alternates??2}});
  const {HARVEST_DIR,todayStamp,videoDir}=await import("../util.js");
  const items=letters.map((l,i)=>({id:`${p}-${l}`,source:"rss:news.example.org",title:`${p} story ${l}`,url:`https://news.example.org/${p}/${l}`,score:1000*i,publishedAt:"2026-01-01T00:00:00Z",repo:null,summary:`Summary ${l}`}));
  mkdirSync(HARVEST_DIR,{recursive:true});writeFileSync(join(HARVEST_DIR,`${todayStamp()}.json`),JSON.stringify({fetchedAt:new Date().toISOString(),items}));
  const prompts:string[]=[];
  globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input instanceof Request?input.url:input);
    if(url.endsWith('/api/show'))return new Response('{"capabilities":["completion"]}');
    if(url.endsWith('/api/chat')){
      const prompt=JSON.parse(String(init?.body)).messages[0].content as string;prompts.push(prompt);
      assert.ok(!prompt.includes('Harvested items')&&!prompt.includes('Replacement stories'),'selection must not call a model to order stories');
      const refused=(opts.unverified??[]).some(l=>prompt.includes(`${p} story ${l}`));
      const answer=refused?{claims:[],unsupported:['No checkable claim.']}:{claims:['The fixture article states one concrete, checkable fact.'],unsupported:[]};
      return new Response(JSON.stringify({message:{content:JSON.stringify(answer)},done:false})+'\n'+JSON.stringify({message:{content:''},done:true,prompt_eval_count:1,eval_count:1})+'\n');
    }
    if(url.endsWith(`/${p}/g`))return new Response('gone',{status:404});
    if((opts.interstitial??['b']).some(l=>url.endsWith(`/${p}/${l}`)))return new Response(init?.method==='HEAD'?null:'<body>Just a moment... Checking your browser.</body>');
    if(url.startsWith('https://news.example.org/'))return new Response(init?.method==='HEAD'?null:`<article>${'The fixture article states one concrete, checkable fact. '.repeat(50)}</article>`);
    throw new Error('Unexpected network '+url);
  }) as typeof fetch;
  const {rank}=await import('./rank.js');const [topic]=await rank();const dir=videoDir(topic.id);
  const get=(name:string)=>JSON.parse(readFileSync(join(dir,name),'utf8'));
  return {topic,dir,prompts,meta:get('meta.json'),choice:get('story-choice.json'),report:get('selection-report.json')};
}
test('dead and unreadable sources are replaced before a selected slate can reach writing',async()=>{
 const {topic,report,meta,prompts}=await harvestAndRank('one');
 assert.deepEqual(topic.stories!.map(s=>s.headline),['one story a','one story c','one story d']);
 assert.equal(meta.status,'selected');assert.equal(report.selectionPolicyId,'operator-ranking-v1');
 assert.ok(!report.candidates.some((c:any)=>c.candidateId==='one-g'));
 assert.equal(report.candidates.find((c:any)=>c.candidateId==='one-b').verification.kept,false);
 assert.ok(topic.stories!.every(s=>s.claimEvidence&&s.verifiedClaims?.length));
 assert.ok(prompts.length>0,'source claims were still checked');
 assert.ok(report.candidates.every((c:any)=>c.compositeScore===null&&c.scoreBreakdown===null));
});
test('manual mode pauses without an env override and honors the actual chosen lead',async()=>{
 const {dir,choice,meta}=await harvestAndRank('two',{manual:true});
 assert.equal(meta.status,'awaiting_story_choice');assert.equal(choice.lock,undefined);
 const {lockStoryChoice,applyStoryChoice}=await import('./story-choice.js');
 const keys=choice.entries.map((e:any)=>e.key);lockStoryChoice(dir,{keys:[keys[0],keys[1],keys[3]],lead:keys[3]},'user');
 const selected=applyStoryChoice(dir);assert.deepEqual(selected.stories!.map(s=>s.headline),['two story e','two story a','two story c']);
});
test('replacement skips multiple unreadable candidates without another selection-model call',async()=>{
 const {topic,report}=await harvestAndRank('three',{alternates:0,interstitial:['b','d','e']});
 assert.deepEqual(topic.stories!.map(s=>s.headline),['three story a','three story c','three story f']);assert.equal(report.replacementRound.attempts,3);
});
test('unverifiable claims are replaced before writing',async()=>{
 const {topic,report}=await harvestAndRank('four',{interstitial:[],unverified:['b']});
 assert.ok(!topic.stories!.some(s=>s.headline==='four story b'));assert.match(report.candidates.find((c:any)=>c.candidateId==='four-b').verification.reason,/claims unverifiable/);
 assert.ok(topic.headline.endsWith(': '+topic.stories![0].headline),'the roundup is titled after its verified lead, not the first candidate: '+topic.headline);
 assert.ok(!topic.id.includes('four-story-b'),'the id follows the verified lead, not the dropped candidate: '+topic.id);
});
test('an exhausted readable pool emits a shorter edition with the readable stories; only zero readable stories hold',async()=>{
 const {topic}=await harvestAndRank('five',{alternates:0,interstitial:['b','d','e','f']});
 assert.equal(topic.stories!.length,2,'two readable stories make a two-story edition instead of a hold');
 await assert.rejects(harvestAndRank('five',{alternates:0,interstitial:['a','b','c','d','e','f']}),/Only 0 stories have readable sources/);
});
test('a failed or rejected package with today\'s title yields the next id; a live one is a duplicate',async()=>{
 const {roundupPackageId}=await import('./rank.js'); const {videoDir}=await import('../util.js');
 const base='20260101-roundup-retry-fixture';
 const pkg=(id:string,status:string)=>{ mkdirSync(videoDir(id),{recursive:true}); writeFileSync(join(videoDir(id),'topic.json'),'{}'); writeFileSync(join(videoDir(id),'meta.json'),JSON.stringify({id,status})); };
 assert.equal(roundupPackageId(base),base,'no package yet');
 pkg(base,'failed:visuals'); assert.equal(roundupPackageId(base),`${base}-2`);
 pkg(`${base}-2`,'rejected'); assert.equal(roundupPackageId(base),`${base}-3`);
 pkg(`${base}-3`,'awaiting_story_choice'); assert.throws(()=>roundupPackageId(base),/Roundup 20260101-roundup-retry-fixture-3 already exists/);
});
