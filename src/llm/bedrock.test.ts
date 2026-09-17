import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockRuntimeClient, type ConverseCommand, type ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { bedrockText } from './bedrock.js';
import type { ModelAttempt, ModelConfig } from './model.js';
import { withJsonOutputContract } from './json-output-contract.js';
import { CODE_ROOT, createWorkspace } from '../workspaces.js';
import { parseBrief, saveWriter } from '../onboarding.js';
import { requestSchema } from '../brand-copy.js';
import { agentSetupSchema } from '../journey-guidance.js';

// The SDK transport is stubbed below; no credentials, provider requests or user receipts.
const temporary = mkdtempSync(join(tmpdir(), 'bedrock-offline-'));
const prior = { HARNESS_WORKSPACE: process.env.HARNESS_WORKSPACE, HARNESS_IDENTITY_FILE: process.env.HARNESS_IDENTITY_FILE, HARNESS_TOKEN: process.env.HARNESS_TOKEN };
delete process.env.HARNESS_WORKSPACE; delete process.env.HARNESS_TOKEN;
process.env.HARNESS_IDENTITY_FILE = join(temporary, 'identity.json');
const slug = `bedrock-test-${process.pid}`, root = createWorkspace(slug, false, CODE_ROOT);
process.env.HARNESS_WORKSPACE = slug;
const { modelJson, resolveModelRuntime, modelCanReadImages, ModelInvocationStopped } = await import('./model.js');
after(() => {
  rmSync(root, { recursive: true, force: true }); rmSync(temporary, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const config: ModelConfig = { provider: 'bedrock', timeoutSeconds: 5, providers: { bedrock: { model: 'configured-model-v1', region: 'us-east-1', maxTokens: 2048, supportsImages: false } } };
const runtime = { model: 'configured-model-v1', region: 'us-east-1', timeoutMs: 1000, maxTokens: 2048 };
const response = (text: string, stopReason: ConverseCommandOutput['stopReason'] = 'end_turn'): ConverseCommandOutput => ({
  $metadata: {}, output: { message: { role: 'assistant', content: [{ text }] } }, stopReason,
  usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 }, metrics: { latencyMs: 1 },
});

test('Bedrock requires a configured model and region, keeps runtime identity, and rejects generic endpoint/key overrides', async () => {
  const selected = resolveModelRuntime(config, {});
  assert.equal(selected.model, runtime.model); assert.equal(selected.region, 'us-east-1');
  assert.equal(selected.maxTokens, 2048); assert.equal(selected.supportsImages, false);
  assert.equal(resolveModelRuntime(config, { AWS_REGION: 'us-gov-west-1', AI_CONTENT_MODEL_NAME: 'arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/configured' }).region, 'us-gov-west-1');
  assert.equal(resolveModelRuntime({ ...config, providers: { bedrock: { model: runtime.model } } }, { AWS_DEFAULT_REGION: 'eu-west-1' }).region, 'eu-west-1');
  for (const settings of [{ region: 'us-east-1', model: '' }, { model: runtime.model }, { model: runtime.model, region: 'https://elsewhere.invalid' }]) {
    assert.throws(() => resolveModelRuntime({ ...config, providers: { bedrock: settings } }, {}), /Bedrock requires/);
  }
  assert.throws(() => resolveModelRuntime(config, { AI_CONTENT_MODEL_BASE_URL: 'https://elsewhere.invalid' }), /AWS credentials/);
  assert.throws(() => resolveModelRuntime(config, { AI_CONTENT_MODEL_API_KEY: 'unused-test-value' }), /AWS credentials/);
  assert.throws(() => resolveModelRuntime({ ...config, providers: { bedrock: { ...config.providers.bedrock!, maxTokens: 0 } } }, {}), /maxTokens/);
  assert.equal(await modelCanReadImages(config, {}), false);
  assert.equal(await modelCanReadImages({ ...config, providers: { bedrock: { ...config.providers.bedrock!, supportsImages: true } } }, {}), true);
});

test('native Converse keeps the SDK credential chain, exactly one SDK attempt, explicit inference limit and measured usage', async () => {
  let sends = 0, destroyed = false, recorded = false;
  assert.equal(await bedrockText('the complete source packet', { ...runtime, outputTokenLimit: 1024 }, [], {
    clientFactory(options) {
      assert.deepEqual(options, { region: 'us-east-1', maxAttempts: 1 }); // No credential replacement or endpoint override.
      return { async send(command, { abortSignal }) {
        sends++; assert.equal(abortSignal.aborted, false);
        assert.deepEqual(command.input, { modelId: runtime.model, messages: [{ role: 'user', content: [{ text: 'the complete source packet' }] }], inferenceConfig: { maxTokens: 1024 } });
        return response('complete answer');
      }, destroy() { destroyed = true; } };
    }, recordResponse(usage, stop) { assert.equal(usage?.totalTokens, 19); assert.equal(stop, 'end_turn'); recorded = true; },
  }), 'complete answer');
  assert.equal(sends, 1); assert.equal(destroyed, true); assert.equal(recorded, true);
});

test('a caller completion allowance cannot increase the configured Bedrock output ceiling', async () => {
  await bedrockText('complete request', { ...runtime, maxTokens: 128, outputTokenLimit: 1024 }, [], { clientFactory: () => ({
    async send(command) { assert.equal(command.input.inferenceConfig?.maxTokens, 128); return response('bounded answer'); }, destroy() {},
  }) });
});

test('truncated, guarded, empty and tool-request responses cannot pass; provider errors do not retry inside the adapter', async () => {
  const invalid: Array<[ConverseCommandOutput, RegExp]> = [
    [response('partial', 'max_tokens'), /did not complete/], [response('blocked', 'guardrail_intervened'), /did not complete/],
    [response(''), /no assistant text/], [{ ...response(''), output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'a', name: 'unconfigured', input: {} } }] } } }, /unconfigured tool/],
    [{ ...response(''), output: { message: { role: 'user', content: [{ text: 'not an answer' }] } } }, /no assistant message/],
  ];
  for (const [value, pattern] of invalid) {
    let sends = 0, destroyed = false, measured = false;
    await assert.rejects(bedrockText('source', runtime, [], { clientFactory: () => ({ async send() { sends++; return value; }, destroy() { destroyed = true; } }), recordResponse() { measured = true; } }), pattern);
    assert.equal(sends, 1); assert.equal(destroyed, true); assert.equal(measured, true);
  }
  let sends = 0;
  await assert.rejects(bedrockText('source', runtime, [], { clientFactory: () => ({ async send() { sends++; throw new Error('AccessDeniedException'); }, destroy() {} }) }), /AccessDeniedException/);
  assert.equal(sends, 1);
});

test('deadline aborts the physical SDK request and closes the client without another attempt', async () => {
  let destroyed = false, sends = 0;
  await assert.rejects(bedrockText('source', { ...runtime, timeoutMs: 10 }, [], { clientFactory: () => ({
    send(_command, { abortSignal }) { sends++; return new Promise((_resolve, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); },
    destroy() { destroyed = true; },
  }) }), /Bedrock timed out/);
  assert.equal(sends, 1); assert.equal(destroyed, true);
  await assert.rejects(bedrockText('source', { ...runtime, timeoutMs: NaN }), /timeout must/);
});

test('vision requires explicit selected-model support and sends unchanged image bytes through Converse', async () => {
  const file = join(temporary, 'frame.png'), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDA0AAAAASUVORK5CYII=', 'base64');
  writeFileSync(file, bytes);
  await assert.rejects(bedrockText('check frame', runtime, [file]), /has not been configured for image input/);
  await assert.rejects(bedrockText('check frame', { ...runtime, supportsImages: true }, [file + '.svg']), /must be PNG/);
  assert.equal(await bedrockText('check frame', { ...runtime, supportsImages: true }, [file], { clientFactory: () => ({
    async send(command) {
      const image = command.input.messages?.[0].content?.[1].image;
      assert.equal(image?.format, 'png'); assert.deepEqual(image?.source?.bytes, bytes);
      return response('frame reviewed');
    }, destroy() {},
  }) }), 'frame reviewed');
});

test('physical JSON attempts preserve the full schema, model, region and completion budget before invocation', async () => {
  const oldSend = BedrockRuntimeClient.prototype.send, oldDestroy = BedrockRuntimeClient.prototype.destroy;
  const invocations: ConverseCommand[] = [], attempts: ModelAttempt[] = [], prompts: string[] = [];
  BedrockRuntimeClient.prototype.send = (async function(command: ConverseCommand) {
    invocations.push(command);
    return response(JSON.stringify(invocations.length === 1 ? { publish: {} } : { publish: { title: 'Grounded title' } }));
  }) as typeof oldSend;
  BedrockRuntimeClient.prototype.destroy = () => {};
  try {
    const validate = withJsonOutputContract((value: { publish?: { title?: string } }) => typeof value?.publish?.title === 'string' ? null : 'publish.title is required', {
      type: 'object', additionalProperties: false, required: ['publish'], properties: { publish: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 } } } },
    });
    const result = await modelJson('Original complete source conditions.', validate, config, {}, [], true, Date.now() + 5000, {
      outputTokenLimit: 1024,
      beforeAttempt(attempt, prompt) {
        attempts.push(attempt); prompts.push(prompt!);
        assert.equal(invocations.length, attempts.length - 1, 'caller reserves before each physical request');
        assert.equal(attempt.region, 'us-east-1'); assert.equal(attempt.model, runtime.model);
        assert.equal(attempt.outputMode, 'prompt-schema'); assert.equal(attempt.outputTokenLimit, 1024);
        assert.equal(attempt.promptBytes, Buffer.byteLength(prompt!));
        assert.equal(attempt.promptHash, createHash('sha256').update(prompt!).digest('hex'));
        assert.match(prompt!, /HARNESS_JSON_OUTPUT_SCHEMA_V1/); assert.match(prompt!, /"required":\["title"\]/);
      },
    });
    assert.deepEqual(result, { publish: { title: 'Grounded title' } }); assert.equal(invocations.length, 2);
    assert.match(prompts[1], /Validation error: publish.title is required/);
    for (const [index, command] of invocations.entries()) {
      assert.equal(command.input.messages?.[0].content?.[0].text, prompts[index]);
      assert.equal(command.input.inferenceConfig?.maxTokens, 1024);
    }
    const receipts = readFileSync(join(root, 'state/model-calls.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    assert.equal(receipts.length, 2); assert.ok(receipts.every(row => row.provider === 'bedrock' && row.region === 'us-east-1' && row.usage.totalTokens === 19 && row.reportedCostUsd === null));
    await assert.rejects(modelJson('stopped before dispatch', validate, config, {}, [], true, Date.now() + 5000, { beforeAttempt() { throw new Error('original parent exhausted'); } }), ModelInvocationStopped);
    assert.equal(invocations.length, 2, 'an exhausted parent cannot trigger a request or rescue');
  } finally { BedrockRuntimeClient.prototype.send = oldSend; BedrockRuntimeClient.prototype.destroy = oldDestroy; }
});

test('onboarding and agent schemas accept Bedrock; writer changes retain configured region and image declaration', () => {
  const brief = 'Publication: Daily Brief\nAudience: Operations leaders\nModel: bedrock\nModel name: chosen-profile\n\n## Topics\n- Current affairs\n';
  assert.equal(parseBrief(brief).model, 'bedrock');
  assert.throws(() => parseBrief(brief + '\nModel URL: https://unrelated.invalid\n'), /AWS region/);
  assert.equal(requestSchema.parse({ suggestField: 'tagline', model: 'bedrock', description: 'A daily brief for operations leaders.' }).model, 'bedrock');
  assert.equal(agentSetupSchema.parse({ operation: 'publication', publication: 'Daily Brief', audience: 'Operations leaders', topics: 'Current affairs', model: 'bedrock' }).operation, 'publication');
  writeFileSync(join(root, 'config/model.json'), JSON.stringify({ ...config, providers: { bedrock: { ...config.providers.bedrock!, supportsImages: true } } }));
  saveWriter(root, 'bedrock', 'new-profile', '');
  const saved = JSON.parse(readFileSync(join(root, 'config/model.json'), 'utf8'));
  assert.deepEqual(saved.providers.bedrock, { model: 'new-profile', region: 'us-east-1', maxTokens: 2048, supportsImages: true });
  assert.equal(resolveModelRuntime(saved, {}).region, 'us-east-1');
});
