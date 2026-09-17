import { registerManagedChild } from '../managed-process.js';
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import TOML from "@iarna/toml";
import { portableCommand } from "../platform.js";
import type { ModelRuntime } from "./model.js";
import type { JsonOutputContract, JsonOutputSchema } from './json-output-contract.js';

/** Codex strict output requires every object property to be required. Preserve the
 * original contract; schemas with optional fields retain the explicit prompt mode.
 * Never change field semantics or downgrade after a rejected native request.
 */
export function codexNativeSchema(contract?: JsonOutputContract): JsonOutputSchema | undefined {
  if (!contract?.strict) return undefined;
  const compatible = (schema: JsonOutputSchema, depth: number): boolean => depth <= 10
    && (!schema.properties || Object.keys(schema.properties).every(key => schema.required?.includes(key))
      && Object.values(schema.properties).every(child => compatible(child, depth + 1)))
    && (!schema.items || compatible(schema.items, depth + 1));
  return compatible(contract.schema, 0) ? contract.schema : undefined;
}

/** Resolve the same saved default used by the subscription CLI before parent/receipt binding. */
export function configuredCodexModel(requested?: string): string | undefined {
  if (requested?.trim()) return requested.trim();
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  const saved = existsSync(path) ? TOML.parse(readFileSync(path, "utf8")) : {};
  return typeof saved.model === "string" && saved.model.trim() ? saved.model.trim() : undefined;
}

/** Subscription writer: no inherited plugins, hooks, workspace instructions or executable tools. */
export async function codexText(prompt: string, runtime: ModelRuntime, images: string[] = [], webSearch = false, contract?: JsonOutputContract): Promise<{ text: string; model?: string; usage: unknown }> {
  const configFile = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  const saved = existsSync(configFile) ? TOML.parse(readFileSync(configFile, "utf8")) : {};
  const model = configuredCodexModel(runtime.model);
  const overrides = [
    'approval_policy="never"', 'forced_login_method="chatgpt"', webSearch ? 'web_search="live"' : 'web_search="disabled"',
    'project_doc_max_bytes=0', 'skills.include_instructions=false',
    ...["shell_tool", "apps", "plugins", "hooks", "multi_agent", "multi_agent_v2", "browser_use", "computer_use", "image_generation", "view_image"].map(name => `features.${name}=false`),
  ];
  // Retain model/auth preferences only; loading the complete user config would reconnect their tools.
  for (const key of ["model_reasoning_effort", "service_tier", "cli_auth_credentials_store"]) {
    if (typeof saved[key] === "string") overrides.push(`${key}=${JSON.stringify(saved[key])}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "harness-writer-")), output = join(dir, "answer.txt");
  try {
    const schema = codexNativeSchema(contract), schemaPath = join(dir, 'output-schema.json');
    if (schema) writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    const spec = portableCommand(runtime.command || "codex", ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", dir, "--color", "never", "--json", "--output-last-message", output,
      ...(schema ? ['--output-schema', schemaPath] : []), ...overrides.flatMap(value => ["-c", value]), ...(model ? ["--model", model] : []), ...images.flatMap(file => ["--image", resolve(file)]), "-"]);
    const env = { ...process.env };
    delete env.CODEX_API_KEY; delete env.OPENAI_API_KEY;
    return await new Promise((resolveResult, reject) => {
      const child = spawn(spec.command, spec.args, { cwd: dir, env, detached: process.platform !== "win32" });
      let terminationError: Error | undefined;
      const unregisterManaged = registerManagedChild(child, { detached: process.platform !== 'win32', onTerminate: error => { terminationError = error; } });
      child.once('close', unregisterManaged); child.once('error', unregisterManaged);
      let stderr = "", pending = "", usage: unknown = null, timedOut = false;
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          killer.on("error", () => { child.kill("SIGKILL"); });
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group already exited. */ } }
      };
      const timer = setTimeout(() => {
        timedOut = true; stop(); child.stdout.destroy(); child.stderr.destroy();
        reject(new Error(`Codex CLI timed out after ${runtime.timeoutMs / 1000}s`));
      }, runtime.timeoutMs);
      child.stdout.on("data", data => {
        pending += String(data);
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try { const event = JSON.parse(line); if (event.type === "turn.completed") usage = event.usage; } catch { /* Chatter is never the answer. */ }
        }
      });
      child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
      child.on("error", error => { clearTimeout(timer); reject(new Error(`Codex CLI could not start: ${error.message}. Install Codex and run codex login.`)); });
      child.on("close", code => {
        clearTimeout(timer);
        if (terminationError) return reject(terminationError);
        if (timedOut) return;
        if (code !== 0) return reject(new Error(`Codex CLI exit ${code}: ${stderr.trim().slice(-500) || "Run codex login, then check the writer again."}`));
        try {
          const text = existsSync(output) ? readFileSync(output, "utf8").trim() : "";
          if (!text) throw new Error("Codex CLI returned no final message");
          resolveResult({ text, model, usage });
        } catch (error) { reject(error); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  } finally {
    // Windows keeps the launcher's working directory open for a moment after taskkill; on CI that made the
    // cleanup throw EPERM and REPLACE the real "timed out" error (every windows-latest run since 2026-09-09).
    // Retry briefly, then give up: a leftover temp folder never outranks the result or the error.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left for the OS temp cleaner */ }
  }
}
