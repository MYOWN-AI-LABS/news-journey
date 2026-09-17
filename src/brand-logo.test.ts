import test from 'node:test';
import assert from 'node:assert/strict';
import { brandLogoTask } from './brand-logo.js';

test('logo suggestions constrain generated geometry and keep built-in selection distinct', () => {
  const input = { suggestField: 'logo', model: 'codex', description: 'Weekly activities in Haines City, Orlando and Tampa.', logoMode: 'choose' };
  const choice = { background: '#FFFFFF', ink: '#102B3F', accent: '#007D87', symbol: 'compass', shapes: [], reason: 'A compass for exploring local places.' };
  const task = brandLogoTask(input); assert.equal(task.validate(choice), null);
  assert.ok(task.validate({ ...choice, symbol: '<svg onload=alert(1)>' }));
  assert.ok(task.validate({ ...choice, background: 'url(https://example.org/x)' }));
  assert.ok(task.validate({ ...choice, shapes: [], symbol: 'custom' }));
  const custom = brandLogoTask({ ...input, logoMode: 'create', logoDirection: 'A sunrise above a path.' });
  assert.match(custom.prompt, /sunrise above a path/);
  assert.ok(custom.validate(choice));
  const shapes = [{ kind: 'circle', x: 256, y: 256, x2: 300, y2: 300, size: 140, color: '#007D87' }, { kind: 'line', x: 150, y: 256, x2: 360, y2: 256, size: 24, color: '#FFFFFF' }];
  assert.equal(custom.validate({ ...choice, symbol: 'custom', shapes }), null);
  assert.ok(custom.validate({ ...choice, symbol: 'custom', shapes: shapes.map(s => ({ ...s, x: -99999 })) }));
});
