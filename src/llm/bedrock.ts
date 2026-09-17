import { BedrockRuntimeClient, ConverseCommand, type BedrockRuntimeClientConfig, type ConverseCommandOutput, type ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

export interface BedrockSettings {
  model: string;
  region?: string;
  maxTokens?: number;
  /** Explicit operator declaration; actual model support still needs a live check. */
  supportsImages?: boolean;
}
export interface BedrockRuntime {
  model?: string; region?: string; timeoutMs: number;
  maxTokens?: number; outputTokenLimit?: number; supportsImages?: boolean;
}
interface ConverseClient {
  send(command: ConverseCommand, options: { abortSignal: AbortSignal }): Promise<ConverseCommandOutput>;
  destroy(): void;
}
interface Dependencies {
  clientFactory?: (options: BedrockRuntimeClientConfig) => ConverseClient;
  recordResponse?: (usage: ConverseCommandOutput['usage'], stopReason: ConverseCommandOutput['stopReason']) => void;
}

/** Native Converse with the SDK's credential chain and SigV4 signing. One SDK attempt is
 * one harness reservation; transport retries remain owned by the original caller. */
export async function bedrockText(prompt: string, runtime: BedrockRuntime, images: string[] = [], dependencies: Dependencies = {}): Promise<string> {
  if (!runtime.model?.trim() || !runtime.region?.trim()) throw new Error('Bedrock requires an explicit model ID or inference profile and AWS region');
  if (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs <= 0 || runtime.timeoutMs > 2_147_483_647) throw new Error('Bedrock timeout must be a positive, bounded number of milliseconds');
  if (images.length && runtime.supportsImages !== true) throw new Error('This Bedrock model has not been configured for image input; set supportsImages only for an image-capable selected model');
  if (images.length > 20) throw new Error('Bedrock accepts at most 20 image inputs per request');
  const content: ContentBlock[] = [{ text: prompt }];
  for (const path of images) {
    const extension = extname(path).toLowerCase();
    const format = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension === '.png' ? 'png' : extension === '.gif' ? 'gif' : extension === '.webp' ? 'webp' : null;
    if (!format) throw new Error('Bedrock image input must be PNG, JPEG, GIF or WebP');
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 3.75 * 1024 * 1024) throw new Error('Bedrock image input exceeds the 3.75 MiB file limit');
    const bytes = readFileSync(path);
    if (bytes.length !== stat.size) throw new Error('Bedrock image changed while being read');
    content.push({ image: { format, source: { bytes } } });
  }
  const maxTokens = Math.min(runtime.outputTokenLimit ?? Infinity, runtime.maxTokens ?? 4096);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) throw new Error('Bedrock maxTokens must be a positive integer no greater than 131072');
  const client = (dependencies.clientFactory ?? (options => new BedrockRuntimeClient(options)))({ region: runtime.region, maxAttempts: 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const response = await client.send(new ConverseCommand({ modelId: runtime.model, messages: [{ role: 'user', content }], inferenceConfig: { maxTokens } }), { abortSignal: controller.signal });
    dependencies.recordResponse?.(response.usage, response.stopReason);
    if (!['end_turn', 'stop_sequence'].includes(response.stopReason ?? '')) throw new Error(`Bedrock did not complete its response (${response.stopReason ?? 'missing stop reason'})`);
    if (response.output?.message?.role !== 'assistant') throw new Error('Bedrock returned no assistant message');
    const blocks = response.output.message.content ?? [];
    if (blocks.some(block => 'toolUse' in block)) throw new Error('Bedrock requested an unconfigured tool');
    // Reasoning blocks are never treated as authored JSON/prose.
    const text = blocks.flatMap(block => typeof block.text === 'string' ? [block.text] : []).join('\n');
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Bedrock response exceeded the 4 MiB byte limit');
    if (!text.trim()) throw new Error('Bedrock returned no assistant text');
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Bedrock timed out after ${Math.round(runtime.timeoutMs / 1000)}s`, { cause: error });
    throw error;
  } finally { clearTimeout(timer); client.destroy(); }
}
