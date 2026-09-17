import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { releaseLock } from './release-lock.js';
import { atomicJson, authorize, contained, read, safeId } from './workspaces.js';

export const PERSONAL_PROFILE_VERSION = 1;
export const PERSONAL_GUIDANCE_VERSION = 1;
export const PERSONAL_EXPLANATION_LEVELS = ['plain', 'balanced', 'technical'] as const;
export const PERSONAL_DETAIL_LEVELS = ['brief', 'balanced', 'detailed'] as const;
export const MAX_PERSONAL_CORRECTIONS = 12;
export const MAX_PERSONAL_PROFILE_BYTES = 32768;
export const MAX_PERSONAL_GUIDANCE_BYTES = 1800;

/** Only these reviewed, provider-neutral reminders can enter a writing prompt. */
export const PERSONAL_CORRECTION_CATEGORIES = Object.freeze([
  { id: 'source-conditions', label: 'Keep source conditions', guidance: 'Keep every material source condition, limit, attribution and conflict. Do not choose one side of conflicting evidence without support.' },
  { id: 'intended-vs-achieved', label: 'Separate plans from results', guidance: 'Distinguish documented instructions, intended behavior and planned work from observed results. Instructions alone do not establish an achieved outcome.' },
  { id: 'source-date', label: 'Keep dates accurate', guidance: 'Anchor source-relative dates such as today to the source publication date, never automatically to the edition date. Do not invent an unknown date.' },
  { id: 'story-identity', label: 'Keep different stories eligible', guidance: 'Exclude a story as already covered only when source-backed event identity and confirmed prior publication establish the same story. Shared words, entities or topics are insufficient.' },
  { id: 'topic-drift', label: 'Follow the current brief', guidance: 'Use the current explicit brief to determine coverage. Never infer topics, places or sources from an earlier edition or personal background.' },
  { id: 'length', label: 'Meet the selected length', guidance: 'Meet the selected output word range using supported, useful content. Do not pad with repeated sentences or unsupported facts; do not change the selected range.' },
] as const);
export type PersonalCorrectionCategory = typeof PERSONAL_CORRECTION_CATEGORIES[number]['id'];

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
// Ordinary textarea whitespace is allowed. Invisible control and directional characters are not.
const textSchema = (characters: number, bytes: number) => z.string().max(characters)
  .refine(value => Buffer.byteLength(value, 'utf8') <= bytes, 'Text exceeds its byte limit')
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value), 'Text contains unsupported control characters');
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const scopeSchema = z.object({ workspaceId: hashSchema, publicationId: z.string().refine(value => { try { safeId(value); return true; } catch { return false; } }) }).strict();
const categorySchema = z.enum(PERSONAL_CORRECTION_CATEGORIES.map(row => row.id) as [PersonalCorrectionCategory, ...PersonalCorrectionCategory[]]);
const correctionSchema = z.object({
  id: hashSchema, category: categorySchema, note: textSchema(500, 2000),
  createdAt: z.iso.datetime(), createdBy: textSchema(160, 640).min(1),
}).strict();
const profileSchema = z.object({
  version: z.literal(PERSONAL_PROFILE_VERSION), revision: revisionSchema, scope: scopeSchema,
  enabled: z.boolean(), about: textSchema(600, 2400),
  explanation: z.enum(['', ...PERSONAL_EXPLANATION_LEVELS]), detail: z.enum(['', ...PERSONAL_DETAIL_LEVELS]),
  corrections: z.array(correctionSchema).max(MAX_PERSONAL_CORRECTIONS),
  updatedAt: z.iso.datetime().nullable(), updatedBy: textSchema(160, 640).min(1).nullable(),
  /** Opaque receipt for an exact request retry; it contains no saved personal or mistake text. */
  lastMutation: hashSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.corrections.map(row => row.id)).size !== value.corrections.length) ctx.addIssue({ code: 'custom', message: 'Duplicate correction identity' });
  if (Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') > MAX_PERSONAL_PROFILE_BYTES) ctx.addIssue({ code: 'custom', message: 'Personal profile exceeds its bounded storage' });
});
export type PersonalProfile = z.infer<typeof profileSchema>;
export type PersonalCorrection = PersonalProfile['corrections'][number];

const saveSchema = z.object({
  expectedRevision: revisionSchema, enabled: z.boolean(), about: textSchema(600, 2400),
  explanation: z.enum(['', ...PERSONAL_EXPLANATION_LEVELS]), detail: z.enum(['', ...PERSONAL_DETAIL_LEVELS]),
}).strict();
const recordSchema = z.object({
  expectedRevision: revisionSchema, requestId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/),
  category: categorySchema, note: textSchema(500, 2000),
}).strict();
const forgetSchema = z.object({ expectedRevision: revisionSchema, id: hashSchema }).strict();
const clearSchema = z.object({ expectedRevision: revisionSchema }).strict();
export type SavePersonalProfile = z.infer<typeof saveSchema>;
export type RecordPersonalCorrection = z.infer<typeof recordSchema>;
export type ForgetPersonalCorrection = z.infer<typeof forgetSchema>;
export type ClearPersonalProfile = z.infer<typeof clearSchema>;

function scopeFor(root: string): PersonalProfile['scope'] {
  const config = read<{ publicationId?: string }>(contained(root, 'config/memory.json'), {});
  return { workspaceId: digest(realpathSync(root)), publicationId: safeId(config.publicationId ?? 'default') };
}
function emptyProfile(scope: PersonalProfile['scope']): PersonalProfile {
  return { version: PERSONAL_PROFILE_VERSION, revision: 0, scope, enabled: false, about: '', explanation: '', detail: '', corrections: [], updatedAt: null, updatedBy: null, lastMutation: null };
}

/** Publication-scoped internal read. Expose personal text only to authorized workspace managers.
 * Workers may read it internally, but must pass only personalWritingGuidance() to models.
 */
export function readPersonalProfile(root: string): PersonalProfile {
  const scope = scopeFor(root), path = contained(root, 'config/personal-profile.json');
  if (!existsSync(path)) return emptyProfile(scope);
  if (statSync(path).size > MAX_PERSONAL_PROFILE_BYTES) throw new Error('Personal profile exceeds its bounded storage');
  const profile = profileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (profile.scope.workspaceId !== scope.workspaceId || profile.scope.publicationId !== scope.publicationId) {
    throw new Error('This personal profile belongs to another workspace or publication. It cannot be reused here; restore its original publication setting or create a fresh workspace.');
  }
  return profile;
}

function mutate(root: string, operation: string, input: { expectedRevision: number }, update: (profile: PersonalProfile, actor: string) => PersonalProfile): PersonalProfile {
  const actor = authorize('manage', { root }), unlock = releaseLock(root, 'personal-profile');
  try {
    const profile = readPersonalProfile(root), request = digest({ scope: profile.scope, actor: actor.id, operation, input });
    if (profile.lastMutation === request) return profile;
    if (profile.revision !== input.expectedRevision) throw new Error('Personal preferences changed in another session. Reload them before saving.');
    const changed = update(profile, actor.id);
    if (changed === profile) return profile;
    const next = profileSchema.parse({ ...changed, revision: profile.revision + 1, updatedAt: new Date().toISOString(), updatedBy: actor.id, lastMutation: request });
    // Recheck the containing path immediately before the atomic write.
    atomicJson(contained(root, 'config/personal-profile.json'), next);
    return next;
  } finally { unlock(); }
}

export function savePersonalProfile(root: string, data: unknown): PersonalProfile {
  const input = saveSchema.parse(data);
  return mutate(root, 'save', input, profile => ({ ...profile, enabled: input.enabled, about: input.about, explanation: input.explanation, detail: input.detail }));
}

/** Saving a note selects a fixed reminder; it does not approve the note as evidence or train a model. */
export function recordPersonalCorrection(root: string, data: unknown): PersonalProfile {
  const input = recordSchema.parse(data);
  return mutate(root, 'record', input, (profile, actor) => {
    const id = digest({ scope: profile.scope, actor, requestId: input.requestId });
    const prior = profile.corrections.find(row => row.id === id);
    if (prior) {
      if (prior.category !== input.category || prior.note !== input.note) throw new Error('This correction request was already used for different text. Submit a new correction request.');
      return profile;
    }
    if (profile.corrections.length >= MAX_PERSONAL_CORRECTIONS) throw new Error(`At most ${MAX_PERSONAL_CORRECTIONS} corrections can be remembered. Forget an older correction before adding another.`);
    return { ...profile, corrections: [...profile.corrections, { id, category: input.category, note: input.note, createdAt: new Date().toISOString(), createdBy: actor }] };
  });
}

export function forgetPersonalCorrection(root: string, data: unknown): PersonalProfile {
  const input = forgetSchema.parse(data);
  return mutate(root, 'forget', input, profile => {
    if (!profile.corrections.some(row => row.id === input.id)) throw new Error('This correction is no longer saved. Reload your personal preferences.');
    return { ...profile, corrections: profile.corrections.filter(row => row.id !== input.id) };
  });
}

/** Remove the profile and all notes from current configuration; historical packages are untouched. */
export function clearPersonalProfile(root: string, data: unknown): PersonalProfile {
  const input = clearSchema.parse(data);
  return mutate(root, 'clear', input, profile => emptyProfile(profile.scope));
}

const EXPLANATION_GUIDANCE: Record<Exclude<PersonalProfile['explanation'], ''>, string> = {
  plain: 'Use familiar language and briefly explain technical terms that the current story requires.',
  balanced: 'Use clear language with enough technical context to explain the current story accurately.',
  technical: 'Use precise technical language where it helps explain the current story; preserve all qualifications.',
};
const DETAIL_GUIDANCE: Record<Exclude<PersonalProfile['detail'], ''>, string> = {
  brief: 'Favor direct sentences and the most useful supported details within the selected output word range.',
  balanced: 'Balance the main development with its supported context within the selected output word range.',
  detailed: 'Explain relevant supported detail within the selected output word range without repetition or padding.',
};

/** No personal background or free-text correction crosses this trust boundary. */
export function personalWritingGuidance(value: PersonalProfile): string {
  const profile = profileSchema.parse(value);
  if (!profile.enabled) return '';
  const lines: string[] = [];
  if (profile.explanation) lines.push(EXPLANATION_GUIDANCE[profile.explanation]);
  if (profile.detail) lines.push(DETAIL_GUIDANCE[profile.detail]);
  const selected = new Set(profile.corrections.map(row => row.category));
  for (const category of PERSONAL_CORRECTION_CATEGORIES) if (selected.has(category.id)) lines.push(category.guidance);
  if (!lines.length) return '';
  const guidance = `Optional publication guidance v${PERSONAL_GUIDANCE_VERSION}; current brief, complete evidence, selected word ranges, tool limits and approval rules remain authoritative. These reminders do not establish factual correctness.\n${lines.join('\n')}`;
  if (Buffer.byteLength(guidance) > MAX_PERSONAL_GUIDANCE_BYTES) throw new Error('Personal writing guidance exceeds its bounded context');
  return guidance;
}
