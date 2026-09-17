import { uvCommand } from "./platform.js";
import { assetPath } from "./workspaces.js";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AvatarConfig, Platform } from "./types.js";
import { loadTokens, daysUntilExpiry } from "./auth/tokens.js";
import { isAppleSilicon, portableCommand } from "./platform.js";
import { resolveModelRuntime, type ModelConfig } from "./llm/model.js";
import { CONFIG_DIR, ROOT, WORKDIR, loadConfig } from "./util.js";

let failures = 0;

function check(label: string, fn: () => string | void): void {
  try {
    const detail = fn();
    console.log("  [ok] " + label + (detail ? " - " + detail : ""));
  } catch (error) {
    failures += 1;
    console.log("  [fail] " + label + " - " + (error as Error).message);
  }
}

function bin(name: string, args: string[] = ["--version"]): string {
  const spec = portableCommand(name, args);
  return execFileSync(spec.command, spec.args, { encoding: "utf8" }).trim().split("\n")[0];
}

export async function doctor(): Promise<void> {
  failures = 0;
  console.log(`ai-content-engine doctor (${process.platform}/${process.arch})\n`);

  console.log("Tools:");
  check("node", () => bin("node"));
  check("uv", () => bin(uvCommand()));
  try { console.log("  [ok] git - " + bin("git")); }
  catch { console.log("  [skip] git - optional for a ZIP install; RSS drafting does not require it"); }
  if (process.platform === "darwin") check("caffeinate", () => bin("caffeinate", ["-h"]));
  else console.log("  [skip] caffeinate - macOS-only sleep guard; direct rendering is used on this platform");

  console.log("\nModel runtime:");
  const modelRuntime = resolveModelRuntime(loadConfig<ModelConfig>("model"));
  console.log(`  provider: ${modelRuntime.label}`);
  if (["claude", "codex", "opencode"].includes(modelRuntime.provider)) check(modelRuntime.provider + " CLI", () => bin(modelRuntime.command || modelRuntime.provider));
  else if (modelRuntime.provider === "zai") check("Z.AI API key", () => { if (!modelRuntime.apiKey) throw new Error("not set"); });
  else console.log(`  [info] endpoint: ${modelRuntime.baseUrl}`);

  console.log("\nWorkspace:");
  check("workdir writable", () => { mkdirSync(WORKDIR, { recursive: true }); accessSync(WORKDIR, constants.W_OK); });
  check("config readable", () => {
    loadConfig("pipeline");
    loadConfig("sources");
    loadConfig("model");
    loadConfig("platforms");
  });

  console.log("\nEnvironment:");
  console.log(process.env.GITHUB_TOKEN
    ? "  [ok] GITHUB_TOKEN - optional GitHub API rate-limit token configured"
    : "  [skip] GITHUB_TOKEN - optional; unauthenticated GitHub API limits apply");

  console.log("\nTokens:");
  const platforms = loadConfig<Record<Platform, { enabled: boolean }>>("platforms");
  for (const [provider, platform] of [
    ["google", "youtube"],
    ["linkedin", "linkedin"],
    ["instagram", "instagram"],
    ["x", "x"],
    ["threads", "threads"],
    ["tiktok", "tiktok"],
    ["reddit", "reddit"],
  ] as const) {
    if (!platforms[platform]?.enabled) {
      console.log("  [skip] " + provider + " (" + platform + " disabled in config)");
      continue;
    }
    check(provider, () => {
      const token = loadTokens(provider);
      if (!token) throw new Error("no local token configured for this enabled destination");
      const days = daysUntilExpiry(token);
      if (days !== null && days <= 0) throw new Error("token expired - re-authenticate");
      return days !== null ? "expires in " + days.toFixed(0) + " days" : "ok";
    });
  }

  console.log("\nTTS:");
  const ttsImports = isAppleSilicon()
    ? "import mlx_audio, mlx_whisper, edge_tts, imageio_ffmpeg"
    : "import faster_whisper, edge_tts, imageio_ffmpeg";
  check("tts env", () =>
    execFileSync(uvCommand(), ["run", "--project", join(ROOT, "tts"), "python", "-c", ttsImports], {
      encoding: "utf8",
      timeout: 60_000,
    }).trim()
  );
  console.log(isAppleSilicon()
    ? "  [info] local Kokoro synthesis + MLX Whisper alignment available"
    : "  [info] Kokoro/MLX requires Apple silicon; select Edge explicitly for network narration with CPU faster-whisper alignment");

  console.log("\nAvatar / voice (config/avatar.json):");
  if (!existsSync(join(CONFIG_DIR, "avatar.json"))) {
    console.log("  [skip] no avatar.json - cards mode");
  } else {
    const avatar = loadConfig<AvatarConfig>("avatar");
    console.log("  mode: " + avatar.mode + " | voiceProvider: " + avatar.voiceProvider);
    if (avatar.voiceProvider === "voicebox") {
      check("Local Voicebox profile", () => { if (!avatar.voicebox?.profile) throw new Error("Choose your own local voice profile in Voice & video"); });
    }
    if (avatar.voiceProvider === "elevenlabs") {
      check("ELEVENLABS_API_KEY", () => { if (!process.env.ELEVENLABS_API_KEY) throw new Error("not set"); });
      check("elevenlabs.voiceId", () => { if (!avatar.elevenlabs.voiceId) throw new Error("empty"); });
    }
    if (avatar.mode === "avatar" || avatar.mode === "hybrid") {
      const provider = avatar.avatarProvider ?? "heygen";
      if (provider === "heygem") {
        check("heygem baseUrl", () => {
          if (!process.env.HEYGEM_BASE_URL && !avatar.heygem?.baseUrl) throw new Error("not configured");
        });
        check("heygem transfer", () => {
          if (!avatar.heygem?.dataDir && !(avatar.heygem?.ssh && avatar.heygem?.remoteDataDir)) throw new Error("not configured");
        });
        check("heygem sourceVideo", () => {
          if (!avatar.heygem?.sourceVideo || !existsSync(assetPath(avatar.heygem.sourceVideo))) throw new Error("missing reference video");
        });
      } else if (provider === "heygen") {
        check("HEYGEN_API_KEY", () => { if (!process.env.HEYGEN_API_KEY) throw new Error("not set"); });
        check("heygen.avatarId", () => { if (!avatar.heygen.avatarId) throw new Error("empty"); });
      }
    }
  }

  if (failures > 0) throw new Error("doctor found " + failures + " required check failure(s)");
}
