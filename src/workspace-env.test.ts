import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceEnv } from './workspaces.js';
import { resolveModelRuntime } from './llm/model.js';

test('reloading a saved writer removes old workspace overrides in the same worker', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-env-'));
  const before = { ...process.env };
  try {
    writeFileSync(join(root, 'workspace.json'), '{}');
    writeFileSync(join(root, '.env'), 'AI_CONTENT_MODEL_PROVIDER=claude\nAI_CONTENT_MODEL_NAME=old-hosted-writer\nAI_CONTENT_MODEL_API_KEY=old-workspace-key\n');
    loadWorkspaceEnv(root);
    assert.equal(process.env.AI_CONTENT_MODEL_PROVIDER, 'claude');
    process.env.HARNESS_ENV_TEST = 'preserve-routing';
    process.env.CONTENT_TEST_STARTUP = 'preserve-unmanaged-startup';
    writeFileSync(join(root, '.env'), 'CONTENT_TEST_CURRENT=new-workspace-value\n');
    loadWorkspaceEnv(root);
    const actual = resolveModelRuntime({ provider: 'ollama', providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'selected-local-writer' } } });
    assert.equal(actual.provider, 'ollama');
    assert.equal(actual.model, 'selected-local-writer');
    assert.equal(process.env.AI_CONTENT_MODEL_API_KEY, undefined);
    assert.equal(process.env.CONTENT_TEST_CURRENT, 'new-workspace-value');
    assert.equal(process.env.HARNESS_ENV_TEST, 'preserve-routing');
    assert.equal(process.env.CONTENT_TEST_STARTUP, 'preserve-unmanaged-startup');
    writeFileSync(join(root, '.env'), '');
    loadWorkspaceEnv(root);
    assert.equal(process.env.CONTENT_TEST_CURRENT, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});
