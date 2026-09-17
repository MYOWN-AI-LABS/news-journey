#!/usr/bin/env node
/** Executive entry point. Node is the only manually installed project prerequisite. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const root=dirname(fileURLToPath(import.meta.url));
const args=new Set(process.argv.slice(2));
if ((!args.size || args.has('--app')) && args.size <= 1) { const result=spawnSync(process.execPath,[join(root,'app.mjs')],{stdio:'inherit'});process.exit(result.status ?? 1); }
const known=['--status','--configure-only','--check','--draft','--help','--prepare-only','--terminal'];
if([...args].some(a=>!known.includes(a))){console.error('Unknown option. Run node start.mjs --help');process.exit(1);}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const profile=join(root,'profile');
if(!existsSync(join(profile,'CONTENT.md'))&&process.stdin.isTTY&&!args.has('--prepare-only')&&!args.has('--status')&&!args.has('--help')){
  const {createInterface}=await import('node:readline/promises');
  const terminal=createInterface({input:process.stdin,output:process.stdout});
  try{
    console.log('Set up your publication.');
    const ask=async(label,valid=s=>Boolean(s))=>{for(;;){const answer=(await terminal.question(label)).trim();if(valid(answer))return answer;console.log('Please enter a valid value before continuing.');}};
    const publication=await ask('Publication name: ');
    const audience=await ask('Who should read or watch it? ');
    const topics=await ask('What should it cover? (separate topics with commas): ',s=>s.split(',').some(v=>v.trim()));
    const areas=await ask('Areas or industries (optional, separate with commas): ',()=>true);
    const validUrl=s=>{try{const u=new URL(s);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
    const sources=await ask('Trusted RSS feed URLs (optional; press Enter to discover APIs from your topics): ',s=>!s||s.split(',').every(v=>validUrl(v.trim())));
    const model=(await ask('Content model [claude], or codex / ollama / zai / grok / gemini / openai-compatible: ',s=>['','claude','codex','ollama','zai','grok','gemini','openai-compatible'].includes(s)))||'claude';
    let modelFields='';
    if(['ollama','openai-compatible'].includes(model)){
      const name=await ask('Installed model name: ');
      const url=await ask('Model endpoint'+(model==='ollama'?' [http://127.0.0.1:11434/v1]':'')+': ',s=>model==='ollama'&&!s||validUrl(s)&&!new URL(s).search&&!new URL(s).hash);
      modelFields='Model name: '+name+'\nModel URL: '+(url||'http://127.0.0.1:11434/v1')+'\n';
    }
    mkdirSync(profile,{recursive:true,mode:0o700});
    writeFileSync(join(profile,'CONTENT.md'),'# My publication\nPublication: '+publication+'\nAudience: '+audience+'\nPublic APIs: auto\nModel: '+model+'\n'+modelFields+'\n## Topics\n'+topics.split(',').map(s=>s.trim()).filter(Boolean).map(s=>'- '+s).join('\n')+'\n\n## Areas\n'+areas.split(',').map(s=>s.trim()).filter(Boolean).map(s=>'- '+s).join('\n')+'\n\n## Sources\n'+sources.split(',').map(s=>s.trim()).filter(Boolean).map(s=>'- '+s).join('\n')+'\n',{mode:0o600});
  }finally{terminal.close();}
}
const missing=[];
if(!existsSync(join(profile,'CONTENT.md')))missing.push('profile/CONTENT.md');
const workspaceId=process.env.HARNESS_WORKSPACE||'default';
if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(workspaceId))throw new Error('Invalid HARNESS_WORKSPACE');
const stateFile=join(profile,'readiness.json');
const reportFile=join(profile,'getting-started.html');
const inputHash=()=>createHash('sha256').update(readFileSync(join(profile,'CONTENT.md'))).digest('hex');
if(args.has('--status')){
  let readiness=null;try{readiness=JSON.parse(readFileSync(stateFile,'utf8'));}catch{}
  console.log(JSON.stringify({onboardingNeeded:missing.length>0||readiness?.status!=='ready'||readiness?.workspace!==workspaceId||(!missing.length&&readiness?.sourceHash!==inputHash()),missing,readiness}));
}else if(args.has('--help')){
  console.log('Run node start.mjs to open the guided browser workspace. Use --terminal for the original terminal brief setup.\nCreate your first video and newsletter draft: node start.mjs --draft\nRecheck: node start.mjs --check\nNo résumé is required or read.');
}else{
  let stage='profile';
  const checks=[];
  try{
    if([...args].some(a=>!known.includes(a)))throw new Error('Unknown option. Run node start.mjs --help');
    const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
    if(nodeMajor<22 || nodeMajor===22 && nodeMinor<13)throw new Error('Install Node.js 24 LTS from https://nodejs.org/en/download, then rerun this command');
    if(missing.length&&!args.has('--prepare-only'))throw new Error('Add '+missing.join(' and ')+'. Use examples/executive/CONTENT.md or ask your coding agent to personalize it.');
    process.chdir(root);
    const env={...process.env,PATH:join(root,'.tools/bin')+delimiter+(process.env.PATH||'')};
    const run=(command,argv,label,{capture=false,timeout=20*60*1000}={})=>{
      stage=label;console.log('\n'+label+'…');
      const r=spawnSync(command,argv,{cwd:root,env,stdio:capture?['ignore','pipe','pipe']:'inherit',encoding:'utf8',timeout,maxBuffer:8*1024*1024});
      if(r.error||r.status!==0)throw new Error(label+': '+(r.error?.message||r.stderr?.trim()||'command exited '+r.status));
      checks.push({step:label,status:'passed'});return r.stdout?.trim();
    };
    function npmPath(){
      const exeDir=dirname(process.execPath);
      const candidates=[process.env.npm_execpath,join(exeDir,'node_modules/npm/bin/npm-cli.js'),join(exeDir,'../lib/node_modules/npm/bin/npm-cli.js'),...(process.env.PATH||'').split(delimiter).flatMap(d=>[join(d,'node_modules/npm/bin/npm-cli.js'),join(d,'npm')])].filter(Boolean);
      for(const candidate of candidates){if(existsSync(candidate)){const p=realpathSync(candidate);if(p.endsWith('.js'))return p;}}
      throw new Error('npm is missing from this Node installation. Reinstall Node.js LTS and rerun node start.mjs');
    }
    const lockHash=createHash('sha256').update(readFileSync(join(root,'package-lock.json'))).digest('hex');
    const installKey=process.platform+'-'+process.arch+'-'+process.versions.node.split('.')[0]+':'+lockHash;
    const installStamp=join(root,'node_modules/.executive-install');
    if(!existsSync(installStamp)||readFileSync(installStamp,'utf8')!==installKey){run(process.execPath,[npmPath(),'ci'],'Install project dependencies');writeFileSync(installStamp,installKey);}
    const cli=(...argv)=>run(process.execPath,['--import','tsx','src/cli.ts',...argv],argv[0],{timeout:argv[0]==='produce'?60*60*1000:20*60*1000});
    const needPython=!args.has('--configure-only');
    if(needPython){
      let uv=spawnSync('uv',['--version'],{env,encoding:'utf8'});
      if(uv.error||uv.status!==0){
        stage='Install private Python tooling';console.log('\n'+stage+'…');
        const suffix=process.platform==='win32'?'ps1':'sh';
        const url='https://astral.sh/uv/0.12.10/install.'+suffix;
        const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('uv installer HTTP '+response.status);
        const installer=await response.text();if(installer.length>2e6)throw new Error('Unexpected uv installer size');
        mkdirSync(join(root,'.tools'),{recursive:true});const file=join(root,'.tools','install-uv.'+suffix);writeFileSync(file,installer);
        env.UV_UNMANAGED_INSTALL=join(root,'.tools/bin');
        run(process.platform==='win32'?'powershell.exe':'sh',process.platform==='win32'?['-NoProfile','-ExecutionPolicy','Bypass','-File',file]:[file],stage);
      }
      if(!args.has('--configure-only'))run('uv',['sync','--project','tts','--python','3.12'],'Install narration and alignment');
    }
    if(!args.has('--prepare-only'))cli('setup');
    if(!args.has('--configure-only')){
      const require=createRequire(import.meta.url);
      run(process.execPath,[join(dirname(require.resolve('playwright/package.json')),'cli.js'),'install','chromium'],'Prepare browser');
      const remotionPackage=require.resolve('@remotion/cli/package.json');
      const bin=JSON.parse(readFileSync(remotionPackage,'utf8')).bin.remotion;
      run(process.execPath,[join(dirname(remotionPackage),bin),'browser','ensure'],'Prepare video renderer');
      if(!args.has('--prepare-only')){cli('doctor');if(args.has('--check')||args.has('--terminal'))cli('model:check');}
    }
    if(args.has('--prepare-only')){console.log('Dependencies prepared. No model request was made.');process.exit(0);}
    if(args.has('--draft'))cli('produce');
    const workspace=join(root,'workspaces',workspaceId);
    if(args.has('--draft')){
      stage='Verify draft artifacts';
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const issuePath=join(workspace,'workdir/newsletters',day+'.json');
      if(!existsSync(issuePath))throw new Error('The companion newsletter is missing. Run npm run newsletter to retry, then rerun node start.mjs --draft.');
      const issue=JSON.parse(readFileSync(issuePath,'utf8'));
      if(typeof issue.sourceVideoId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(issue.sourceVideoId)||!issue.sourceVideoId.startsWith(day.replaceAll('-','')))throw new Error('The newsletter does not reference today’s draft video.');
      const dir=join(workspace,'workdir/videos',issue.sourceVideoId);
      const meta=JSON.parse(readFileSync(join(dir,'meta.json'),'utf8'));
      if(!['pending_review','approved','posted'].includes(meta.status)||!existsSync(join(dir,'final.mp4'))||!existsSync(join(workspace,'workdir/newsletters',day+'.html'))||!existsSync(join(workspace,'site/public/index.html')))throw new Error('The draft video, newsletter or local archive is incomplete.');
      checks.push({step:stage,status:'passed'});
    }
    const publisher=JSON.parse(readFileSync(join(workspace,'config/publisher.json'),'utf8'));
    const sourceConfig=JSON.parse(readFileSync(join(workspace,'config/sources.json'),'utf8'));
    const sourceSummary={rss:sourceConfig.rss?.length||0,apis:sourceConfig.enabledSources?.includes('publicApis')?sourceConfig.publicApis?.endpoints?.length||0:0};
    const ready={sources:sourceSummary,checkedAt:new Date().toISOString(),status:args.has('--configure-only')?'configured':'ready',workspace:workspaceId,sourceHash:!missing.length?inputHash():null,publication:publisher.publication,checks,next:args.has('--configure-only')?'node start.mjs --check':'node start.mjs --draft'};
    mkdirSync(profile,{recursive:true});writeFileSync(stateFile,JSON.stringify(ready,null,2)+'\n');
    const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(publisher.publication)+' · Ready</title><style>body{font:17px/1.6 system-ui;max-width:850px;margin:50px auto;padding:24px;background:#f3f5f1;color:#17362d}h1{font:42px Georgia}li{margin:12px 0}code{background:#e1eadf;padding:4px 7px}a{color:#126749}</style><h1>'+esc(publisher.publication)+'</h1><p>'+esc(ready.status==='ready'?'Your publication is ready to draft.':'Your profile is configured; runtime checks have not run.')+'</p><p>Publisher: '+esc(publisher.name)+'<br>Audience: '+esc(publisher.audience)+'</p><h2>Your sources</h2><p>'+sourceSummary.apis+' API connections · '+sourceSummary.rss+' RSS feeds</p>'+(existsSync(join(workspace,'state/sources.html'))?'<p><a href="../workspaces/'+encodeURIComponent(workspaceId)+'/state/sources.html">Explore your API sources</a></p>':'')+'<ul>'+checks.map(c=>'<li>'+esc(c.step)+' — passed</li>').join('')+'</ul><p>Next: <code>'+esc(ready.next)+'</code></p><p>Draft video and newsletter files stay in this workspace for review. Publishing accounts remain separate.</p><p><a href="../docs/personalize-and-publish.html">Complete user guide: your voice and video, channel setup, analytics and team usage</a></p><p>'+ (existsSync(join(workspace,'site/public/index.html')) ? '<a href="../workspaces/'+encodeURIComponent(workspaceId)+'/site/public/index.html">Local newsletter archive</a>' : 'Your local newsletter archive appears after the first completed draft.') + '</p></html>';
    const report=reportFile;writeFileSync(report,html);
    console.log('\n'+ready.status.toUpperCase()+': '+publisher.publication+'\n'+report+'\nNext: '+ready.next);
  }catch(error){
    console.error('\nSETUP INCOMPLETE — '+stage+'\n'+error.message);
    mkdirSync(profile,{recursive:true});
    writeFileSync(stateFile,JSON.stringify({checkedAt:new Date().toISOString(),status:'incomplete',workspace:workspaceId,stage,error:error.message,checks},null,2)+'\n');
    writeFileSync(reportFile,'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup incomplete</title><style>body{font:17px/1.6 system-ui;max-width:850px;margin:50px auto;padding:24px;color:#702c18;background:#fff6ed}</style><h1>Setup incomplete</h1><p>'+esc(stage)+'</p><pre style="white-space:pre-wrap">'+esc(error.message)+'</pre><p>Fix the reported item and rerun <code>node start.mjs</code>. Draft readiness has not been proven.</p></html>');
    process.exitCode=1;
  }
}
