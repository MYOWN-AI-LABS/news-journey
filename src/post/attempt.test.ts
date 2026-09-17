import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginAttempt, pendingAttempt, scopedAttemptKey } from './attempt.js';

test('maximum-length edition names get durable distinct attempts without relaxing path validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'newsletter-long-attempt-'));
  try {
    const name = `2026-09-14-${'x'.repeat(160)}`;
    const key = scopedAttemptKey('newsletter', name);
    assert.ok(key.length < 160);
    assert.equal(key, scopedAttemptKey('newsletter', name));
    assert.notEqual(key, scopedAttemptKey('newsletter', name.slice(0, -1) + 'y'));
    assert.notEqual(key, scopedAttemptKey('video', name));
    beginAttempt(dir, key);
    assert.equal(pendingAttempt(dir, key), true);
    assert.throws(() => beginAttempt(dir, key), /Unresolved delivery attempt/);
    assert.throws(() => beginAttempt(dir, '../invalid'), /Invalid identifier/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
