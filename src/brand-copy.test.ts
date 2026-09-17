import test from 'node:test';
import assert from 'node:assert/strict';
import { brandCopyTask } from './brand-copy.js';

test('brand suggestions use the supplied brief and bound each field without fabricating footer facts', () => {
  const input = { model: 'codex', description: 'A weekly evidence briefing for healthcare leaders.', organization: 'Example Health', styleNotes: 'Plain and concise.' };
  for (const suggestField of ['tagline', 'footer']) {
    const task = brandCopyTask({ ...input, suggestField });
    assert.match(task.prompt, /healthcare leaders/);
    assert.match(task.prompt, /Example Health/);
    assert.match(task.prompt, /Do not invent contact details/);
    assert.equal(task.validate({ text: 'Evidence for informed decisions.' }), null);
    assert.ok(task.validate({ text: 'x'.repeat(suggestField === 'tagline' ? 141 : 301) }));
    assert.ok(task.validate({ text: '<script>no</script>' }));
    assert.ok(task.validate({ text: 'First line\nSecond line' }));
    assert.ok(task.validate({ text: '' }));
    assert.ok(task.validate({ text: 'A line.', saved: true }));
    assert.equal(task.parse({ text: '  A line.  ' }).text, 'A line.');
  }
  assert.throws(() => brandCopyTask({ ...input, suggestField: 'website' }));
  assert.equal(brandCopyTask({ ...input, suggestField: 'tagline', model: 'ollama:qwen3:8b' }).input.model, 'ollama:qwen3:8b');
  for (const model of ['opencode', 'opencode:ollama/qwen2.5:7b', 'opencode:opencode/example-free']) assert.equal(brandCopyTask({ ...input, suggestField: 'tagline', model }).input.model, model);
  for (const model of ['opencode:qwen2.5:7b', 'opencode:opencode/paid', 'opencode:ollama/example:cloud']) assert.throws(() => brandCopyTask({ ...input, suggestField: 'tagline', model }));
  assert.throws(() => brandCopyTask({ ...input, suggestField: 'footer', description: '' }), /Describe first/);
});
