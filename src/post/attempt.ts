/** A pending attempt is a hold, never a success receipt. meta.posts alone records completion. */
import { existsSync, openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safeId } from "../workspaces.js";
const pathFor = (dir: string, platform: string) => join(dir, `.delivery-${safeId(platform)}.json`);
/** Human-readable compound labels can exceed identifier limits; the complete label owns this key. */
export function scopedAttemptKey(kind: string, identity: string): string {
  if (!kind || !identity || kind.length > 100 || identity.length > 1000) throw new Error('Invalid delivery attempt identity');
  return `attempt-${createHash('sha256').update(JSON.stringify({ kind, identity })).digest('hex')}`;
}
export function pendingAttempt(dir: string, platform: string): boolean { return existsSync(pathFor(dir, platform)); }
export function beginAttempt(dir: string, platform: string): string {
  if (pendingAttempt(dir, platform)) throw new Error("Unresolved delivery attempt: independently check the destination before retrying");
  const id = randomUUID();
  const fd = openSync(pathFor(dir, platform), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ id, platform, pid: process.pid, startedAt: new Date().toISOString() })); } finally { closeSync(fd); }
  return id;
}
/** Must not throw after a provider receipt has been written. */
export function finishAttempt(dir: string, platform: string): void { try { unlinkSync(pathFor(dir, platform)); } catch { /* existing receipt still prevents reposting */ } }
/** Only provider code which knows publication has not begun may create this error. */
export class NotSubmittedError extends Error { constructor(error: unknown) { super(error instanceof Error ? error.message : String(error), { cause: error }); this.name = "NotSubmittedError"; } }
export function certainlyNotSubmitted(error: unknown): boolean { return error instanceof NotSubmittedError; }
/** Definite provider refusals permit retry; conflicts, timeouts and duplicate replies do not. */
export function submissionFailure(status: number, error: Error): Error {
  return [400,401,402,403,404,405,413,415,422,429].includes(status) && !/duplicate|already.exists/i.test(error.message) ? new NotSubmittedError(error) : error;
}
