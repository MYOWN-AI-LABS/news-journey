import test from 'node:test';
import assert from 'node:assert/strict';
import {rankCandidates,validateRankingConfig,rankingFromInput,assembleSlate} from './user-ranking.js';
import type {HarvestItem} from '../types.js';
const item=(id:string,title:string,date:string|null,score=0):HarvestItem=>({id,source:'rss:example',title,url:`https://example.org/${id}`,summary:'',publishedAt:date,score,repo:null});
const items=[item('a','Energy update','2026-01-01T00:00:00Z',999999),item('b','Education update','2026-02-01T00:00:00Z',1),item('c','Other update',null,900000)];
test('manual ignores inherited popularity and date, requiring an explicit user choice downstream',()=>{
 assert.equal(validateRankingConfig(undefined).mode,'manual');assert.deepEqual(rankCandidates(items).map(i=>i.id),['a','b','c']);assert.ok(rankCandidates(items).every(i=>i.score===0));
});
test('newest orders known publication dates without source popularity',()=>assert.deepEqual(rankCandidates(items,{mode:'newest'}).map(i=>i.id),['b','a','c']));
test('only user-provided priority and source weights contribute',()=>{
 const cfg=rankingFromInput({rankingMode:'priorities',rankingPriorities:'Education | 3\nEnergy | 1'});
 assert.deepEqual(rankCandidates(items,cfg).map(i=>i.id),['b','a','c']);assert.equal(rankCandidates(items,cfg)[0].score,3);
 assert.equal(rankCandidates(items,{mode:'priorities',sourceWeights:{'rss:example':4}})[0].score,4);
});
test('invalid, empty or nonfinite priorities fail before a source/model call',()=>{
 for(const value of [{mode:'unknown'},{mode:'priorities'},{mode:'priorities',priorities:[{keyword:'x',weight:NaN}]}])assert.throws(()=>validateRankingConfig(value));
 assert.throws(()=>rankingFromInput({rankingMode:'priorities',rankingPriorities:'energy'}),/keyword \| weight/);
 assert.throws(()=>rankingFromInput({rankingMode:'priorities',rankingPriorities:'energy | -1'}));
});
test('backfill retains separate events involving the same entity and enforces story count',()=>{
 const a={principalEntity:'Same club',primaryUrl:'https://example.org/a'},b={principalEntity:'Same club',primaryUrl:'https://example.org/b'};
 assert.deepEqual(assembleSlate([a],[b],2,2,3).slate,[a,b]);assert.throws(()=>assembleSlate([a],[a],2,2,3),/Only 1 stories/);
});
