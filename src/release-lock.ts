import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { activeRoot, contained } from "./workspaces.js";
const held = new Map<string, number>();
/** Brief synchronous wait for worker-only bookkeeping critical sections, never a UI request.
 * A busy owner or a lock disappearing during containment/recovery is retriable; invalid locks are not.
 * Reservations stay fail-closed if the owner does not finish within the bounded wait.
 */
export function waitForReleaseLock(root: string, name: string, waitMs = 1000): () => void {
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 1000) throw new Error('Lock wait must be 1–1000 milliseconds');
  const deadline = Date.now() + waitMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return releaseLock(root, name); }
    catch (error) {
      const transient = error instanceof Error && (/^Busy:/.test(error.message) || (error as NodeJS.ErrnoException).code === 'ENOENT');
      const remaining = deadline - Date.now();
      if (!transient || remaining <= 0) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(10, remaining));
    }
  }
}
export function releaseLock(root = activeRoot(), name = "release"): () => void {
  const path = contained(root, "state", `.${name}.lock`);
  if (held.has(path)) { held.set(path, held.get(path)! + 1); return () => held.set(path, held.get(path)! - 1); }
  mkdirSync(join(root, "state"), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd); held.set(path, 1);
      return () => { held.delete(path); try { if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) unlinkSync(path); } catch { /* lock already removed */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize recovery and re-read the owner: a competing recovery must never delete a fresh lock.
      const recovery = `${path}.recovery`;
      let recoveryFd: number;
      try { recoveryFd = openSync(recovery, "wx", 0o600); }
      catch { throw new Error("Busy: lock recovery in progress; inspect a persistent .recovery file before removing it"); }
      try {
        let pid: number;
        try { pid = JSON.parse(readFileSync(path, "utf8")).pid; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("Busy: release lock is being acquired"); }
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid release lock; inspect it before removal");
        try { process.kill(pid, 0); throw new Error("Busy: another release action is running"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
        unlinkSync(path);
      } finally { closeSync(recoveryFd); unlinkSync(recovery); }
    }
  }
  throw new Error("Busy: another release action is running");
}
