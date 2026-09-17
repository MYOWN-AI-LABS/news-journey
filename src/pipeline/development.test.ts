import assert from 'node:assert/strict';
import test from 'node:test';
import { runIndependentDevelopment } from './development.js';

test('all independent outputs start and successes persist while another branch fails', async () => {
  const started: string[] = [], saved: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const work = runIndependentDevelopment({
    script: async () => { started.push('script'); await pending; throw new Error('Script fact review failed'); },
    visuals: async () => { started.push('visuals'); },
    newsletter: async () => { started.push('newsletter'); },
  }, (name, outcome) => saved.push(`${name}:${outcome.status}`));
  assert.deepEqual(started, ['script', 'visuals', 'newsletter']);
  await Promise.resolve();
  assert.deepEqual(saved, ['visuals:complete', 'newsletter:complete']);
  release();
  const result = await work;
  assert.equal(result.script.status, 'failed');
  assert.match(result.script.error!, /Script fact review failed/);
  assert.equal(result.visuals.status, 'complete');
  assert.equal(result.newsletter.status, 'complete');
});

test('synchronous branch failure and a status-write failure cannot abandon pending siblings', async () => {
  let completed = false;
  const result = await runIndependentDevelopment({
    script: () => { throw new Error('Bad cached script'); },
    visuals: async () => { await Promise.resolve(); completed = true; },
  }, name => { if (name === 'script') throw new Error('Disk full'); });
  assert.equal(completed, true);
  assert.equal(result.visuals.status, 'complete');
  assert.match(result.script.error!, /Bad cached script; Development status could not be saved: Disk full/);
});
