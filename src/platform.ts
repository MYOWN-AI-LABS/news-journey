import { execFile, spawnSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The starter can install uv privately without changing PATH or requiring a terminal restart. */
export function uvCommand(): string {
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", ".tools", "bin", process.platform === "win32" ? "uv.exe" : "uv");
  return existsSync(local) ? local : "uv";
}

export interface PortableCommand {
  command: string;
  args: string[];
}

/** Execute native binaries or Node entry points directly: prompts and paths never enter cmd.exe. */
export function portableCommand(
  command: string,
  args: string[] = [],
  targetPlatform: NodeJS.Platform = process.platform,
  searchPath = process.env.PATH || ""
): PortableCommand {
  if (targetPlatform === "win32" && ["claude", "npm", "npx"].includes(command)) {
    const dirs = [dirname(process.execPath), ...searchPath.split(delimiter)];
    if (command === "claude") {
      const native = dirs.map(dir => join(dir, "claude.exe")).find(existsSync);
      if (native) return { command: native, args };
    }
    const relative = command === "claude" ? "@anthropic-ai/claude-code/cli.js" : `npm/bin/${command}-cli.js`;
    for (const dir of dirs) {
      for (const candidate of [join(dir, "node_modules", relative), join(dir, "../lib/node_modules", relative)]) {
        if (existsSync(candidate)) return { command: process.execPath, args: [realpathSync(candidate), ...args] };
      }
    }
    throw new Error(`Cannot locate the ${command} executable. Reinstall ${command === "claude" ? "Claude Code or select an HTTP model in CONTENT.md" : "Node.js LTS"}.`);
  }
  if (targetPlatform === "win32") {
    for (const dir of searchPath.split(";")) {
      const native = join(dir, command + ".exe"); if (existsSync(native)) return { command: native, args };
      const shim = join(dir, command + ".cmd");
      if (!existsSync(shim)) continue;
      // Execute only the Node entry point of a standard npm shim; never invoke cmd.exe.
      const entry = readFileSync(shim, "utf8").match(/"%dp0%[\\/]([^"\r\n%]+?\.(?:c|m)?js)"/i)?.[1];
      if (entry) { const file = join(dir, ...entry.split(/[\\/]/)); if (existsSync(file)) return { command: process.execPath, args: [realpathSync(file), ...args] }; }
      const desktop = command === "code" ? "Code.exe" : command === "cursor" ? "Cursor.exe" : "";
      if (desktop && existsSync(join(dir, "..", desktop))) return { command: join(dir, "..", desktop), args };
      throw new Error(`Cannot safely launch ${command}'s Windows shim. Open the configured host from its native terminal.`);
    }
  }
  return { command, args };
}

/** Open a URL or local artifact with the operating system's default application. */
export function openExternal(target: string, onError?: (error: Error) => void): void {
  const spec: PortableCommand = process.platform === "darwin"
    ? { command: "open", args: [target] }
    : process.platform === "win32"
      ? { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", target] }
      : { command: "xdg-open", args: [target] };
  execFile(spec.command, spec.args, (error) => {
    if (error && onError) onError(error);
  });
}

/** Copy plain text without shell interpolation. Rich-text staging remains macOS-specific. */
export function copyTextToClipboard(text: string): void {
  const spec: PortableCommand = process.platform === "win32"
    ? {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
      }
    : { command: "pbcopy", args: [] };
  const result = spawnSync(spec.command, spec.args, { input: text, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`clipboard command failed: ${(result.stderr || "").trim() || result.error?.message || result.status}`);
}

export function isAppleSilicon(
  targetPlatform: NodeJS.Platform = process.platform,
  targetArch: string = process.arch
): boolean {
  return targetPlatform === "darwin" && targetArch === "arm64";
}

/** Preserve the selected provider on every platform. Unsupported local synthesis must fail
 * locally; choosing Kokoro never authorizes sending narration to a network voice service. */
export function resolveFreeTtsEngine(
  configuredEngine: "kokoro" | "edge",
  _targetPlatform: NodeJS.Platform = process.platform,
  _targetArch: string = process.arch
): "kokoro" | "edge" {
  return configuredEngine;
}

/** Keep configured voice names in the selected engine's namespace. */
export function resolveFreeVoice(engine: "kokoro" | "edge", voice: string): string {
  return engine === "edge" ? (/Neural$/.test(voice) ? voice : "en-US-AriaNeural") : (/Neural$/.test(voice) ? "af_heart" : voice);
}
