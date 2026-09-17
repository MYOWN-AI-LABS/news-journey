import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { matchTopicApis, setupApiSources, connectApi, jsonCollections, recordFields } from './api-setup.js';
import { fetchPublicApiSample, isPrivateHostname, type PublicApiCatalogEntry, type PublicApiEndpointConfig } from './public-apis.js';
const entry = (name: string, category: string, description = '', auth = 'No'): PublicApiCatalogEntry => ({ name, category, description, auth, https:'Yes',cors:'Unknown',documentationUrl:'https://docs.example.org/'+name.replace(/\W/g,'') });
const catalog = [entry('Crossref Metadata Search','Books'),entry('Europe PMC','Science & Math'),entry('Dev.to','Social'),entry('Spaceflight News','News'),entry('Launch Library 2','Science & Math'),entry('Example health data','Health','Clinical evidence'),entry('Example Finance','Finance','Markets','apiKey'),entry('Retail dataset','Business','retail sales')];
const api: PublicApiEndpointConfig = {id:'example-news',name:'Example News',url:'https://api.example.org/articles',itemPath:'results',fields:{title:'title',url:'url'}};
const sample = async () => new Response(JSON.stringify({results:[{title:'Example story',url:'https://news.example.org/story'}]}));
function fixture(cfg: any) { const root=mkdtempSync(join(tmpdir(),'API setup ')); mkdirSync(join(root,'config'));writeFileSync(join(root,'config/sources.json'),JSON.stringify(cfg)); return root; }
const read = (root: string) => JSON.parse(readFileSync(join(root,'config/sources.json'),'utf8'));

test('topics and areas search the full catalog, distinguish credentials, and avoid substring matches',()=>{
 const health=matchTopicApis(catalog,['clinical research'],['Health']);
 assert.deepEqual(new Set(health.filter(c=>c.automatic).map(c=>c.id)),new Set(['crossref','europe-pmc']));
 assert.ok(health.some(c=>c.name==='Example health data' && c.connection==='needs-setup'));
 const ai=matchTopicApis(catalog,['ai']); assert.ok(ai.some(c=>c.id==='dev-to' && c.connection==='ready'));
 assert.ok(!ai.some(c=>c.name==='Retail dataset'));
 assert.equal(matchTopicApis(catalog,['finance']).find(c=>c.name==='Example Finance')?.connection,'needs-key');
 assert.deepEqual(matchTopicApis(catalog,['unmatched-subject']),[]);
 assert.equal(matchTopicApis(catalog,['spaceflight']).filter(c=>c.automatic).length,2);
});

test('sports news does not match unrelated news or medical entries in a broad sports category', () => {
 const entries = [
  entry('API-FOOTBALL', 'Sports & Fitness', 'Football leagues and cups', 'apiKey'),
  entry('NBA Stats', 'Sports & Fitness', 'Current and historical NBA statistics'),
  entry('ApiMedic', 'Sports & Fitness', 'Medical symptom checker for patients', 'apiKey'),
  entry('AnimeNewsNetwork', 'Anime', 'Anime industry news'),
  entry('Spaceflight News', 'News', 'Spaceflight related news'),
 ];
 assert.deepEqual(matchTopicApis(entries, ['Sports news']).map(c => c.name), ['API-FOOTBALL', 'NBA Stats']);
 assert.deepEqual(matchTopicApis(entries, ['Anime news']).map(c => c.name), ['AnimeNewsNetwork']);
 assert.ok(matchTopicApis(entries, ['spaceflight news']).some(c => c.name === 'Spaceflight News'));
 assert.ok(matchTopicApis(entries, ['news']).some(c => c.name === 'AnimeNewsNetwork'), 'generic news remains a valid standalone topic');
});

test('connection verifies real mapping before saving and preserves implicit default sources and custom edits',async()=>{
 const root=fixture({editorial:{preferredTopics:['news']}});
 try {
  assert.equal(await connectApi(root,api,sample),1);
  assert.deepEqual(read(root).enabledSources,['hn','githubTrending','rss','publicApis']);
  assert.equal(read(root).publicApis.endpoints.length,1);
  await connectApi(root,api,sample);assert.equal(read(root).publicApis.endpoints.length,1);
  const before=readFileSync(join(root,'config/sources.json'),'utf8');
  await assert.rejects(connectApi(root,{...api,url:'https://api.example.org/changed'},sample),/preserved/);
  await assert.rejects(connectApi(root,{...api,id:'failed-api'},async()=>new Response('unavailable',{status:503})),/503/);
  assert.equal(readFileSync(join(root,'config/sources.json'),'utf8'),before);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('automatic setup connects matching APIs, uses saved preferences, and does not claim deleted connections',async()=>{
 const root=fixture({enabledSources:['rss'],rss:[{url:'https://news.example.org/rss'}],editorial:{preferredTopics:['healthcare'],areas:{focusAreas:['Health']}}});
 let calls=0;
 const request = async (url: string) => {calls++;return new Response(JSON.stringify(url.includes('crossref')?{message:{items:[{title:['Study'],URL:'https://doi.org/10.1234/example'}]}}:{resultList:{result:[{title:'Study',fullTextUrlList:{fullTextUrl:[{url:'https://journal.example.org/study'}]}}]}}));};
 try{
  const report=await setupApiSources(root,{automatic:true,entries:catalog,request});
  assert.equal(report.results.filter(r=>r.status==='connected').length,2);assert.equal(calls,2);
  assert.deepEqual(read(root).enabledSources,['rss','publicApis']);
  assert.ok(read(root).publicApis.managedEndpoints.crossref);
  await setupApiSources(root,{automatic:true,entries:catalog,request});assert.equal(calls,2);
  const cfg=read(root);cfg.publicApis.endpoints=[];cfg.enabledSources=['rss'];writeFileSync(join(root,'config/sources.json'),JSON.stringify(cfg));
  const cached=await setupApiSources(root,{automatic:true,entries:catalog,request});
  assert.equal(cached.results.length,0);assert.equal(calls,2);assert.match(readFileSync(join(root,'state/sources.html'),'utf8'),/0 connections passed/);
  await setupApiSources(root,{automatic:true,refresh:true,entries:catalog,request});assert.equal(calls,4);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('managed queries follow changed topics while manually edited mappings survive refresh',async()=>{
 const root=fixture({enabledSources:[],editorial:{preferredTopics:['clinical research']}});
 const request=async()=>new Response(JSON.stringify({message:{items:[{title:['Study'],URL:'https://doi.org/10.1234/example'}]}}));
 try{
  const entries=[catalog[0]];
  await setupApiSources(root,{automatic:true,entries,request});
  const cfg=read(root);cfg.editorial.preferredTopics=['robotics research'];writeFileSync(join(root,'config/sources.json'),JSON.stringify(cfg));
  await setupApiSources(root,{automatic:true,entries,request});
  assert.match(read(root).publicApis.endpoints[0].url,/robotics%20research/);
  const edited=read(root);edited.publicApis.endpoints[0].maxItems=3;writeFileSync(join(root,'config/sources.json'),JSON.stringify(edited));
  await setupApiSources(root,{automatic:true,refresh:true,entries,request});
  assert.equal(read(root).publicApis.endpoints[0].maxItems,3);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('private workspace boundaries and credential failures prevent configuration mutation',async()=>{
 const root=fixture({enabledSources:['rss']});const outside=fixture({keep:true});
 try{
  rmSync(join(root,'config'),{recursive:true});symlinkSync(join(outside,'config'),join(root,'config'),'junction');
  await assert.rejects(connectApi(root,api,sample),/Symlink leaves workspace/);assert.equal(read(outside).keep,true);
  rmSync(join(root,'config'));mkdirSync(join(root,'config'));writeFileSync(join(root,'config/sources.json'),'{"enabledSources":["rss"]}');
  mkdirSync(join(root,'.env'));
  await assert.rejects(connectApi(root,api,sample,{name:'PUBLIC_API_EXAMPLE_KEY',value:'fixture-token'}));
  assert.deepEqual(read(root).enabledSources,['rss']);
  rmSync(join(root,'.env'),{recursive:true});writeFileSync(join(root,'.env'),'EXISTING="keep"\n');
  await connectApi(root,api,sample,{name:'PUBLIC_API_EXAMPLE_KEY',value:'fixture-token'});
  assert.deepEqual(parseEnv(readFileSync(join(root,'.env'),'utf8')),{EXISTING:'keep',PUBLIC_API_EXAMPLE_KEY:'fixture-token'});
  if(process.platform!=='win32')assert.equal(statSync(join(root,'.env')).mode&0o777,0o600);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('generic JSON discovery exposes fields without stringifying private nested objects',()=>{
 const data={meta:{total:1},data:{articles:[{headline:'Story',links:{original:'https://news.example.org/story'},summary:'Text'}]}};
 const lists=jsonCollections(data);assert.equal(lists[0].path,'data.articles');
 const fields=recordFields(lists[0].records[0]);assert.deepEqual(fields.map(f=>f.path),['headline','links.original','summary']);
 assert.ok(!fields.some(f=>f.sample.includes('[object Object]')));
});

test('public API guard handles public host prefixes, rejects private variants, and sends a User-Agent',async()=>{
 assert.equal(isPrivateHostname('fda.gov'),false);assert.equal(isPrivateHostname('fcnews.org'),false);
 for(const host of ['localhost.','intranet','::1','::ffff:7f00:1','fd12::1','10.0.0.1','169.254.169.254','192.0.0.8','192.0.2.1','192.168.1.1','198.51.100.7','203.0.113.9'])assert.equal(isPrivateHostname(host),true,host);
 for(const host of ['192.0.78.187','192.0.78.243'])assert.equal(isPrivateHostname(host),false,host+' (WordPress.com) is public');
 await fetchPublicApiSample(api,async(_url,init)=>{assert.equal(init?.redirect,'error');assert.match((init?.headers as Record<string,string>)['User-Agent'],/Content-Harness/);return sample();});
 await assert.rejects(fetchPublicApiSample({...api,url:'https://127.0.0.1/data'},sample),/private or local/);
});

test('discovery-only cache does not skip automatic connections and area-only queries are usable',async()=>{
 const root=fixture({enabledSources:[],editorial:{preferredTopics:[],areas:{focusAreas:['Health']}}});
 let calls=0;
 const request=async(url:string)=>{calls++;assert.ok(new URL(url).searchParams.get('query'));return new Response(JSON.stringify({resultList:{result:[{title:'Study',fullTextUrlList:{fullTextUrl:[{url:'https://journal.example.org/study'}]}}]}}));};
 try{
  await setupApiSources(root,{select:[],entries:[catalog[1]],request});assert.equal(calls,0);
  await setupApiSources(root,{automatic:true,entries:[catalog[1]],request});assert.equal(calls,1);
  const cfg=read(root);cfg.enabledSources=[];writeFileSync(join(root,'config/sources.json'),JSON.stringify(cfg));
  await setupApiSources(root,{automatic:true,refresh:true,entries:[catalog[1]],request});assert.equal(calls,2);assert.deepEqual(read(root).enabledSources,['publicApis']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
