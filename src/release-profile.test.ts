import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProDistribution, assertPublicDelivery, releaseProfile } from './release-profile.js';
import { proState, verifyLicense } from './pro.js';

test('a Free distribution refuses copied Pro activation and private publication regardless of workspace settings', () => {
  const code = mkdtempSync(join(tmpdir(), 'free-release-'));
  mkdirSync(join(code, 'config'));
  assert.equal(releaseProfile(code).edition, 'development');
  writeFileSync(join(code, 'config/distribution.json'), JSON.stringify({ edition: 'free', evaluation: true }));
  const workspace = join(code, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ id: 'example' }));
  assert.throws(() => assertProDistribution('Assistant', code), /planned Pro/);
  assert.throws(() => assertPublicDelivery(code), /Private evaluation/);
  assert.match(verifyLicense({ copied: true }, 'example', code).reason!, /cannot be activated/);
  const state = proState(workspace, code);
  assert.equal(state.active, false); assert.equal(state.checkoutUrl, ''); assert.equal(state.portalUrl, '');
  assert.equal(state.price, '$99/month · planned');
  writeFileSync(join(code, 'config/distribution.json'), JSON.stringify({ edition: 'free', evaluation: false }));
  assert.doesNotThrow(() => assertPublicDelivery(code));
  assert.throws(() => assertProDistribution('Assistant', code), /planned Pro/);
  writeFileSync(join(code, 'config/distribution.json'), '{');
  assert.throws(() => assertPublicDelivery(code), SyntaxError);
});
