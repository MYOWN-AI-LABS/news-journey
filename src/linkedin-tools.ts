import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { atomicJson, contained, read } from './workspaces.js';
import { releaseLock } from './release-lock.js';
import { buildLinkedInWorkbenchTask, type LinkedInWorkbenchResult } from './linkedin-workbench.js';

export const linkedinContextRequest = z.object({
  url: z.string().min(1).max(2000), provider: z.literal('apify'),
  includeComments: z.boolean().default(false),
}).strict();

/** Private, actor-owned evidence and drafts; these are never publication approvals. */
function save(root: string, actor: string, kind: 'draft' | 'context', input: unknown, result: unknown) {
  const createdAt = new Date().toISOString();
  const fingerprint = createHash('sha256').update(JSON.stringify({ input, result })).digest('hex');
  const receiptId = randomBytes(16).toString('hex');
  const receipt = { receiptId, actor, kind, createdAt, fingerprint, status: 'review-required', input, result };
  atomicJson(contained(root, 'workdir/linkedin', receiptId + '.json'), receipt);
  return receipt;
}

export function linkedinSaved(root: string, actor: string, receiptId?: string) {
  if (receiptId !== undefined) {
    if (!/^[a-f0-9]{32}$/.test(receiptId)) throw new Error('Unknown LinkedIn draft');
    const row = read<any>(contained(root, 'workdir/linkedin', receiptId + '.json'), null);
    if (!row || row.actor !== actor) throw new Error('Unknown LinkedIn draft');
    return row;
  }
  const directory = contained(root, 'workdir/linkedin');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name))
    .map(name => read<any>(contained(root, 'workdir/linkedin', name), null))
    .filter(row => row?.actor === actor)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
    .map(({ receiptId, kind, createdAt, result, status }) => ({ receiptId, kind, createdAt, title: result.title || 'LinkedIn source context', status }));
}

export async function linkedinDraft(root: string, actor: string, input: unknown) {
  const task = buildLinkedInWorkbenchTask(input);
  const unlock = releaseLock(root, 'linkedin-workbench');
  try {
    const { modelJson } = await import('./llm/model.js');
    const result = task.parse(await modelJson<LinkedInWorkbenchResult>(task.prompt, task.validate, undefined, undefined, [], true));
    return { ...save(root, actor, 'draft', task.input, result), message: 'Draft saved for your review. Copy or export it after checking the facts.' };
  } finally { unlock(); }
}

export async function linkedinRead(root: string, actor: string, input: unknown) {
  const request = linkedinContextRequest.parse(input);
  const { readLinkedInContext } = await import('./linkedin-context.js');
  const unlock = releaseLock(root, 'linkedin-context');
  try {
    const result = await readLinkedInContext({ ...request, apiKey: process.env.APIFY_TOKEN || '' });
    return { ...save(root, actor, 'context', request, result), message: 'Source context saved. Review coverage before using it in a draft.' };
  } finally { unlock(); }
}
