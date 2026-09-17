# Publication memory

Each workspace keeps its publication preferences and starts each edition with fresh topics, sources and draft progress. Reopening an edition resumes its exact saved request. It does not inherit another edition's working topics or refill its original time and model allowance.

A shared company, buzzword or website does not make two articles the same story. The harness compares complete source-backed event packets with verified published history. A confirmed matching event can hold the preview and explain the earlier edition. Different events, material developments and uncertain matches remain eligible. Incomplete historical records do not become automatic exclusions.

Memory uses local SQLite under `state/memory/memory.sqlite`, separated by the authenticated workspace and publication. Node.js 22.13 or newer is required. There is no required memory subscription, vector database or hosted model. Filesystem access remains the local trust boundary; do not expose the local server to the internet.

## Inspect and correct

The operator commands run in the chosen workspace:

```sh
npx tsx src/cli.ts memory status
npx tsx src/cli.ts memory explain EDITION_ID
npx tsx src/cli.ts memory get MEMORY_KEY
npx tsx src/cli.ts memory propose lesson-key --text "Complete process guidance" --evidence "Reviewed incident reference"
npx tsx src/cli.ts memory approve lesson-key --verification "Regression or reviewed source reference" --expires-in-days 30
npx tsx src/cli.ts memory retire lesson-key
npx tsx src/cli.ts memory maintain
```

A correction is proposed until an authorized operator approves it. Only applicable, approved, unexpired process lessons enter later writing tasks, within a small fixed allowance. They do not add story facts, grant tools, remove source conditions, authorize publication or rewrite executable rules. Existing editions keep their pinned context; expired optional guidance is omitted whole.

`memory clear PUBLICATION_ID` deletes this publication's memory database records. It does not delete publication files, saved settings, queued work or backups. Routine maintenance preserves referenced records and unresolved submissions; it does not promise physical disk erasure.

## Publication and hosted services

This Free evaluation still disables external publication. The source includes durable reservation and receipt controls for deployments that later enable it. Drafts and ambiguous submissions are not published history. A title/profile match cannot establish that a newly approved story was delivered; confirmation requires the exact package and matching accepted receipt. Legacy posts need reviewed reconciliation.

The PostgreSQL adapter and forced-row-security migration are included for developers. A hosted application must supply its authenticated scope and pool and pass deployment-specific authentication, concurrent-worker, backup/restore and deletion checks. Embedded database tests do not qualify a hosted Pro service. Model accuracy and newsletter quality also require their own real-output evaluation.

These correctness features are part of the MIT source. They do not require Pro activation.

## Optional personal guidance

The [personal preferences panel](personal-preferences.md) stores publication-scoped background and raw correction notes separately from model guidance. Only enum-generated style and fixed correction reminders join the bounded, pinned memory context. The current brief and complete source packet remain authoritative; a profile location cannot create news topics. `memory clear` clears memory database records, not this optional profile or shared agent files. Use the panel’s explicit removal and deletion actions for those copies.
