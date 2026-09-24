import { registerManagedChild } from '../managed-process.js';
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { activeRoot, atomicJson, contained } from "../workspaces.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portableCommand } from "../platform.js";
import type { ModelRuntime } from "./model.js";

function grokEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "GROK_HOME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Child-only feature restrictions; keep the user's account/home and global
  // configuration untouched. Headless does not forward every UI feature flag.
  env.GROK_SUBAGENTS = '0';
  env.GROK_WORKFLOWS = '0';
  env.GROK_CLAUDE_MCPS_ENABLED = '0';
  env.GROK_CURSOR_MCPS_ENABLED = '0';
  env.GROK_MANAGED_MCPS_ENABLED = '0';
  env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED = '0';
  env.GROK_CLAUDE_HOOKS_ENABLED = '0';
  env.GROK_CURSOR_HOOKS_ENABLED = '0';
  // Account login lives in the CLI config; do not force HTTP API keys into the process.
  delete env.XAI_API_KEY;
  delete env.AI_CONTENT_MODEL_API_KEY;
  delete env.OPENAI_API_KEY;

  return env;
}

const defaultModels = new Map<string, { model: string; until: number }>();
/** Resolve and pin the CLI catalog recommendation, never a bundled old version or an HTTP fallback. */
export function configuredGrokModel(selected: string | undefined, command = 'grok'): string {
  if (selected?.trim()) return selected.trim();
  const env = grokEnvironment();
  const cacheKey = JSON.stringify([command, env.PATH, env.HOME, env.USERPROFILE, env.GROK_HOME, env.XDG_CONFIG_HOME]);
  const cached = defaultModels.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.model;
  const spec = portableCommand(command, ['--no-auto-update', 'models']);
  const result = spawnSync(spec.command, spec.args, { cwd: tmpdir(), env, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 });
  const model = result.stdout?.match(/^Default model:\s*([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199})\s*$/m)?.[1];
  if (result.error || result.status !== 0 || !model) throw new Error('Cannot resolve the Grok CLI recommended model. Install/sign in to Grok, run "grok models", or choose an explicit model. No API fallback was used.');
  defaultModels.set(cacheKey, { model, until: Date.now() + 60_000 });
  return model;
}

export const GROK_CLI_REVIEW_TRANSPORT_VERSION = 2;
const DIRECT_RESPONSE_RULES = 'Complete only the supplied bounded content task. Return the requested final answer directly in this one model response. Do not plan work, maintain a todo list, ask for confirmation, use tools, consult memory or request another turn. All evidence and images needed for the task are supplied in the prompt.';
export class GrokCliFailure extends Error {
  constructor(message: string, readonly receiptPath?: string) { super(message); this.name = 'GrokCliFailure'; }
}
function retainGrokFailure(prompt: string, runtime: ModelRuntime, stdout: string, stderr: string, code: number | null, problem: string): GrokCliFailure {
  const snapshot = (text: string) => { const bytes = Buffer.from(text); return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.subarray(0, 262144).toString('utf8'), truncated: bytes.length > 262144 }; };
  try {
    const directory = contained(activeRoot(), 'state/model-output-failures'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = contained(directory, `${randomUUID()}.json`);
    atomicJson(path, { version: 1, transportVersion: GROK_CLI_REVIEW_TRANSPORT_VERSION, kind: 'grok-cli-transport', observedAt: new Date().toISOString(), provider: 'grok', model: runtime.model ?? null,
      prompt: { bytes: Buffer.byteLength(prompt), sha256: createHash('sha256').update(prompt).digest('hex') }, exitCode: code, stdout: snapshot(stdout), stderr: snapshot(stderr), problem: problem.slice(0, 4000) });
    return new GrokCliFailure(problem, path);
  } catch { return new GrokCliFailure(`${problem}; private transport diagnostic could not be saved`); }
}
/**
 * Subscription/account Grok Build CLI writer: one model round, tools disabled, terminal JSON.
 * Prefer --prompt-file so long harness prompts never collide with -p/--single.
 */
export async function grokText(prompt: string, runtime: ModelRuntime, images: string[] = []): Promise<{ text: string; usage: unknown }> {
  if (!prompt.trim()) throw new Error("Grok CLI needs a nonempty prompt");
  if (images.length > 6) throw new Error('Grok CLI accepts at most six review frames');
  let imageBytes = 0;
  const blocks = images.map(path => {
    const size = statSync(path).size;
    if (!statSync(path).isFile() || size < 1 || size > 8 * 1024 * 1024 || (imageBytes += size) > 24 * 1024 * 1024) throw new Error('Grok CLI review image exceeds the bounded image allowance');
    const bytes = readFileSync(path);
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : undefined;
    if (!mimeType || bytes.length !== size) throw new Error('Grok CLI needs unchanged PNG, JPEG or WebP review images');
    return { type: 'image', mimeType, data: bytes.toString('base64') };
  });
  const dir = mkdtempSync(join(tmpdir(), "harness-grok-writer-"));
  // Official Grok Build headless CLI parses .json prompt files as ACP content
  // blocks. Keep image data out of argv and retain the account-authenticated CLI.
  const promptFile = join(dir, blocks.length ? 'prompt.json' : 'prompt.txt');
  writeFileSync(promptFile, blocks.length ? JSON.stringify([{ type: 'text', text: prompt }, ...blocks]) : prompt, { mode: 0o600 });
  try {
    const args = [
      "--prompt-file", promptFile,
      "--output-format", "json",
      // Official headless filtering: an empty --tools parses as no override.
      // A nonempty allowlist followed by its deny entry yields zero built-ins;
      // always-on MCP meta-tools are removed/denied separately.
      "--agent", "general-purpose",
      "--system-prompt-override", DIRECT_RESPONSE_RULES,
      "--tools", "read_file",
      "--disable-web-search",
      "--disallowed-tools", "Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch,Agent,run_terminal_cmd,read_file,grep,list_dir,search_replace,write_file,web_search,web_fetch,todo_write,ask_user_question,enter_plan_mode,exit_plan_mode,search_tool,use_tool",
      "--deny", "MCPTool",
      "--max-turns", "1",
      "--no-subagents",
      "--no-ask-user",
      "--no-memory",
      "--no-auto-update",
      "--permission-mode", "dontAsk",
      "--cwd", dir,
      ...(runtime.model ? ["--model", runtime.model] : []),
    ];
    const spec = portableCommand(runtime.command || "grok", args);
    const env = grokEnvironment();

    return await new Promise((resolveResult, reject) => {
      const child = spawn(spec.command, spec.args, { cwd: dir, env, detached: process.platform !== "win32" });
      let terminationError: Error | undefined;
      const unregisterManaged = registerManagedChild(child, { detached: process.platform !== 'win32', onTerminate: error => { terminationError = error; } });
      child.once('close', unregisterManaged); child.once('error', unregisterManaged);
      let stdout = "";
      let stderr = "";
      let timedOut = false, settled = false;
      const fail = (problem: string, code: number | null = null) => {
        if (settled) return;
        settled = true;
        reject(retainGrokFailure(prompt, runtime, stdout, stderr, code, problem));
      };
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          killer.on("error", () => { child.kill("SIGKILL"); });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
        child.stdout.destroy();
        child.stderr.destroy();
        fail(`Grok CLI timed out after ${runtime.timeoutMs / 1000}s`);
      }, runtime.timeoutMs);
      const bounded = (current: string, data: Buffer, label: string) => {
        if (Buffer.byteLength(current) + data.length > 2_097_152) {
          clearTimeout(timer);
          stop();
          child.stdout.destroy();
          child.stderr.destroy();
          fail(`Grok CLI ${label} exceeded 2 MiB`);
          return current;
        }
        return current + data;
      };
      child.stdout.on("data", data => { stdout = bounded(stdout, data, "output"); });
      child.stderr.on("data", data => { stderr = bounded(stderr, data, "stderr"); });
      child.on("error", error => {
        clearTimeout(timer);
        fail(`Grok CLI could not start: ${error.message}. Install the Grok CLI and complete account login.`);
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (terminationError) return fail(terminationError.message, code);
        if (timedOut || settled) return;
        if (code !== 0) {
          return fail(`Grok CLI exit ${code}: ${(stderr.trim() || stdout.trim() || "No error detail returned").slice(-500)}`, code);
        }
        // Official headless JSON includes text, stopReason and recorded num_turns.
        // A prelude/tool loop, cancellation or partial answer is never completion.
        let result: { text?: unknown; stopReason?: unknown; num_turns?: unknown; usage?: unknown; modelUsage?: unknown };
        try { result = JSON.parse(stdout); } catch { return fail('Grok CLI did not return its terminal JSON result', code); }
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.stopReason !== 'end_turn'
          || typeof result.text !== 'string' || !result.text.trim()) return fail('Grok CLI did not complete one direct model response (expected end_turn and nonempty text)', code);
        // Official build_json_result always emits text/stopReason; usage counters
        // are optional. Do not reject a complete answer solely for absent usage.
        if (result.num_turns !== undefined && result.num_turns !== 1) return fail('Grok CLI reported turns outside the one reserved round', code);
        if (result.modelUsage !== undefined) {
          if (!result.modelUsage || typeof result.modelUsage !== 'object' || Array.isArray(result.modelUsage)) return fail('Grok CLI returned malformed model usage', code);
          let calls = 0;
          for (const row of Object.values(result.modelUsage)) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('Grok CLI returned malformed model usage', code);
            if (row.modelCalls !== undefined) {
              if (!Number.isSafeInteger(row.modelCalls) || row.modelCalls < 0) return fail('Grok CLI returned malformed model usage', code);
              calls += row.modelCalls;
            }
          }
          if (calls > 1) return fail('Grok CLI reported model calls outside the one reserved round', code);
        }
        settled = true;
        resolveResult({ text: result.text.trim(), usage: result.usage ?? null });
      });
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* OS temp cleanup */ }
  }
}
