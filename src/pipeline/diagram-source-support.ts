import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { ensureSourceSupportedFields, FIELD_SUPPORT_VERSION, type AuthoredField, type FieldSupportCall } from './field-support.js';
import { createSourceSupportContext, SOURCE_SUPPORT_VERSION, type SourceSupportContext } from './source-support.js';
import { preparedModelTask, type PreparedModelTask } from './writing-task.js';

export const DIAGRAM_SOURCE_SUPPORT_VERSION = 1;
export interface DiagramText { svg: string; label: string; reading: string; legend: { kind: string; label: string }[] }
export interface DiagramSourceReceipt { version: 1; hash: string; reviewedFields: string[] }
export interface DiagramReviewEvidence { version: 1; observedAt: string; stage: 'review-response' | 'repair-blocked'; diagramHash: string; evidenceHash: string; task: PreparedModelTask; prompt: string; promptHash: string; response: unknown; responseHash: string; fields: AuthoredField[]; claims: string[]; sourceContext: SourceSupportContext }
export interface DiagramReviewOptions { saveEvidence(record: DiagramReviewEvidence): void | Promise<void> }
export interface DiagramEvidence { claims: readonly string[]; sourceContext: SourceSupportContext; writerKey: string; presentation: unknown }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** All accessible and visible authored text is code-enumerated. No XML or geometry is rewritten. */
export function diagramAuthoredFields(diagram: DiagramText): AuthoredField[] {
  if (!diagram || typeof diagram.svg !== 'string' || diagram.svg.length > 64000 || typeof diagram.label !== 'string' || typeof diagram.reading !== 'string'
    || !Array.isArray(diagram.legend) || diagram.legend.length > 8 || diagram.legend.some(row => !row || !['source', 'change', 'route', 'result', 'muted'].includes(row.kind) || typeof row.label !== 'string')) throw new Error('Diagram needs bounded complete SVG and legend text');
  const $ = load(diagram.svg, { xmlMode: true });
  if ($('text').length > 14) throw new Error('Diagram source review allows at most 14 complete text elements');
  const fields: AuthoredField[] = [{ id: 'label', text: diagram.label }, { id: 'reading', text: diagram.reading },
    ...diagram.legend.map((row, i) => ({ id: `legend.${i + 1}`, text: row.label }))];
  for (const tag of ['title', 'desc', 'text']) $(tag).each((i, node) => { fields.push({ id: `svg.${tag}.${i + 1}`, text: $(node).text() }); });
  $('[aria-label]').each((i, node) => { fields.push({ id: `svg.aria.${i + 1}`, text: $(node).attr('aria-label')! }); });
  if (fields.length > 32 || fields.some(field => !field.text.trim() || field.text.length > 2000 || /[<>\x00-\x08]|https?:\/\/|www\./i.test(field.text))
    || fields.reduce((n, field) => n + field.text.length, 0) > 6000) throw new Error('Diagram source review needs every complete plain field within 32 fields and 6000 characters; no text may be clipped');
  return fields;
}

export function diagramSourceReceipt(diagram: DiagramText, evidence: DiagramEvidence): DiagramSourceReceipt {
  const fields = diagramAuthoredFields(diagram);
  const context = createSourceSupportContext(evidence.sourceContext.editionDay, evidence.sourceContext.primaryUrl, evidence.sourceContext.sources);
  return { version: 1, hash: hash({ version: DIAGRAM_SOURCE_SUPPORT_VERSION, source: SOURCE_SUPPORT_VERSION, field: FIELD_SUPPORT_VERSION,
    diagram: { svg: diagram.svg, label: diagram.label, reading: diagram.reading, legend: diagram.legend }, evidence: { ...evidence, sourceContext: context } }), reviewedFields: fields.map(field => field.id) };
}
export function hasDiagramSourceReceipt(diagram: DiagramText, evidence: DiagramEvidence, receipt: DiagramSourceReceipt | undefined): boolean {
  return !!receipt && hash(receipt) === hash(diagramSourceReceipt(diagram, evidence));
}

/** At most three review tasks (12 fields per batch), with all other fields visible as context.
 * A failed review stops this artwork. No repair, fallback, source substitution or geometry edit.
 * The caller must reserve every physical attempt under the original package parent. */
export async function reviewDiagramSource(diagram: DiagramText, evidence: DiagramEvidence, call: FieldSupportCall,
  task: PreparedModelTask, options?: DiagramReviewOptions): Promise<DiagramSourceReceipt> {
  evidence = structuredClone(evidence); task = structuredClone(task);
  const fields = diagramAuthoredFields(diagram), before = JSON.stringify(diagram);
  const sourceContext = createSourceSupportContext(evidence.sourceContext.editionDay, evidence.sourceContext.primaryUrl, evidence.sourceContext.sources);
  for (let offset = 0; offset < fields.length; offset += 12) {
    const batch = fields.slice(offset, offset + 12);
    await ensureSourceSupportedFields(batch, evidence.claims, async (prompt, validate, descriptor) => {
      if (!descriptor) throw new Error('Diagram review requires its exact prepared task');
      const persist = async (stage: DiagramReviewEvidence['stage'], response: unknown) => {
        const retained = structuredClone(response);
        await options?.saveEvidence({ version: 1, observedAt: new Date().toISOString(), stage, diagramHash: hash(diagram), evidenceHash: hash(evidence), task: structuredClone(descriptor),
          prompt, promptHash: createHash('sha256').update(prompt).digest('hex'), response: retained, responseHash: hash(retained), fields: structuredClone(fields), claims: [...evidence.claims], sourceContext: structuredClone(sourceContext) });
      };
      if (descriptor.role !== 'source-review') {
        // The helper has not called a repair model. Retain the exact rejected rows before
        // refusing a text-only repair that would leave the original SVG inconsistent.
        const flagged = JSON.parse(prompt.match(/^FLAGGED_FIELDS: (.*)$/m)?.[1] ?? '[]') as { id: string; reason: string }[];
        await persist('repair-blocked', { flagged });
        throw new Error(`Diagram source text did not pass review: ${flagged.map(row => `${row.id}: ${row.reason}`).join('; ') || 'review details unavailable'}. Original artwork and review evidence are retained.`);
      }
      const response = await call(prompt, validate, descriptor);
      // Save the raw returned rows before field validation/dispute reconciliation can mutate them.
      await persist('review-response', response);
      return response;
    }, { task: preparedModelTask({ role: 'source-review', capability: 'source-review', taskId: `${task.taskId}-diagram-fields-${offset + 1}`,
      topicIds: task.topicIds, protocol: { version: DIAGRAM_SOURCE_SUPPORT_VERSION }, evidence: { original: task.evidenceHash, ...evidence }, candidate: fields }),
      sourceContext, context: { presentation: evidence.presentation, allDiagramFields: fields, legend: diagram.legend },
      validateFinal: candidate => JSON.stringify(candidate) === JSON.stringify(batch) ? null : 'Diagram source review cannot edit text or geometry',
    });
  }
  if (JSON.stringify(diagram) !== before) throw new Error('Diagram changed during source review');
  return diagramSourceReceipt(diagram, evidence);
}
