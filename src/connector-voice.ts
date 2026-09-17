import { assertProDistribution } from './release-profile.js';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { contained, read } from './workspaces.js';
import { TOOL_DEFINITIONS, TOOL_INSTRUCTIONS, callHarnessTool, type ToolContext } from './connector-tools.js';

export const conversationSchema = z.object({ model: z.string().regex(/^gpt-realtime(?:-[a-z0-9.]+)*$/).default('gpt-realtime-2.1'), voice: z.enum(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']).default('marin'), apiKey: z.string().max(8000).optional() }).strict();
function settings(root: string) { return conversationSchema.omit({ apiKey: true }).parse(read(contained(root, 'config/conversation.json'), {})); }
function apiKey(root: string) {
  const file = contained(root, '.env'), env = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const key = env.OPENAI_REALTIME_API_KEY || env.OPENAI_API_KEY;
  if (!key) throw new Error('Save an OpenAI voice API key in Talk to your harness first');
  return key;
}
export function conversationState(root: string) { let keySaved = false; try { keySaved = Boolean(apiKey(root)); } catch { /* not configured */ } return { ...settings(root), keySaved, audioStorage: 'none', transcriptStorage: 'browser session memory only' }; }
export function conversationTools() { return Object.entries(TOOL_DEFINITIONS).map(([name, d]) => ({ type: 'function', name, description: d.description, parameters: z.toJSONSchema(d.schema) })); }
export async function realtimeSession(root: string, sdp: unknown, fetcher = fetch) {
  assertProDistribution("Conversational assistant");
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 64000) throw new Error('Invalid WebRTC offer');
  const config = settings(root), form = new FormData(); form.set('sdp', sdp);
  form.set('session', JSON.stringify({ type: 'realtime', model: config.model, instructions: TOOL_INSTRUCTIONS, tools: conversationTools(), audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' }, turn_detection: { type: 'server_vad', interrupt_response: true, create_response: true } }, output: { voice: config.voice } } }));
  const response = await fetcher('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: { authorization: 'Bearer ' + apiKey(root) }, body: form, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`OpenAI Realtime HTTP ${response.status}; check the voice key, model access and quota`);
  const answer = await response.text(); if (!answer.startsWith('v=0') || answer.length > 128000) throw new Error('Invalid Realtime answer');
  return { sdp: answer };
}
/** Text fallback uses the voice account and the same limited tools, with bounded, nonpersisted context. */
export async function conversationText(ctx: ToolContext, input: unknown, fetcher = fetch) {
  assertProDistribution("Conversational assistant");
  const { text, requestId, history } = z.object({ text: z.string().min(1).max(4000), requestId: z.string().uuid(), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }).strict()).max(12).default([]) }).strict().parse(input);
  const messages: any[] = [{ role: 'system', content: TOOL_INSTRUCTIONS }, ...history, { role: 'user', content: text }];
  const tools = conversationTools().map(({ type, ...f }) => ({ type, function: f }));
  for (let round = 0; round < 4; round++) {
    const response = await fetcher('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + apiKey(ctx.root), 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages, tools, parallel_tool_calls: false, max_tokens: 1200 }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`OpenAI text conversation HTTP ${response.status}`);
    const message = (await response.json()).choices?.[0]?.message;
    if (!message) throw new Error('No conversation response');
    if (!message.tool_calls?.length) return { text: String(message.content || '') };
    if (round === 3) return { text: 'Tool-call limit reached. Check the action receipts and local review queue to see what completed.' };
    messages.push(message);
    for (const [index, call] of message.tool_calls.slice(0, 4).entries()) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments);
        if (TOOL_DEFINITIONS[call.function.name as keyof typeof TOOL_DEFINITIONS] && 'requestId' in TOOL_DEFINITIONS[call.function.name as keyof typeof TOOL_DEFINITIONS].schema.shape) args.requestId = `${requestId}:${round}:${index}`;
        result = await callHarnessTool(ctx, call.function.name, args);
      } catch (error) { result = { error: (error as Error).message.split(ctx.token).join('[redacted]') }; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ trust: 'untrusted-data', result }) });
    }
  }
}
