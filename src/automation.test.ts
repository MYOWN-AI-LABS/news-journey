import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { approvedEditionCount, automatedRelease, automationState, readAutomationSettings, saveAutomationSettings, storyChoiceRequired, visualChoiceRequired } from './automation.js';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'automation-'));
  mkdirSync(join(root, 'config'), { recursive: true }); mkdirSync(join(root, 'state'), { recursive: true }); mkdirSync(join(root, 'workdir/videos'), { recursive: true });
  return root;
}
function pkg(root: string, id: string, meta: Record<string, unknown>, receipts: Record<string, unknown> = {}) {
  const dir = join(root, 'workdir/videos', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, status: 'pending_review', edition: 'daily-roundup', createdAt: '2026-09-17T00:00:00.000Z', ...meta }));
  for (const [name, value] of Object.entries(receipts)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

test('automation settings default to review, validate strictly, and a garbled file never switches automation on', () => {
  const root = workspace();
  try {
    assert.deepEqual(readAutomationSettings(root), { mode: 'review', autoApproveAfter: 3 });
    assert.deepEqual(saveAutomationSettings(root, { mode: 'auto', autoApproveAfter: 0 }), { mode: 'auto', autoApproveAfter: 0 });
    assert.equal(readAutomationSettings(root).mode, 'auto');
    for (const bad of [{ mode: 'yes', autoApproveAfter: 3 }, { mode: 'auto', autoApproveAfter: 1.5 }, { mode: 'auto', autoApproveAfter: 101 }, { mode: 'auto', autoApproveAfter: 3, extra: true }, null])
      assert.throws(() => saveAutomationSettings(root, bad));
    writeFileSync(join(root, 'config/automation.json'), '{"mode":"auto"'); // garbled
    assert.equal(readAutomationSettings(root).mode, 'review');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the story and visual choice gates open only in automated mode (or Pro recommendationsAuto for visuals)', () => {
  const root = workspace();
  try {
    const env = { HARNESS_STORY_CHOICE: 'require', HARNESS_VISUAL_CHOICE: 'require' } as NodeJS.ProcessEnv;
    assert.equal(storyChoiceRequired(root, 'auto', env), true); assert.equal(storyChoiceRequired(root, 'manual', {} as NodeJS.ProcessEnv), true);
    assert.equal(storyChoiceRequired(root, 'auto', {} as NodeJS.ProcessEnv), false);
    assert.equal(visualChoiceRequired(root, env), true);
    saveAutomationSettings(root, { mode: 'auto', autoApproveAfter: 3 });
    assert.equal(storyChoiceRequired(root, 'manual', env), false); assert.equal(visualChoiceRequired(root, env), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approved editions are counted from approvedBy or a released status', () => {
  const root = workspace();
  try {
    pkg(root, 'a', { status: 'pending_review' }); pkg(root, 'b', { status: 'approved' }); pkg(root, 'c', { status: 'posted' }); pkg(root, 'd', { status: 'pending_review', approvedBy: 'owner' });
    assert.equal(approvedEditionCount(root), 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const green = { 'script-qc.json': { version: 1, ok: true, attempts: [] }, 'audio-qc.json': { status: 'pass' } };
const okDeps = () => {
  const calls: string[] = [];
  return { calls, deps: {
    approve: (id: string) => { calls.push('approve:' + id); },
    publishNewsletter: async (date: string) => { calls.push('newsletter:' + date); return 'https://linkedin.example/issue'; },
    postApproved: async ({ id }: { id: string }) => { calls.push('post:' + id); },
    linkVideoIntoNewsletter: async () => { calls.push('link'); return 'linked'; },
    releaseProblem: () => null, uncleared: () => [] as number[],
  } };
};

test('automated release holds with the reason when receipts are not green, when rights are uncleared, or before the threshold', async () => {
  const root = workspace();
  try {
    saveAutomationSettings(root, { mode: 'auto', autoApproveAfter: 1 });
    pkg(root, '20260917-a', {}, { ...green, 'audio-qc.json': { status: 'hold' } });
    const { calls, deps } = okDeps();
    let r = await automatedRelease(root, '20260917-a', deps);
    assert.equal(r.outcome, 'held'); assert.match(r.reason!, /transcript check did not pass/); assert.deepEqual(calls, []);
    pkg(root, '20260917-b', {}, green);
    r = await automatedRelease(root, '20260917-b', { ...deps, uncleared: () => [0] });
    assert.equal(r.outcome, 'held'); assert.match(r.reason!, /rights are not established/); assert.deepEqual(calls, []);
    r = await automatedRelease(root, '20260917-b', deps); // 0 approved so far, threshold 1
    assert.equal(r.outcome, 'held'); assert.match(r.reason!, /starts after 1 approved edition/); assert.deepEqual(calls, []);
    assert.ok(existsSync(join(root, 'state/automation-releases/20260917-b.json')));
    assert.equal(automationState(root).lastRelease?.id, '20260917-b');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automated release approves and publishes in the Journey order once the threshold is met, and records a refused approval', async () => {
  const root = workspace();
  try {
    saveAutomationSettings(root, { mode: 'auto', autoApproveAfter: 1 });
    pkg(root, '20260916-old', { status: 'posted' });
    const dir = pkg(root, '20260917-new', {}, green);
    const { calls, deps } = okDeps();
    const posting = { ...deps, postApproved: async ({ id }: { id: string }) => { calls.push('post:' + id); const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); meta.posts = { linkedin: { url: 'https://linkedin.example/video' } }; writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta)); } };
    const r = await automatedRelease(root, '20260917-new', posting);
    assert.equal(r.outcome, 'published');
    assert.deepEqual(calls, ['approve:20260917-new', 'newsletter:2026-09-17', 'post:20260917-new', 'link']);
    assert.deepEqual(r.steps.map(s => s.step + ':' + s.status), ['receipts:done', 'threshold:done', 'approve:done', 'newsletter:done', 'post:done', 'link:done']);
    const refused = await automatedRelease(root, '20260917-new', { ...deps, approve: () => { throw new Error('Independent reviewer required; author cannot approve this package'); } });
    assert.equal(refused.outcome, 'held'); assert.match(refused.reason!, /Independent reviewer required/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
