/** Retain unreviewed authored SVGs independently of source and phone acceptance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DiagramText } from './diagram-source-support.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface DiagramCandidateBinding { parentIdentity: string; writerKey: string; scriptHash: string; sourceCaptureHash: string; promptHash: string; story: number }
export interface DiagramCandidateStore { directory: string; parentIdentity: string; writerKey: string; scriptHash: string; sourceCaptureHash: string }
function pathFor(directory: string, binding: DiagramCandidateBinding): string {
  assert.ok(binding.writerKey && Number.isSafeInteger(binding.story) && binding.story > 0 && binding.story <= 12, 'Complete diagram writer/story binding required');
  for (const key of ['parentIdentity', 'scriptHash', 'sourceCaptureHash', 'promptHash'] as const) assert.match(binding[key], /^[a-f0-9]{64}$/);
  const base = realpathSync(directory), folder = join(base, 'diagram-authored-candidates');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const rel = relative(base, realpathSync(folder));
  assert.ok(rel && !rel.startsWith('..') && !lstatSync(folder).isSymbolicLink(), 'Authored diagram directory escaped its package');
  return join(folder, `${hash(binding)}.json`);
}
export function readAuthoredDiagramCandidate(directory: string, binding: DiagramCandidateBinding): DiagramText | null {
  const path = pathFor(directory, binding); if (!existsSync(path)) return null;
  const base = realpathSync(directory), physical = realpathSync(path), rel = relative(base, physical);
  assert.ok(rel && !rel.startsWith('..') && !lstatSync(path).isSymbolicLink(), 'Authored diagram candidate escaped its package');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const { hash: recordedHash, ...body } = record;
  assert.equal(recordedHash, hash(body), 'Unreviewed authored diagram candidate changed');
  assert.equal(record.version, 1); assert.equal(record.status, 'unreviewed'); assert.equal(hash(record.binding), hash(binding), 'Authored diagram belongs to different script, source, writer or parent');
  assert.equal(Object.keys(record.diagram).sort().join(','), 'label,legend,reading,svg', 'Candidate cache cannot carry factual or phone approval');
  return structuredClone(record.diagram) as DiagramText;
}
export function saveAuthoredDiagramCandidate(directory: string, binding: DiagramCandidateBinding, diagram: DiagramText): void {
  const candidate = { svg: diagram.svg, label: diagram.label, reading: diagram.reading, legend: structuredClone(diagram.legend) };
  const path = pathFor(directory, binding), old = readAuthoredDiagramCandidate(directory, binding);
  if (old) { assert.equal(hash(old), hash(candidate), 'Never replace a retained authored diagram candidate'); return; }
  const body = { version: 1, status: 'unreviewed', createdAt: new Date().toISOString(), binding: structuredClone(binding), diagram: candidate };
  writeFileSync(path, JSON.stringify({ ...body, hash: hash(body) }, null, 2), { flag: 'wx', mode: 0o600 });
}
