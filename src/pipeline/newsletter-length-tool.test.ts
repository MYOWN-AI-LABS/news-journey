import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNewsletterLengthPlan, applyNewsletterLengthChoice, newsletterLengthChoiceValidator } from './newsletter-length-tool.js';

const stories = ['Harbor', 'River', 'Forest'];
const candidate = { sections: stories.map(name => ({ storyId: name.toLowerCase(), text:
  `The ${name} council published a planned inspection of the local bridge pending a safety review. ` +
  'The bridge has not reopened; any reopening depends on the completed safety review. ' +
  'Residents may obtain the printed information leaflet from the public desk at the library during its normal opening hours.' })) };
const plan = prepareNewsletterLengthPlan(candidate, { min: 90, max: 110 });
const choice = { sections: plan.sections.map(row => ({ storyId: row.storyId, requiredIds: [1,2], rankedIds: [1,2,3] })) };

test('whole-unit length selection preserves required conditions and exact candidate ownership', () => {
  const result = applyNewsletterLengthChoice(plan, choice);
  assert.ok(result.receipt.finalWords >= 90 && result.receipt.finalWords <= 110);
  assert.equal(result.receipt.status, 'pending-full-source-review');
  for (const [i, row] of result.draft.sections.entries()) {
    assert.equal(row.storyId, candidate.sections[i]!.storyId);
    assert.ok(row.text.includes('planned inspection'));
    assert.ok(row.text.includes('has not reopened; any reopening depends on the completed safety review.'));
    assert.equal(row.text, result.receipt.sections[i]!.selectedIds.map(id => plan.sections[i]!.units.find(unit => unit.id === id)!.text).join(' '));
  }
  assert.deepEqual(applyNewsletterLengthChoice(plan, choice), result, 'The same semantic selection has deterministic counts and bytes');
});

test('unowned, duplicate, missing and prose-injecting selection outputs are invalid', () => {
  const validate = newsletterLengthChoiceValidator(plan);
  assert.equal(validate(choice), null);
  assert.ok(validate({ sections: choice.sections.slice(1) }));
  for (const changed of [
    { ...choice.sections[0]!, rankedIds: [1,1,2] },
    { ...choice.sections[0]!, requiredIds: [999] },
    { ...choice.sections[0]!, rankedIds: [1,2] },
    { ...choice.sections[0]!, text: 'The bridge reopened.' },
  ]) assert.ok(validate({ sections: [changed, ...choice.sections.slice(1)] }));
  assert.ok(validate({ sections: [...choice.sections].reverse() }));
});

test('required conditions exceeding the range cannot be silently dropped', () => {
  assert.throws(() => applyNewsletterLengthChoice(plan, { sections: choice.sections.map(row => ({ ...row, requiredIds: [1,2,3] })) }), /Required complete units.*above 110/);
});

test('quote blocks retain the named speaker and backward references without partial selection', () => {
  const quoted = 'Mira said the bridge remained closed. “Inspectors have not approved it. This is a temporary restriction,” she said. They will return after the water recedes.';
  const p = prepareNewsletterLengthPlan({ sections: [{ storyId: 'bridge', text: quoted + ' Residents can read the transport notice at the station.' }] }, { min: 5, max: 15 });
  assert.equal(p.sections[0]!.units[0]!.text, quoted);
  assert.throws(() => applyNewsletterLengthChoice(p, { sections: [{ storyId: 'bridge', requiredIds: [1], rankedIds: [1,2] }] }), /Required complete units/);
  assert.throws(() => prepareNewsletterLengthPlan({ sections: [{ storyId: 'bridge', text: 'Officials said “The bridge has not reopened. Travellers must wait.' }] }, { min: 1, max: 5 }), /quotation/);
});
