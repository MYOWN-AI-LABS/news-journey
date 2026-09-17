import { registerManagedChild } from '../managed-process.js';
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { activeRoot, atomicJson, contained } from "../workspaces.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableCommand } from "../platform.js";
import type { ModelRuntime } from "./model.js";

export const ANTIGRAVITY_CLI_TRANSPORT_VERSION = 1;
export class AntigravityCliFailure extends Error {
  constructor(message: string, readonly receiptPath?: string) { super(message); this.name = 'AntigravityCliFailure'; }
}
function retainFailure(prompt: string, runtime: ModelRuntime, stdout: string, stderr: string, code: number | null, problem: string): AntigravityCliFailure {
  const snapshot = (text: string) => { const bytes = Buffer.from(text); return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.subarray(0, 262144).toString('utf8'), truncated: bytes.length > 262144 }; };
  try {
    const directory = contained(activeRoot(), 'state/model-output-failures'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = contained(directory, `${randomUUID()}.json`);
    atomicJson(path, { version: 1, transportVersion: ANTIGRAVITY_CLI_TRANSPORT_VERSION, kind: 'antigravity-cli-transport', observedAt: new Date().toISOString(), provider: 'antigravity', model: runtime.model ?? null,
      prompt: { bytes: Buffer.byteLength(prompt), sha256: createHash('sha256').update(prompt).digest('hex') }, exitCode: code, stdout: snapshot(stdout), stderr: snapshot(stderr), problem: problem.slice(0, 4000) });
    return new AntigravityCliFailure(problem, path);
  } catch { return new AntigravityCliFailure(`${problem}; private transport diagnostic could not be saved`); }
}
/**
 * Antigravity's `--effort` accepts low, medium or high; the harness's "none" and "max" map to the nearest. A model id
 * that already carries its effort (gemini-3.6-flash-high) refuses a separate `--effort` ("conflicts", measured), so
 * the flag is only sent for a bare model name.
 */
export function antigravityEffort(effort: ModelRuntime["reasoningEffort"], model?: string): 'low' | 'medium' | 'high' | undefined {
  if (!effort || /-(?:low|medium|high)$/.test(model ?? '')) return undefined;
  return effort === 'none' || effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}
/**
 * Google Antigravity's `agy` CLI as a subscription writer: one prompt in print mode, terminal JSON, no images (print mode
 * takes text only), run in an empty scratch directory with slash-command expansion off and the sandbox on so the agent's
 * file and terminal tools have nothing to reach. The account login lives in the CLI's own configuration (~/.gemini).
 */
export async function antigravityText(prompt: string, runtime: ModelRuntime, images: string[] = []): Promise<{ text: string; usage: unknown }> {
  if (!prompt.trim()) throw new Error("Antigravity CLI needs a nonempty prompt");
  if (images.length) throw new Error("Antigravity CLI print mode takes text only; choose a writer that can look at images for photo checks");
  const dir = mkdtempSync(join(tmpdir(), "harness-antigravity-writer-"));
  try {
    const seconds = Math.max(1, Math.ceil(runtime.timeoutMs / 1000));
    const effort = antigravityEffort(runtime.reasoningEffort, runtime.model);
    // `-p` takes the prompt as the next argument; anything else after it would be read as the prompt.
    const args = ["-p", prompt, "--output-format", "json", "--disable-slash-commands", "--sandbox", "--print-timeout", `${seconds}s`, ...(runtime.model ? ["--model", runtime.model] : []), ...(effort ? ["--effort", effort] : [])];
    const spec = portableCommand(runtime.command || "agy", args);
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY; delete env.AI_CONTENT_MODEL_API_KEY;
    return await new Promise((resolveResult, reject) => {
      const child = spawn(spec.command, spec.args, { cwd: dir, env, detached: process.platform !== "win32" });
      let terminationError: Error | undefined;
      const unregisterManaged = registerManagedChild(child, { detached: process.platform !== 'win32', onTerminate: error => { terminationError = error; } });
      child.once('close', unregisterManaged); child.once('error', unregisterManaged);
      let stdout = "", stderr = "", timedOut = false, settled = false;
      const fail = (problem: string, code: number | null = null) => { if (settled) return; settled = true; reject(retainFailure(prompt, runtime, stdout, stderr, code, problem)); };
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === "win32") { const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); killer.on("error", () => { child.kill("SIGKILL"); }); }
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
      };
      const timer = setTimeout(() => { timedOut = true; stop(); child.stdout.destroy(); child.stderr.destroy(); fail(`Antigravity CLI timed out after ${runtime.timeoutMs / 1000}s`); }, runtime.timeoutMs);
      const bounded = (current: string, data: Buffer, label: string) => {
        if (Buffer.byteLength(current) + data.length > 2_097_152) { clearTimeout(timer); stop(); child.stdout.destroy(); child.stderr.destroy(); fail(`Antigravity CLI ${label} exceeded 2 MiB`); return current; }
        return current + data;
      };
      child.stdout.on("data", data => { stdout = bounded(stdout, data, "output"); });
      child.stderr.on("data", data => { stderr = bounded(stderr, data, "stderr"); });
      child.on("error", error => { clearTimeout(timer); fail(`Antigravity CLI could not start: ${error.message}. Install Antigravity (agy) and sign in.`); });
      child.on("close", code => {
        clearTimeout(timer);
        if (terminationError) return fail(terminationError.message, code);
        if (timedOut || settled) return;
        if (code !== 0) return fail(`Antigravity CLI exit ${code}: ${(stderr.trim() || stdout.trim() || "No error detail returned").slice(-500)}`, code);
        // Print mode ends with one JSON object: { status, response, usage: { input_tokens, output_tokens, thinking_tokens, total_tokens }, num_turns }.
        let result: { status?: unknown; response?: unknown; usage?: Record<string, unknown> | null; num_turns?: unknown };
        try { result = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch { return fail('Antigravity CLI did not return its terminal JSON result', code); }
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.status !== 'SUCCESS' || typeof result.response !== 'string' || !result.response.trim()) return fail(`Antigravity CLI did not complete one direct response (status ${String(result?.status)})`, code);
        if (result.num_turns !== undefined && result.num_turns !== 1) return fail('Antigravity CLI reported turns outside the one reserved round', code);
        const u = result.usage ?? null;
        const usage = u && typeof u === 'object' ? { prompt_tokens: u.input_tokens ?? null, completion_tokens: u.output_tokens ?? null, thinking_tokens: u.thinking_tokens ?? null, total_tokens: u.total_tokens ?? null } : null;
        settled = true;
        resolveResult({ text: result.response.trim(), usage });
      });
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* OS temp cleanup */ }
  }
}
