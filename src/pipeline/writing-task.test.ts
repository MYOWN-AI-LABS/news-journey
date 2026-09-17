import assert from 'node:assert/strict';
import test from 'node:test';
import { preparedModelTask, assertPreparedModelTask } from './writing-task.js';

const input = { role: 'source-review' as const, capability: 'source-review' as const, taskId: 'newsletter-topic-1-review', topicIds: ['topic-1'],
  protocol: { version: 4 }, evidence: ['Only simulated flights were reported.'], candidate: 'The flights were simulated.' };

test('task identity distinguishes protocols, evidence and candidates without embedding source text or routing overrides', () => {
  const task = preparedModelTask(input);
  assert.doesNotThrow(() => assertPreparedModelTask(task));
  assert.equal(JSON.stringify(task).includes('simulated'), false);
  assert.deepEqual(task, preparedModelTask(input));
  assert.notEqual(task.protocolHash, preparedModelTask({ ...input, protocol: { version: 5 } }).protocolHash);
  assert.notEqual(task.evidenceHash, preparedModelTask({ ...input, evidence: ['Physical trials were also reported.'] }).evidenceHash);
  assert.notEqual(task.candidateHash, preparedModelTask({ ...input, candidate: 'Physical flights succeeded.' }).candidateHash);
  input.topicIds.push('topic-2');
  assert.deepEqual(task.topicIds, ['topic-1'], 'the descriptor owns its topic scope');
  input.topicIds.pop();
});

test('prepared work cannot guess missing roles, mismatch capabilities, or introduce provider overrides', () => {
  const task = preparedModelTask(input);
  for (const value of [undefined, {}, { ...task, role: 'script' }, { ...task, capability: 'unknown' }, { ...task, topicIds: [] },
    { ...task, topicIds: ['topic-1', 'topic-1'] }, { ...task, evidenceHash: 'not-a-hash' }, { ...task, provider: 'hosted-fallback' }]) {
    assert.throws(() => assertPreparedModelTask(value), /Prepared/);
  }
});
