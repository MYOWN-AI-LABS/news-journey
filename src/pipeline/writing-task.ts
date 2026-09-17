import { createHash } from 'node:crypto';

export type PreparedTaskRole = 'research' | 'evidence-select' | 'evidence-review' | 'newsletter-draft' | 'source-review' | 'source-repair' | 'script' | 'media-review';
export type PreparedTaskCapability = 'query-plan' | 'page-relevance' | 'evidence-select' | 'evidence-review' | 'newsletter-draft' | 'newsletter-edit' | 'source-review' | 'source-repair' | 'script-draft' | 'script-edit' | 'script-framing' | 'frame-alignment';
/** Code-owned task meaning. The dispatcher must never infer this from natural-language prompts. */
export interface PreparedModelTask {
  role: PreparedTaskRole;
  capability: PreparedTaskCapability;
  taskId: string;
  topicIds: string[];
  protocolHash: string;
  evidenceHash: string;
  candidateHash?: string;
}
const capabilities: Record<PreparedTaskRole, readonly PreparedTaskCapability[]> = {
  research: ['query-plan', 'page-relevance'],
  'evidence-select': ['evidence-select'],
  'evidence-review': ['evidence-review'],
  'newsletter-draft': ['newsletter-draft', 'newsletter-edit'],
  'source-review': ['source-review'],
  'source-repair': ['source-repair'],
  script: ['script-draft', 'script-edit', 'script-framing'],
  'media-review': ['frame-alignment'],
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assertPreparedModelTask(value: unknown): asserts value is PreparedModelTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Prepared model work requires explicit task metadata');
  if (Object.keys(value).some(key => !['role', 'capability', 'taskId', 'topicIds', 'protocolHash', 'evidenceHash', 'candidateHash'].includes(key))) throw new Error('Prepared task metadata cannot override routing policy or add arbitrary fields');
  const task = value as PreparedModelTask;
  if (!Object.hasOwn(capabilities, task.role) || !capabilities[task.role].includes(task.capability)
    || typeof task.taskId !== 'string' || !task.taskId.trim() || task.taskId.length > 200
    || !Array.isArray(task.topicIds) || task.topicIds.length < 1 || task.topicIds.length > 8
    || new Set(task.topicIds).size !== task.topicIds.length || task.topicIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 160)
    || typeof task.protocolHash !== 'string' || !/^[a-f0-9]{64}$/.test(task.protocolHash) || typeof task.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(task.evidenceHash)
    || task.candidateHash !== undefined && (typeof task.candidateHash !== 'string' || !/^[a-f0-9]{64}$/.test(task.candidateHash))) throw new Error('Prepared model task has invalid role, capability or identity metadata');
}
export function preparedModelTask(input: {
  role: PreparedTaskRole; capability: PreparedTaskCapability; taskId: string; topicIds: string[];
  protocol: unknown; evidence: unknown; candidate?: unknown;
}): PreparedModelTask {
  const task: PreparedModelTask = { role: input.role, capability: input.capability, taskId: input.taskId, topicIds: [...input.topicIds],
    protocolHash: digest(input.protocol), evidenceHash: digest(input.evidence), ...(input.candidate === undefined ? {} : { candidateHash: digest(input.candidate) }) };
  assertPreparedModelTask(task);
  return task;
}
