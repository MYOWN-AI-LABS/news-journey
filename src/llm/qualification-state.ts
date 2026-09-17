import { createHash } from "node:crypto";
import { resolveSelectionAreas } from "../pipeline/selection-policy.js";
import { arch, cpus, platform, totalmem } from "node:os";
import { contained, read } from "../workspaces.js";
import { effectiveVideoWordBudget } from "../personalization.js";
import { sameModelIdentity, type ModelIdentity } from './model-identity.js';

/**
 * The durable local-model qualification record — read side only, with no pipeline or model imports,
 * so the journey state can consult it at request time without loading the model layer.
 * Written by `models:qualify` (src/llm/qualification.ts).
 */
export const QUALIFICATION_VERSION = 17;
export interface QualificationStage { ok: boolean; seconds: number; reason?: string; words?: number }
export interface QualificationAttempt { startedAt: string; seconds: number; passed: boolean; stages: Record<"classification" | "script" | "visualPlan", QualificationStage> }
export interface QualificationRecord {
  version: number;
  key: string;
  provider: string;
  model: string;
  baseUrl: string;
  hardware: { platform: string; arch: string; cpus: number; memoryGb: number };
  settings?: string;
  ceilingSeconds: number;
  attempts: QualificationAttempt[];
  qualified: boolean;
  checkedAt: string;
  identity?: ModelIdentity;
}

export function hardwareProfile(): QualificationRecord["hardware"] {
  return { platform: platform(), arch: arch(), cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3) };
}

/** Local Ollama (direct or through OpenCode), or an OpenAI-compatible endpoint on this machine. */
export function isLocalRuntime(provider: string, baseUrl?: string, model = ""): boolean {
  if (provider === "opencode") return /^ollama\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model) && !/(?:[:\-])cloud$/i.test(model) && (!baseUrl || ["http://127.0.0.1:11434/v1", "http://127.0.0.1:11434/v1/"].includes(baseUrl));
  if (provider === "ollama" && /(?:[:\-])cloud$/.test(model)) return false;
  if (provider === "ollama" && !baseUrl) return true;
  if (!["ollama", "openai-compatible"].includes(provider) || !baseUrl) return false;
  try { return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(baseUrl).hostname); } catch { return false; }
}

/** One record per exact provider + model + endpoint + hardware profile. */
export function qualificationKey(provider: string, model: string, baseUrl: string, hardware = hardwareProfile(), settings = ""): string {
  return [provider, model, baseUrl, hardware.platform, hardware.arch, `${hardware.cpus}cpu`, `${hardware.memoryGb}gb`, settings].join("|");
}

/** Pin the effective policy, including overrides used by a measured run. Never hash secrets. */
export function qualificationSettings(root: string, runtime: { provider: string; model?: string; reasoningEffort?: string; contextTokens?: number; timeoutMs?: number }, policy?: { areas?: unknown; budget?: unknown }): string {
  const config = read<any>(contained(root, "config/model.json"), {});
  const provider = config.providers?.[runtime.provider === "openai-compatible" ? "openaiCompatible" : runtime.provider] || {};
  const sources = read<any>(contained(root, "config/sources.json"), {});
  const settings = {
    reasoningEffort: runtime.reasoningEffort ?? provider.reasoningEffort ?? "default",
    // OpenCode's model metadata bounds its input budget; /v1 does not set Ollama's actual num_ctx.
    contextTokens: runtime.provider === "opencode" && runtime.model?.startsWith("ollama/") ? "installed-model-default" : runtime.contextTokens ?? provider.contextTokens ?? (runtime.provider === "ollama" ? (/-32k(:|$)/.test(runtime.model || "") ? "model-default" : 16384) : null),
    ...(runtime.provider === "opencode" && runtime.model?.startsWith("ollama/") ? { openCodeInputBudget: 16384 } : {}),
    timeoutMs: runtime.timeoutMs ?? (config.timeoutSeconds || 300) * 1000,
    areas: policy?.areas ?? resolveSelectionAreas(sources.editorial?.areas),
    budget: policy?.budget ?? effectiveVideoWordBudget(root),
  };
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

export function readQualifications(root: string): Record<string, QualificationRecord> {
  return read<Record<string, QualificationRecord>>(contained(root, "state/model-qualification.json"), {});
}

/** null when the writer is not local; otherwise whether this exact profile has passed, in plain words. */
export function localQualification(root: string, provider: string, model: string, baseUrl: string, effective: { reasoningEffort?: string; contextTokens?: number; timeoutMs?: number; identity?: ModelIdentity } = {}): { qualified: boolean; checkedAt: string | null; reason: string } | null {
  if (!isLocalRuntime(provider, baseUrl, model)) return null;
  const record = readQualifications(root)[qualificationKey(provider, model, baseUrl, hardwareProfile(), qualificationSettings(root, { provider, model, ...effective }))];
  if (!record) return { qualified: false, checkedAt: null, reason: `${model || provider} has not been through the editorial check on this computer yet. You can still create a preview with this writer and review its output.` };
  if (record.version !== QUALIFICATION_VERSION) return { qualified: false, checkedAt: record.checkedAt, reason: `${model} was checked with an earlier version of the editorial check, so that result no longer counts. It can still write previews.` };
  if (!sameModelIdentity(record.identity, effective.identity)) return { qualified: false, checkedAt: record.checkedAt, reason: `${model} has an earlier editorial result, but its exact model, runtime and context have not been matched to the current check. Check this writer before relying on that result.` };
  if (record.qualified) return { qualified: true, checkedAt: record.checkedAt, reason: `${model} passed the editorial check twice for this exact runtime (${record.checkedAt.slice(0, 10)}).` };
  const failed = [...record.attempts].reverse().find(a => !a.passed);
  const stage = failed && (Object.entries(failed.stages) as [string, QualificationStage][]).find(([, s]) => !s.ok);
  // Plain words for the executive page; the exact reason stays in the CLI summary and the record.
  const plain: Record<string, string> = { classification: "choosing stories", script: "writing the script", visualPlan: "planning a visual" };
  const detail = stage?.[1].reason ? `: ${stage[1].reason.slice(0, 160)}` : "";
  return { qualified: false, checkedAt: record.checkedAt, reason: `${model} did not pass the editorial check on this computer${stage ? ` (it failed at ${plain[stage[0]] ?? stage[0]}${detail})` : ""}. You can retry with this writer or choose another writer, then review the output.` };
}
