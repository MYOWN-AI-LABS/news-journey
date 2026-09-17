import { registerManagedChild } from '../managed-process.js';
import { activeRoot, atomicJson, contained } from "../workspaces.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { portableCommand } from "../platform.js";
import { writerCanReadImages } from "./local-models.js";

/** A finish without "stop" keeps its finish part and the last raw events in the workspace's private failure store; returns the receipt path. */
function retainStream(prompt: string, model: string, recent: string[], finish: unknown): string | null {
  try {
    const directory = contained(activeRoot(), "state/model-output-failures"); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = contained(directory, `${randomUUID()}.json`);
    atomicJson(path, { version: 1, kind: "opencode-cli-stream", observedAt: new Date().toISOString(), provider: "opencode", model,
      prompt: { bytes: Buffer.byteLength(prompt), sha256: createHash("sha256").update(prompt).digest("hex") }, finish, recentEvents: recent });
    return path;
  } catch { return null; }
}

export interface OpenCodeRuntime { command?: string; model?: string; timeoutMs: number }
export interface OpenCodeTextResult { text: string; model: string; usage?: { tokens?: unknown; cost?: number } }

export function validateOpenCodeModel(model?: string): string {
  if (!model || !/^(ollama|opencode)\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)) {
    throw new Error("OpenCode requires an exact ollama/model or opencode/model-free selection; other providers are unsupported.");
  }
  const [provider, ...segments] = model.split("/"), modelID = segments.join("/");
  if (provider === "opencode" && !modelID.endsWith("-free")) {
    throw new Error("OpenCode writer supports native free models only; paid or authenticated routes are unsupported.");
  }
  if (provider === "ollama" && /(?:[:\-])cloud$/i.test(modelID)) throw new Error("OpenCode Ollama writer supports installed local models only; cloud aliases are unsupported.");
  return model;
}

/** One isolated CLI response, optionally inspecting selected local images. No tools or model fallback. */
export async function opencodeText(prompt: string, runtime: OpenCodeRuntime, images: string[] = []): Promise<OpenCodeTextResult> {
  const model = validateOpenCodeModel(runtime.model), [provider, ...segments] = model.split("/"), modelID = segments.join("/");
  if (!Number.isFinite(runtime.timeoutMs) || runtime.timeoutMs < 1 || runtime.timeoutMs > 2_147_483_647) {
    throw new Error("OpenCode requires a positive, bounded timeout.");
  }
  if (!prompt.trim() || Buffer.byteLength(prompt) > 1_048_576) throw new Error("OpenCode prompt must contain text and fit within 1 MiB.");
  if (images.length > 6) throw new Error("OpenCode vision accepts at most six actual images.");
  if (images.length && provider !== "ollama") throw new Error("The selected native OpenCode route accepts text only; image review requires an installed local vision model.");
  // Freeze only explicitly supplied, bounded regular files. Never expose workspace paths or
  // permit the CLI to browse for an image; its normal --file loader handles these private copies.
  const attachments = images.map(path => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > 8_000_000) throw new Error("OpenCode vision input must be a regular image of at most 8 MB.");
      const buffer = Buffer.alloc(stat.size + 1); let size = 0;
      while (size < buffer.length) {
        const read = readSync(fd, buffer, size, buffer.length - size, null);
        if (!read) break;
        size += read;
      }
      if (size !== stat.size) throw new Error("OpenCode vision input changed while being captured.");
      const bytes = buffer.subarray(0, size);
      const extension = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpg"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
      if (!extension) throw new Error("OpenCode vision input must be a PNG, JPEG, or WebP image.");
      return { bytes, extension };
    } finally { closeSync(fd); }
  });
  if (images.length && !await writerCanReadImages({ provider: "opencode", model, baseUrl: "http://127.0.0.1:11434/v1" }, 0)) {
    throw new Error(`Selected OpenCode model ${model} does not advertise local vision support; no image or fallback was sent.`);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-opencode-writer-")));
  try {
    const paths = Object.fromEntries(["home", "config", "cache", "data", "state", "project", "tmp"].map(key => [key, join(root, key)]));
    for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
    const files = attachments.map(({ bytes, extension }, index) => {
      const path = join(paths.project, `image-${index + 1}.${extension}`);
      writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
      return path;
    });
    // Public model metadata is the only inherited file. Never copy auth.json or account/config state.
    const catalog = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json");
    if (provider === "opencode" && existsSync(catalog) && statSync(catalog).size <= 16_777_216) {
      mkdirSync(join(paths.cache, "opencode"), { mode: 0o700 });
      copyFileSync(catalog, join(paths.cache, "opencode", "models.json"));
    }
    const permission = { "*": "deny" }, tools = { "*": false };
    const config = {
      $schema: "https://opencode.ai/config.json", model, small_model: model, default_agent: "writer",
      enabled_providers: [provider], share: "disabled", autoupdate: false, snapshot: false,
      permission, tools, mcp: {}, plugin: [], instructions: [], skills: { paths: [], urls: [] },
      command: {}, lsp: false, formatter: false, compaction: { auto: false, prune: false },
      agent: { writer: {
        mode: "primary", model, description: "Produce only the requested text from the supplied material.",
        prompt: `Answer the supplied request using only its supplied material${images.length ? " and attached images" : ""}. Do not use tools, inspect other files, browse, or delegate. Return only the requested answer.`,
        // OpenCode 1.18.25 forwards this as reasoning_effort; Ollama's compatibility API
        // accepts "none" to disable thinking. Native free providers retain their own defaults.
        ...(provider === "ollama" ? { reasoningEffort: "none" } : {}),
        // In 1.18.25, steps=1 appends a conflicting assistant "maximum steps" message on the first turn.
        // Tools are denied and non-stop/multiple-message events are rejected below, so a second model turn is never accepted.
        steps: 2, tools, permission,
      } },
      ...(provider === "ollama" ? { provider: { ollama: {
        name: "Ollama", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
        models: { [modelID]: { name: modelID, tool_call: false, ...(images.length ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}), limit: { context: 16384, output: 4096 } } },
      } } } : {}),
    };
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "LANG", "LC_ALL", "SystemRoot", "SYSTEMROOT", "WINDIR", "PATHEXT"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.config, LOCALAPPDATA: paths.data,
      PWD: paths.project, TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp,
      XDG_CONFIG_HOME: paths.config, XDG_CACHE_HOME: paths.cache, XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state,
      OPENCODE_CONFIG_DIR: paths.config, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_PURE: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_DISABLE_AUTOCOMPACT: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    });
    // OpenCode 1.18.25 run.ts reads piped stdin; no prompt or shell interpolation in argv.
    // A fixed title prevents OpenCode's otherwise automatic extra model call to name this session.
    // OpenCode 1.18.25 run.ts forwards --file parts through session/prompt.ts, whose
    // image-aware loader produces binary image parts without a model-selected tool call.
    const spec = portableCommand(runtime.command || "opencode", ["run", "--pure", "--agent", "writer", "--model", model, "--format", "json", "--title", "Content writer", "--dir", paths.project, ...files.flatMap(path => ["--file", path])]);
    return await new Promise<OpenCodeTextResult>((resolveResult, reject) => {
      const child = spawn(spec.command, spec.args, { cwd: paths.project, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      let terminationError: Error | undefined;
      const unregisterManaged = registerManagedChild(child, { detached: process.platform !== 'win32', onTerminate: error => { terminationError = error; } });
      child.once('close', unregisterManaged); child.once('error', unregisterManaged);
      let pending = "", stderr = "", stdoutBytes = 0, stderrBytes = 0, failure: Error | undefined;
      let sessionID = "", messageID = "", finished = false, usage: OpenCodeTextResult["usage"];
      const parts = new Map<string, string>();
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          killer.on("error", () => { child.kill("SIGKILL"); });
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
      };
      const recent: string[] = [];
      let receiptWritten = false;
      // Every rejection keeps the last raw events, not only a finish-without-'stop': a timeout or error event is exactly
      // the "unknown outcome" this receipt exists to diagnose (four 300-s judge timeouts, Sep 17, kept nothing).
      const fail = (message: string, detail?: unknown) => {
        // The receipt names the actual cause (timeout, error event, cap…), not one generic reason for every rejection (review finding).
        if (!failure && !receiptWritten) { receiptWritten = true; const path = retainStream(prompt, model, recent, detail ?? { reason: "rejected", message }); if (path) message += `; diagnostic ${path}`; }
        failure ??= new Error(message); stop();
        // Descendants cannot retain these pipes and keep a rejected request pending.
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      };
      const timer = setTimeout(() => fail(`OpenCode CLI timed out after ${runtime.timeoutMs / 1000}s`, { reason: "timeout", timeoutMs: runtime.timeoutMs }), runtime.timeoutMs);
      const parseLine = (line: string) => {
        if (!line.trim() || failure || terminationError) return;
        recent.push(line.slice(0, 4096)); if (recent.length > 12) recent.shift();
        let event: any;
        try { event = JSON.parse(line); } catch { fail("OpenCode CLI returned invalid JSON events; no answer was accepted."); return; }
        if (event?.type === "tool_use" || event?.part?.type === "tool") return fail("OpenCode writer attempted tool use; no answer was accepted.");
        if (event?.type === "error") {
          const detail = event.error?.data?.message || event.error?.message || "session error";
          return fail(`OpenCode CLI error: ${String(detail).slice(0, 500)}`);
        }
        if (!["step_start", "step_finish", "text", "reasoning"].includes(event?.type)) return fail("OpenCode CLI returned an unexpected event; no answer was accepted.");
        const part = event.part;
        if (!event.sessionID || !part?.messageID || (sessionID && event.sessionID !== sessionID) || (messageID && part.messageID !== messageID)) {
          return fail("OpenCode CLI returned mismatched session events; no answer was accepted.");
        }
        sessionID = event.sessionID; messageID = part.messageID;
        if (finished) return fail("OpenCode CLI returned events after its final answer; no answer was accepted.");
        if (event.type === "text") {
          if (typeof part.text !== "string" || !part.id || !Number.isFinite(part.time?.end)) return fail("OpenCode CLI returned incomplete text; no answer was accepted.");
          parts.set(part.id, part.text);
        }
        if (event.type === "step_finish") {
          if (part.reason !== "stop") {
            // "unknown" alone cannot be diagnosed (Nemotron, Sep 17); fail() keeps the finish part and the last raw events.
            return fail(`OpenCode CLI did not finish its answer (${String(part.reason || "no finish reason")}; tokens in ${part.tokens?.input ?? "?"} out ${part.tokens?.output ?? "?"}); no answer was accepted.`, part);
          }
          finished = true; usage = { tokens: part.tokens, cost: part.cost };
        }
      };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        stdoutBytes += Buffer.byteLength(data);
        if (stdoutBytes > 2_097_152) return fail("OpenCode CLI exceeded its 2 MiB output limit.");
        pending += data;
        let end: number;
        while (!failure && (end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1); parseLine(line);
        }
      });
      child.stderr.on("data", (data: string) => {
        stderrBytes += Buffer.byteLength(data); stderr = (stderr + data).slice(-2000);
        if (stderrBytes > 65_536) fail("OpenCode CLI exceeded its diagnostic output limit.");
      });
      child.on("error", error => {
        clearTimeout(timer); failure ??= new Error(`OpenCode CLI could not start: ${error.message}. Install OpenCode before selecting this writer.`);
        reject(failure);
      });
      child.on("exit", () => stop()); // Also stop descendants after a normal launcher exit.
      child.on("close", code => {
        clearTimeout(timer);
        if (terminationError) return reject(terminationError);
        if (!failure && pending.trim()) parseLine(pending);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error(`OpenCode CLI exit ${code}: ${stderr.trim().slice(-500) || "No answer was accepted."}`));
        const text = [...parts.values()].join("\n").trim();
        if (!finished || !text) return reject(new Error("OpenCode CLI returned no complete final text."));
        resolveResult({ text, model, usage });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
  } finally {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Preserve the result if Windows briefly retains the working directory. */ }
  }
}
