export interface DevelopmentOutcome {
  status: 'complete' | 'failed';
  startedAt: string;
  finishedAt: string;
  error?: string;
}

/** Independent outputs share prepared evidence and the caller's original model budget.
 * A failed branch cannot cancel its siblings or mark them complete. Actual model admission
 * remains in the dispatcher (including the existing per-host queue for local models).
 * Checkpoints and source/output receipts belong to each branch, never this status helper. */
export async function runIndependentDevelopment<K extends string>(
  tasks: Record<K, () => Promise<unknown>>,
  save?: (name: K, outcome: DevelopmentOutcome) => void,
): Promise<Record<K, DevelopmentOutcome>> {
  const entries = Object.entries(tasks) as [K, () => Promise<unknown>][];
  const outcomes = {} as Record<K, DevelopmentOutcome>;
  await Promise.all(entries.map(async ([name, task]) => {
    const startedAt = new Date().toISOString();
    let outcome: DevelopmentOutcome;
    try {
      await task();
      outcome = { status: 'complete', startedAt, finishedAt: new Date().toISOString() };
    } catch (error) {
      outcome = { status: 'failed', startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    }
    outcomes[name] = outcome;
    // A receipt-write error also fails this branch, but every sibling is still awaited.
    try { save?.(name, { ...outcome }); }
    catch (error) {
      outcomes[name] = { ...outcome, status: 'failed', error: `${outcome.error ? outcome.error + '; ' : ''}Development status could not be saved: ${error instanceof Error ? error.message : String(error)}` };
    }
  }));
  return outcomes;
}
