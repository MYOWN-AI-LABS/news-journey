import { execFile } from "node:child_process";
import { log } from "../util.js";

export function notify(title: string, message: string): void {
  if (process.platform !== "darwin") {
    log(`[notification] ${title}: ${message}`);
    return;
  }
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) log(`notification failed: ${err.message}`);
  });
}

export function notifyDraftReady(id: string, headline: string): void {
  notify("AI Content Engine", `Draft ready: ${headline} — npm run preview ${id}`);
}
