import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { parseBrief, configureExecutive } from "./onboarding.js";
import { CODE_ROOT } from "./workspaces.js";
import { renderNewsletterHtml } from "./pipeline/newsletter-html.js";
import { renderLinkedInEdition } from "./pipeline/newsletter-linkedin.js";
import { publisherBrief } from "./publisher.js";
import { resolveFreeVoice } from "./platform.js";

const brief=`# Publication\nName: Jordan Lee\nPublication: Healthcare Strategy Brief\nAudience: healthcare executives\nTone: Clear and grounded\n\n## Topics\n- evidence\n- market access\n\n## Sources\n- [Industry desk](https://news.example.org/feed)\n\n## Avoid\n- promotional hype\n\n## Notes\nExplain practical implications without inventing facts.\n`;

test("OpenCode brief validation accepts exact local/free routes and rejects unsupported routes", () => {
  for (const modelName of ["ollama/qwen2.5:7b", "opencode/example-free"]) {
    const parsed = parseBrief(brief + `\nModel: opencode\nModel name: ${modelName}\n`);
    assert.equal(parsed.model, "opencode"); assert.equal(parsed.modelName, modelName);
  }
  assert.equal(parseBrief(brief + '\nModel: opencode\n').modelName, undefined, 'bare provider can retain a validated saved model');
  for (const modelName of ["qwen2.5:7b", "opencode/paid", "ollama/example:cloud"]) assert.throws(() => parseBrief(brief + `\nModel: opencode\nModel name: ${modelName}\n`), /exact|unsupported/);
  assert.throws(() => parseBrief(brief + '\nModel: opencode\nModel name: ollama/qwen2.5:7b\nModel URL: https://wrong.example/v1\n'), /Model URL/);
});

test("one short brief personalizes a private workspace without a résumé and preserves edits", () => {
  const root=mkdtempSync(join(tmpdir(),"Executive setup with spaces & "));
  const priorIdentity=process.env.HARNESS_IDENTITY_FILE;
  process.env.HARNESS_IDENTITY_FILE=join(root,"identity.json");
  try {
    cpSync(join(CODE_ROOT,"config"),join(root,"config"),{recursive:true});mkdirSync(join(root,"profile"));
    writeFileSync(join(root,"profile/CONTENT.md"),brief);
    const first=configureExecutive(root);assert.equal(first.changed,true);
    const read=(file:string)=>JSON.parse(readFileSync(join(first.root,"config",file+'.json'),"utf8"));
    assert.deepEqual(read("sources").enabledSources,["rss"]);
    assert.deepEqual(read("sources").rss,[{name:"Industry desk",url:"https://news.example.org/feed"}]);
    assert.equal(read("editions/daily-roundup").repoRadar,false);
    assert.equal(read("publisher").name,"Jordan Lee");
    assert.equal(read("publisher").background,undefined);
    assert.equal(existsSync(join(root,"profile/resume.md")),false);
    assert.equal(read("pipeline").siteUrl,undefined);
    assert.equal(Object.values(read("platforms")).some((p:any)=>p.enabled),false);
    const edited={...read("pipeline"),voice:"en-GB-SoniaNeural"};
    writeFileSync(join(first.root,"config/pipeline.json"),JSON.stringify(edited));
    assert.equal(configureExecutive(root).changed,false);
    assert.equal(read("pipeline").voice,"en-GB-SoniaNeural");
    writeFileSync(join(first.root,"config/sources.json"),JSON.stringify({...read("sources"),enabledSources:['rss','web'],webSources:[{url:'https://old.example.org/event'}]}));
    writeFileSync(join(root,"profile/CONTENT.md"),brief.replace("market access","payer policy"));
    assert.equal(configureExecutive(root).changed,true);
    assert.deepEqual(read("sources").enabledSources,['rss']);assert.equal(read("sources").webSources,undefined);
    assert.equal(read("pipeline").voice,"en-GB-SoniaNeural");
    assert.deepEqual(read("sources").editorial.preferredTopics,["evidence","payer policy"]);
    assert.ok(existsSync(join(first.root,"state/onboarding-backups")));
    writeFileSync(join(root,"profile/CONTENT.md"),brief.replace("Tone:","Model: gemini\nTone:"));
    writeFileSync(join(root,".env"),'GEMINI_API_KEY="fixture-root-model-key"\nAI_CONTENT_MODEL_API_KEY="wrong-provider-key"\nAI_CONTENT_MODEL_PROVIDER="zai"\nGOOGLE_CLIENT_SECRET="must-stay-out"\n');
    configureExecutive(root);
    const envFile=join(first.root,".env");
    assert.deepEqual(parseEnv(readFileSync(envFile,"utf8")),{GEMINI_API_KEY:"fixture-root-model-key"});
    const unrelated = '# Keep this path byte-for-byte\nVIDEO_PATH="C:\\Users\\Jordan\\Videos"\n';
    writeFileSync(envFile,readFileSync(envFile,"utf8")+unrelated+'AI_CONTENT_MODEL_API_KEY="old-generic-key"\nAI_CONTENT_MODEL_PROVIDER="zai"\nAI_CONTENT_MODEL_BASE_URL="https://old-provider.example/v1"\nAI_CONTENT_MODEL_NAME="old-model"\n');
    writeFileSync(join(root,"profile/.env"),'GEMINI_API_KEY="fixture-updated-model-key"\nGOOGLE_CLIENT_SECRET="must-stay-out"\n');
    assert.equal(configureExecutive(root).changed,false);
    assert.deepEqual(parseEnv(readFileSync(envFile,"utf8")),{GEMINI_API_KEY:"fixture-updated-model-key",ZAI_API_KEY:"old-generic-key",VIDEO_PATH:"C:\\Users\\Jordan\\Videos"});
    assert.ok(readFileSync(envFile,"utf8").includes(unrelated));
    writeFileSync(envFile, readFileSync(envFile, "utf8") + 'AI_CONTENT_MODEL_API_KEY="legacy-grok-key"\nAI_CONTENT_MODEL_PROVIDER="grok"\n');
    configureExecutive(root);
    const migrated = parseEnv(readFileSync(envFile, "utf8"));
    assert.equal(migrated.XAI_API_KEY, "legacy-grok-key");
    assert.equal(migrated.GEMINI_API_KEY, "fixture-updated-model-key");
    assert.equal(migrated.AI_CONTENT_MODEL_API_KEY, undefined);

    assert.match(readFileSync(join(first.root,read("editions/daily-roundup").coverFile),"utf8"),/Healthcare Strategy Brief/);
    writeFileSync(join(root,"profile/CONTENT.md"),brief+'\nModel: ollama\nReasoning effort: none\n');
    configureExecutive(root);
    assert.equal(read("model").providers.ollama.reasoningEffort,"none");
  } finally {if(priorIdentity===undefined)delete process.env.HARNESS_IDENTITY_FILE;else process.env.HARNESS_IDENTITY_FILE=priorIdentity;rmSync(root,{recursive:true,force:true});}
});

test("unfinished briefs fail with a specific input and generated media uses the executive identity", () => {
  const withoutFeeds = brief.replace(/## Sources[\s\S]*?(?=## Avoid)/, "");
  assert.deepEqual(parseBrief(withoutFeeds).sources, []);
  assert.equal(parseBrief(withoutFeeds).publicApis, "auto");
  assert.deepEqual(parseBrief(withoutFeeds + "\nAreas: Health, Science & Math\n").areas, ["Health", "Science & Math"]);
  assert.throws(() => parseBrief(withoutFeeds + "\nPublic APIs: off\n"), /trusted RSS feed/);
  assert.equal(parseBrief(brief.replace("Name: Jordan Lee\n","")).name,"Healthcare Strategy Brief");
  assert.throws(()=>parseBrief(brief.replace("Publication: Healthcare Strategy Brief","Publication: ")),/Personalize Publication/);
  assert.throws(()=>parseBrief(brief+'\nModel: incorrect\n'),/Unknown Model/);
  assert.throws(()=>parseBrief(brief+'\nModel: claude\nReasoning effort: none\n'),/Reasoning effort/);
  assert.throws(()=>parseBrief(brief+'\nModel: ollama\nReasoning effort: invalid\n'),/Reasoning effort/);
  assert.throws(()=>parseBrief(brief+'\nModel URL: file:\/\/private\n'),/Model URL/);
  assert.throws(()=>parseBrief(brief.replace("https://news.example.org/feed","file:///private")));
  assert.throws(()=>parseBrief(brief.replace("## Topics","## Missing")),/Personalize Topics/);
  const identity={name:"Jordan <Lee>",publication:"Healthcare Strategy Brief",audience:"Healthcare leaders",tone:"Clear",background:"PRIVATE BACKGROUND"};
  const d={publisher:((({background,...rest})=>rest)(identity)),issue:{subject:"Evidence update",lead:{title:"Study design",body:"Sourced findings",sourceName:"Study",sourceUrl:"https://news.example.org/study"},items:[{name:"Decision",url:"https://news.example.org/study",line:"An implication"}],radar:[],signals:[]},issueNo:1,date:"2026-09-07",dateLong:"September 7, 2026",video:null,coveredWeek:[]};
  for(const html of [renderNewsletterHtml(d),renderLinkedInEdition(d)]){
    assert.match(html,/Healthcare Strategy Brief/);assert.match(html,/Jordan &lt;Lee&gt;/);assert.doesNotMatch(html,/example publisher|example signal|fictional beta|PRIVATE BACKGROUND|Repo radar/i);
  }
  assert.match(publisherBrief(identity),/News claims must come only from the story's captured sources/);
  assert.equal(resolveFreeVoice("edge","af_heart"),"en-US-AriaNeural");
  assert.equal(resolveFreeVoice("edge","en-GB-SoniaNeural"),"en-GB-SoniaNeural");
  assert.equal(resolveFreeVoice("kokoro","en-US-AriaNeural"),"af_heart");
});

test("starter status is read-only and failed rechecks replace a stale ready page",()=>{
  const root=mkdtempSync(join(tmpdir(),"Starter & résumé "));
  try {
    cpSync(join(CODE_ROOT,"start.mjs"),join(root,"start.mjs"));
    const run=(...args:string[])=>spawnSync(process.execPath,[join(root,"start.mjs"),...args],{encoding:"utf8",env:{...process.env,HARNESS_WORKSPACE:"default"}});
    assert.equal(JSON.parse(run("--status").stdout).onboardingNeeded,true);
    assert.equal(existsSync(join(root,"profile")),false);
    mkdirSync(join(root,"profile"));writeFileSync(join(root,"profile/getting-started.html"),"READY");
    const failed=run("--check");assert.equal(failed.status,1);
    assert.match(failed.stderr,/Add profile\/CONTENT.md/);
    assert.match(readFileSync(join(root,"profile/getting-started.html"),"utf8"),/Setup incomplete/);
    assert.equal(JSON.parse(run("--status").stdout).readiness.status,"incomplete");
  } finally {rmSync(root,{recursive:true,force:true});}
});
