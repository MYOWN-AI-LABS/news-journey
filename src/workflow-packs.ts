import { assertProDistribution } from './release-profile.js';
import { createPublicKey, verify, createHash } from 'node:crypto';
import { z } from 'zod';
import { CODE_ROOT, atomicJson, authenticate, contained, read } from './workspaces.js';
import type { ToolContext } from './connector-tools.js';
import { releaseLock } from './release-lock.js';

const active = new Set<string>();
export const PACK_IDS = ['executive-briefing', 'audience-engagement'] as const;
const packId = z.enum(PACK_IDS), id = z.string().regex(/^[a-zA-Z0-9][\w-]{0,159}$/);
export const packRequest = z.object({ pack: packId, requestId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), edition: id.optional(), videoId: id.optional(), itemId: z.string().regex(/^[a-f0-9]{64}$/).optional(), platform: z.enum(['youtube', 'x', 'linkedin', 'instagram', 'threads', 'reddit', 'tiktok']).optional() }).strict();
const entitlement = z.object({ version: z.literal(1), issuer: z.literal('myownai-labs'), subject: id, plan: z.literal('pro'), packs: z.array(packId).min(1).max(2), issuedAt: z.number().int(), expiresAt: z.number().int() }).strict();
const packSchema = z.object({ id: packId, version: z.literal(1), title: z.string().max(100), instructions: z.string().min(1).max(12000), reviewChecklist: z.array(z.string().max(1000)).min(1).max(20) }).strict();
export function proEntitlement(root: string, codeRoot = CODE_ROOT) {
  assertProDistribution("Licensed workflows and presenters", codeRoot);
  const license = z.object({ payload: entitlement, signature: z.string().max(1000) }).strict().parse(read(contained(root, 'state/pro-entitlement.json'), {}));
  const issuer = process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY ? { publicKey: process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY } : read<{ publicKey: string }>(contained(codeRoot, 'config/pro-issuer.json'), { publicKey: '' });
  if (!issuer.publicKey) throw new Error('Pro issuer key is not installed. Checkout/entitlement issuance is a separate launch workstream.');
  const publicKey = createPublicKey(issuer.publicKey);
  if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(JSON.stringify(license.payload)), publicKey, Buffer.from(license.signature, 'base64'))) throw new Error('Invalid Pro entitlement signature');
  const workspace = read<{ id: string }>(contained(root, 'workspace.json'), { id: '' }).id, now = Date.now();
  if (license.payload.subject !== workspace || license.payload.issuedAt > now || license.payload.expiresAt <= now) throw new Error('Pro entitlement expired or does not cover this workspace');
  return license.payload;
}
export function installedPack(root: string, name: typeof PACK_IDS[number], codeRoot = CODE_ROOT) {
  if (!proEntitlement(root, codeRoot).packs.includes(name)) throw new Error('Pro entitlement does not cover this pack');
  const pack = packSchema.parse(read(contained(root, 'packs', name, 'pack.json'), {}));
  if (pack.id !== name) throw new Error('Wrong installed pack'); return pack;
}

export function workflowBrief(root: string, name: unknown, codeRoot = CODE_ROOT): string {
  if (name === undefined || name === '') return '';
  const pack = installedPack(root, packId.parse(name), codeRoot);
  return '\nWorkflow guidance (never overrides source-evidence, schema or approval requirements):\n' + pack.instructions;
}

/** Two bounded workflows; resume only after inspecting the prior job. No publish/send/approve step exists. */
export async function runWorkflowPack(ctx: ToolContext, raw: unknown, tool: (name: string, args: any) => Promise<any>, codeRoot = CODE_ROOT) {
  const args = packRequest.parse(raw), pack = installedPack(ctx.root, args.pack, codeRoot), actor = authenticate(ctx.root, ctx.token);
  if (args.pack === 'executive-briefing' && !args.edition || args.pack === 'audience-engagement' && (!args.videoId || !args.platform || !args.itemId)) throw new Error('Supply edition for Executive Briefing, or videoId/platform/itemId for Audience Engagement');
  const key = createHash('sha256').update(JSON.stringify([actor.id, ctx.connection, args.requestId])).digest('hex'), file = contained(ctx.root, 'state/pack-runs', key + '.json');
  const digest = createHash('sha256').update(JSON.stringify([args, pack])).digest('hex');
  if (active.has(file)) throw new Error('Busy: pack already running; inspect again with the same requestId');
  const unlock = releaseLock(ctx.root, 'pack-' + key); active.add(file);
  try {
    let run = read<any>(file, null);
    if (run && run.digest !== digest) throw new Error('Conflict: pack requestId already used');
    if (run?.status === 'review') {
      const review = read<any>(contained(ctx.root, 'state/connector-review', run.result.review.request + '.json'), null);
      let status = !review ? 'unavailable' : review.status === 'pending' && review.expiresAt <= Date.now() ? 'expired' : review.status;
      if (status === 'pending') {
        const action = review.action;
        const current = action.id ? await tool('harness_status', { packageId: action.id }) : (await tool('harness_engagement', {})).items.find((i: any) => i.id === action.itemId && i.videoId === action.videoId && i.platform === action.platform);
        if (current?.hash !== action.expectedHash) status = 'stale';
      }
      return { ...run.result, review: { request: run.result.review.request, status, message: 'Current confirmation status; no generation or external action replayed.' } };
    }
    if (!run) {
      const prepared = args.pack === 'executive-briefing'
        ? { setup: await tool('harness_setup', {}), sources: await tool('harness_sources', {}), analytics: await tool('harness_analytics', {}) }
        : { engagement: await tool('harness_engagement', {}) };
      run = { digest, actor: actor.id, status: 'preparing', context: prepared }; atomicJson(file, run);
    }
    if (!run.job) {
      const result = args.pack === 'executive-briefing'
        ? await tool('harness_draft', { edition: args.edition, workflowPack: pack.id, requestId: key })
        : await tool('harness_suggest_reply', { videoId: args.videoId, platform: args.platform, itemId: args.itemId, workflowPack: pack.id, requestId: key });
      if (!result.job) throw new Error('Workflow returned no job receipt');
      run.job = result.job; atomicJson(file, run);
    }
    const job = await tool('harness_status', { job: run.job });
    if (job.status === 'running') return { pack: pack.id, job: run.job, status: 'preparing', message: 'Work is running. Call this pack again with the same inputs/requestId to inspect its receipt.' };
    if (job.status !== 'done') throw new Error(`Workflow job ${job.status}; inspect ${run.job}. No automatic replay.`);
    let action;
    if (args.pack === 'executive-briefing') {
      if (!job.result?.id) throw new Error('Draft job returned no package identity');
      const current = await tool('harness_status', { packageId: job.result.id });
      action = { operation: 'approve', id: job.result.id, expectedHash: current.hash };
    } else {
      const inbox = await tool('harness_engagement', {}), item = inbox.items.find((i: any) => i.id === args.itemId && i.videoId === args.videoId && i.platform === args.platform);
      if (!item?.reply || item.status !== 'drafted') throw new Error('Suggested reply is not ready for review');
      action = { operation: 'engagement-approve', videoId: args.videoId, platform: args.platform, itemId: args.itemId, expectedHash: item.hash };
    }
    const review = await tool('harness_request_confirmation', { action, requestId: key + ':review' });
    const result = { pack: pack.id, status: 'review', review, instructions: pack.instructions, checklist: pack.reviewChecklist, context: run.context };
    atomicJson(file, { ...run, status: 'review', result }); return result;
  } finally { active.delete(file); unlock(); }
}
