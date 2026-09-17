import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { reconcileTruncatedReviewCitation } from './reviewer-citation-reconciliation.js';
import { prepareScriptFieldRepair, applyScriptFieldRepair } from './script-field-repair.js';
import type { DailyEditorialInput, DailyEditorialReview, DailyScriptFormat } from './daily-editorial.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const sentence='The tournament organizer confirmed that the published schedule remains a provisional plan subject to inspection before any matches may take place.';
const prefix='The tournament organizer confirmed that the published schedule remains a provisional plan.';
const candidate={hook:'Organizer announces provisional schedule.',body:[{onScreen:{title:'Provisional schedule'}}],editorialCopy:[{storyId:'topic-1',text:'The tournament schedule has been approved. Other unchanged copy remains here.'}]};
const source={id:'topic-1-source-1',url:'https://example.org/news',publishedAt:null,capturedAt:'2026-09-15T00:00:00Z',text:sentence,textSha256:sha(sentence),rawSha256:sha(sentence)};
const input:DailyEditorialInput={day:'2026-09-15',brief:'Test source.',stories:[{id:'topic-1',headline:'Schedule',primaryUrl:source.url,sources:[source]}]};
const review:DailyEditorialReview={verdict:'changes-required',reviewedStoryIds:['topic-1'],findings:[{storyId:'topic-1',kind:'missing-condition',candidateExcerpt:'The tournament schedule has been approved.',reason:'Inspection remains a condition.',evidence:[{sourceId:source.id,quote:prefix}]}]};
const format={validate:()=>null} as unknown as DailyScriptFormat;

test('citation repair restores the complete unique source sentence and preserves the rejection and every finding field',()=>{
 const result=reconcileTruncatedReviewCitation(input,review);
 assert.equal(result.review.verdict,'changes-required');assert.equal(result.corrections.length,1);
 assert.equal(result.review.findings[0]!.evidence[0]!.quote,sentence);
 const expected=structuredClone(review);expected.findings[0]!.evidence[0]!.quote=sentence;assert.deepEqual(result.review,expected);
 assert.equal(review.findings[0]!.evidence[0]!.quote,prefix,'Raw model response remains unchanged');
});

test('citation repair refuses paraphrase, cross-source ownership, duplicate matches and supported verdicts',()=>{
 for(const mode of ['paraphrase','owner','duplicate','supported']as const){
  const altered=structuredClone(review),sources=structuredClone(input);
  if(mode==='paraphrase')altered.findings[0]!.evidence[0]!.quote=prefix.replace('confirmed','denied');
  if(mode==='owner')altered.findings[0]!.evidence[0]!.sourceId='another-story';
  if(mode==='duplicate')sources.stories[0]!.sources[0]!.text=`${sentence}\n${sentence}`;
  if(mode==='supported')altered.verdict='supported';
  assert.throws(()=>reconcileTruncatedReviewCitation(sources,altered));
 }
});

test('constrained original repair changes only reviewed owned fields and keeps all other candidate data',()=>{
 const corrected=reconcileTruncatedReviewCitation(input,review).review;
 const plan=prepareScriptFieldRepair(input,candidate,corrected,format)!;assert.ok(plan);
 const changed=applyScriptFieldRepair(candidate,plan,{replacements:[{id:'field_1',text:'The tournament schedule remains subject to inspection.'}]},format);
 assert.deepEqual(changed,{...candidate,editorialCopy:[{storyId:'topic-1',text:'The tournament schedule remains subject to inspection. Other unchanged copy remains here.'}]});
 assert.deepEqual(changed.body,candidate.body);assert.equal(changed.hook,candidate.hook);
 assert.throws(()=>applyScriptFieldRepair(candidate,plan,{replacements:[{id:'field_2',text:'An unauthorized replacement.'}]},format),/owned field/);
});

test('field repair refuses ambiguous or cross-story target mapping and preserves full format word checks',()=>{
 const corrected=reconcileTruncatedReviewCitation(input,review).review;
 const duplicate=structuredClone(candidate);duplicate.editorialCopy[0]!.text+=' The tournament schedule has been approved.';
 assert.equal(prepareScriptFieldRepair(input,duplicate,corrected,format),null);
 const plan=prepareScriptFieldRepair(input,candidate,corrected,format)!;
 assert.throws(()=>applyScriptFieldRepair(candidate,plan,{replacements:[{id:'field_1',text:'A changed sentence.'}]},{...format,validate:()=> 'Original word limit failed'}),/Original word limit/);
});
