import type { Command } from 'commander';
import { authorize, activeRoot, contained, read, safeId } from '../workspaces.js';
import { withPublicationMemory, memoryPublicationId, checkStoryCoverage } from './runtime.js';
import type { MemoryKind } from './types.js';
import type { Topic } from '../types.js';

export function registerMemoryCommands(program: Command): void {
  const memory = program.command('memory').description('Inspect publication memory and explicitly review corrections');
  memory.command('status').description('Show this publication’s active memory and recent delivery states').action(async () => {
    authorize('read');
    const result = await withPublicationMemory(async store => ({ publicationId: store.scope.publicationId,
      active: (await store.recall({ kinds: ['working', 'semantic', 'episodic', 'procedural'], now: Date.now(), limit: 50, maxBytes: 65536 })).map(row => ({ key: row.key, kind: row.kind, revision: row.revision, expiresAt: row.expiresAt })),
      coverage: await store.coverage({ since: Date.now() - 30 * 86400000, limit: 100 }) }));
    console.log(JSON.stringify(result, null, 2));
  });
  memory.command('get <key>').description('Inspect one scoped memory, including a proposed correction').action(async (key: string) => {
    authorize('read'); console.log(JSON.stringify(await withPublicationMemory(store => store.getMemory(key)), null, 2));
  });
  memory.command('explain <runId>').description('Explain which prepared stories match verified published events, without a model call').action(async (runId: string) => {
    authorize('read'); safeId(runId);
    const topic = read<Topic | null>(contained(activeRoot(), 'workdir/videos', runId, 'topic.json'), null);
    if (topic?.id !== runId || !topic.stories?.length) throw new Error('This edition has no exact prepared story packet to compare');
    console.log(JSON.stringify(await checkStoryCoverage(topic.stories, runId), null, 2));
  });
  memory.command('propose <key>').description('Save a correction for review; it does not change live writing policy')
    .requiredOption('--text <text>', 'complete correction text')
    .requiredOption('--evidence <reference>', 'source, incident or regression reference')
    .option('--kind <kind>', 'semantic, episodic or procedural', 'episodic')
    .action(async (key: string, options: { text: string; evidence: string; kind: MemoryKind }) => {
      authorize('manage');
      if (!['semantic', 'episodic', 'procedural'].includes(options.kind)) throw new Error('Use semantic, episodic or procedural memory');
      const now = Date.now();
      const record = await withPublicationMemory(async store => {
        const prior = await store.getMemory(key);
        return store.putMemory({ key, text: options.text, kind: options.kind, status: 'proposed', expectedRevision: prior?.revision ?? null, evidenceRefs: [options.evidence], tags: ['publication-writing'], effectiveAt: now, expiresAt: now + 30 * 86400000 }, now);
      });
      console.log(`Saved proposed correction ${record.key}, revision ${record.revision}. It is not used in writing until reviewed.`);
    });
  memory.command('approve <key>').description('Approve a tested correction for future editions')
    .requiredOption('--verification <reference>', 'the reviewed test or source verification')
    .option('--expires-in-days <days>', 'recheck this guidance after 1–365 days', '30')
    .action(async (key: string, options: { verification: string; expiresInDays: string }) => {
      authorize('manage'); const now = Date.now();
      const days = Number(options.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Approved guidance needs an expiry of 1–365 days');
      await withPublicationMemory(async store => {
        const prior = await store.getMemory(key); if (!prior || prior.status !== 'proposed') throw new Error('Only a proposed correction can be approved');
        const { revision, createdAt: _created, approvedBy: _approver, ...record } = prior;
        await store.putMemory({ ...record, expectedRevision: revision, status: 'approved', effectiveAt: now, expiresAt: now + days * 86400000, verificationRef: options.verification }, now);
      });
      console.log(`Approved ${key} for future editions. Existing editions keep their pinned memory.`);
    });
  memory.command('retire <key>').description('Stop using a memory in future editions while retaining its audit revision').action(async (key: string) => {
    authorize('manage'); const now = Date.now();
    await withPublicationMemory(async store => {
      const prior = await store.getMemory(key); if (!prior) throw new Error('Memory not found');
      const { revision, createdAt: _created, approvedBy: _approver, ...record } = prior;
      await store.putMemory({ ...record, expectedRevision: revision, status: 'retired', effectiveAt: now, expiresAt: now + 30 * 86400000 }, now);
    });
    console.log(`Retired ${key}; future retrieval excludes it.`);
  });
  memory.command('maintain').description('Expire eligible memory records while preserving referenced evidence').action(async () => {
    authorize('manage'); console.log(JSON.stringify(await withPublicationMemory(store => store.maintain(Date.now())), null, 2));
  });
  memory.command('clear <publicationId>').description('Delete this publication’s memory database records; publication files and settings stay separate').action(async (publicationId: string) => {
    authorize('manage');
    if (publicationId !== memoryPublicationId(activeRoot())) throw new Error('Supply this workspace’s exact publication ID');
    await withPublicationMemory(store => store.deleteScope());
    console.log('Publication memory records deleted. Publication files, saved settings and backups require their separate retention controls.');
  });
}
