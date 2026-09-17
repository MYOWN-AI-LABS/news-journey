import assert from 'node:assert/strict';
import test from 'node:test';
import { authorStoryDiagram, diagramConceptProblem, diagramValidationProblem, storyDiagramPrompt, type AuthoredDiagram } from './story-diagram.js';
import type { SourceVisualConcept } from './visual-development.js';
import { createSourceSupportContext } from './source-support.js';
import type { PreparedModelTask } from './writing-task.js';

const concept = { reasonClaimIds: [1], version: 1, status: 'source-reviewed', narrationAlignment: 'pending', kind: 'diagram',
  intent: 'Proposed route', reason: 'Shows the documented proposed route.', labels: ['City', 'Pilot'], caveat: 'Proposed',
  topicId: 'topic-1', sourceUrl: 'https://example.org/pilot', sourceHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), contentHash: 'c'.repeat(64), review: { fields: [] },
} satisfies SourceVisualConcept;
const story = { title: 'Proposed route', kind: 'flow' as const, who: 'City', what: 'Pilot', how: 'Proposed bus route', impact: 'Proposed service', status: 'Proposed', sourceConcept: concept };
const evidence = { claims: ['The city proposed a transit pilot.'], sourceContext: createSourceSupportContext('2026-09-14', concept.sourceUrl, []), writerKey: 'test', presentation: { story, concept } };
const diagram: AuthoredDiagram = {
  svg: '<svg class="tm-story-svg tm-svg-authored tm-svg-portrait" data-visual-primitive="authored-1" viewBox="0 0 720 1000" role="img" aria-labelledby="tm-visual-1"><title id="tm-visual-1">A proposed route</title><g data-step="1"><rect class="tm-sc-node" x="40" y="120" width="400" height="200"/><circle class="tm-sc-core-dot" cx="480" cy="180" r="10"/><line class="tm-native-route" x1="450" y1="180" x2="470" y2="180"/><text class="tm-svg-label" x="60" y="230">CITY</text></g><g data-step="2"><rect class="tm-sc-node" x="40" y="550" width="400" height="200"/><circle class="tm-sc-core-dot" cx="480" cy="600" r="10"/><path class="tm-native-trace" d="M240 330 L240 530"/><text class="tm-svg-label" x="60" y="660">PILOT</text></g></svg>',
  label: 'PROPOSED ROUTE', reading: 'Read the proposed route from city to pilot.', legend: [{ kind: 'source', label: 'city' }, { kind: 'route', label: 'proposal' }],
};

test('actual diagram author receives and preserves the independently reviewed concept', async () => {
  assert.equal(diagramValidationProblem(diagram, 1), null);
  assert.match(storyDiagramPrompt(story, 1), /exactly 2 data-step groups/);
  const out = await authorStoryDiagram(story, 1, async <T>(prompt: string, validate: (value: T) => string | null, task?: PreparedModelTask) => {
    assert.ok(prompt.includes(concept.contentHash));
    assert.ok(!prompt.includes(concept.inputHash), 'review provenance stays in the validated concept identity, not the writing prompt');
    assert.ok(!prompt.includes('"review":'), 'review verdicts must not inflate the prompt or become authored facts');
    assert.ok(task?.candidateHash && task?.evidenceHash);
    assert.equal(validate(diagram as T), null);
    return diagram as T;
  }, evidence);
  assert.equal(diagramConceptProblem(out.svg, concept), null);
  assert.equal(out.sourceReview, undefined, 'authoring cannot mint a source review');
  assert.equal(out.review, undefined, 'authoring cannot mint a phone review');
});

test('a structurally valid substitute storyboard cannot pass the author or cached concept gate', async () => {
  const changed = { ...diagram, svg: diagram.svg.replace('>PILOT<', '>RESULT<') };
  assert.equal(diagramValidationProblem(changed, 1), null, 'this failure is concept continuity, not malformed SVG');
  await assert.rejects(authorStoryDiagram(story, 1, async <T>() => changed as T, evidence), /changed its independently developed concept label/);
  assert.match(diagramConceptProblem(diagram.svg, { ...concept, labels: ['Pilot', 'City'] })!, /changed/);
  assert.match(diagramConceptProblem(diagram.svg, { ...concept, labels: ['City', 'Pilot', 'Outcome'] })!, /every independently/);
});
