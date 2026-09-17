import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

const MAX_LLMFIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIB = 1024 ** 3;
const OPENCODE_CONTEXT_TOKENS = 32_768;
const MIN_AGENT_MEMORY_GB = 6.8;
const MIN_CONTENT_MEMORY_GB = 3.9;

export interface LlmfitModel {
  name: string;
  ollamaName: string | null;
  category: string;
  installed: boolean;
  fitLevel: string;
  runtime?: string | null;
  quantization?: string | null;
  memoryRequiredGb: number | null;
  memoryAvailableGb: number | null;
  estimatedTps: number | null;
  effectiveContextTokens: number | null;
  score: number;
  quality: number;
  capabilities: string[];
}

export interface OfficialOllamaCatalogMapping {
  catalogModel: string; installedName: string; registryUrl: string; quantization: string | null;
}
/** An explicit, documented family mapping, never a replacement model name. A consumer must
 * still prove the exact official manifest matches the installed digest before using this join.
 * Sources: https://huggingface.co/Qwen/Qwen3.5-9B and https://ollama.com/library/qwen3.5:9b
 */
export function officialOllamaCatalogMapping(catalogModel: string, installedName: string): OfficialOllamaCatalogMapping | null {
  const family = catalogModel.match(/^Qwen\/Qwen3\.5-(4|9)B$/);
  if (!family || !validOllamaModelName(installedName)) return null;
  const canonical = canonicalOllamaName(installedName);
  const match = canonical.match(/^registry\.ollama\.ai\/library\/qwen3\.5:(4|9)b(?:-(q[2-8]_(?:k(?:_[sml])?|[01])))?$/);
  if (match?.[1] !== family[1]) return null;
  if (!match) return null;
  const tag = installedName.slice(installedName.lastIndexOf(':') + 1);
  return { catalogModel, installedName, registryUrl: `https://registry.ollama.ai/v2/library/qwen3.5/manifests/${encodeURIComponent(tag)}`, quantization: match[2]?.toUpperCase() ?? null };
}

export interface LlmfitSystem {
  cpuName: string;
  totalRamGb: number;
  availableRamGb?: number | null;
  availableGpuGb?: number | null;
  backend: string;
  unifiedMemory: boolean;
  cpuCores?: number;
  gpus?: Array<{ name: string; count: number; vramGb: number | null; backend: string }>;
}

export interface LlmfitReport {
  models: LlmfitModel[];
  system: LlmfitSystem;
}

export interface LocalModelRecommendation {
  source: "llmfit" | "memory-tier fallback";
  analyzerNote: string;
  system: LlmfitSystem;
  agentModel: string | null;
  agentBaseModel: string | null;
  agentContextTokens: number;
  agentValidation: string;
  contentBaseModel: string | null;
  contentModel: string | null;
  contentValidation: string;
  fitLevel: string;
  memoryRequiredGb: number | null;
  estimatedTps: number | null;
  rationale: string;
  warnings: string[];
}

interface RecommendOptions {
  json?: boolean;
  useUvx?: boolean;
}

function finiteNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveFiniteNumber(value: unknown, fallback: number | null): number | null {
  const parsed = finiteNumber(value, fallback);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`llmfit ${field} must be a non-empty string`);
  return value;
}

/** Parse only the small, documented llmfit fields used by the recommender. */
export function parseLlmfitReport(output: string): LlmfitReport {
  if (Buffer.byteLength(output, "utf8") > MAX_LLMFIT_OUTPUT_BYTES) throw new Error("llmfit output exceeded 8 MiB");
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("llmfit output must be an object");
  const parsed = value as Record<string, unknown>;
  if (!Array.isArray(parsed.models) || typeof parsed.system !== "object" || parsed.system === null) {
    throw new Error("llmfit output must contain models and system");
  }
  const system = parsed.system as Record<string, unknown>;
  const totalRamGb = positiveFiniteNumber(system.total_ram_gb, null);
  if (totalRamGb === null) throw new Error("llmfit system.total_ram_gb must be a positive finite number");
  const models = parsed.models.map((entry, index): LlmfitModel => {
    if (typeof entry !== "object" || entry === null) throw new Error(`llmfit model ${index} must be an object`);
    const model = entry as Record<string, unknown>;
    const scoreComponents = typeof model.score_components === "object" && model.score_components !== null
      ? model.score_components as Record<string, unknown>
      : {};
    return {
      name: requiredString(model.name, `models[${index}].name`),
      ollamaName: typeof model.ollama_name === "string" && validOllamaModelName(model.ollama_name.trim())
        ? model.ollama_name.trim()
        : null,
      category: typeof model.category === "string" ? model.category : "Unknown",
      installed: model.installed === true,
      fitLevel: typeof model.fit_level === "string" ? model.fit_level : "Unknown",
      runtime: typeof model.runtime === "string" ? model.runtime : null,
      quantization: typeof model.best_quant === "string" ? model.best_quant : null,
      memoryRequiredGb: positiveFiniteNumber(model.memory_required_gb, null),
      memoryAvailableGb: positiveFiniteNumber(model.memory_available_gb, null),
      estimatedTps: finiteNumber(model.estimated_tps, null),
      effectiveContextTokens: finiteNumber(model.effective_context_length, null),
      score: finiteNumber(model.score, 0) ?? 0,
      quality: finiteNumber(scoreComponents.quality, 0) ?? 0,
      capabilities: Array.isArray(model.capability_ids)
        ? model.capability_ids.filter((item): item is string => typeof item === "string")
        : [],
    };
  });
  return {
    models,
    system: {
      cpuName: requiredString(system.cpu_name, "system.cpu_name"),
      totalRamGb,
      availableRamGb: positiveFiniteNumber(system.available_ram_gb, null),
      availableGpuGb: positiveFiniteNumber(system.gpu_available_gb, null),
      backend: typeof system.backend === "string" ? system.backend : "unknown",
      unifiedMemory: system.unified_memory === true,
      cpuCores: positiveFiniteNumber(system.cpu_cores, null) ?? undefined,
      gpus: Array.isArray(system.gpus) ? system.gpus.map((gpu: any) => ({ name: typeof gpu?.name === 'string' ? gpu.name : 'unknown', count: positiveFiniteNumber(gpu?.count, 1) ?? 1, vramGb: positiveFiniteNumber(gpu?.vram_gb, null), backend: typeof gpu?.backend === 'string' ? gpu.backend : 'unknown' })) : undefined,
    },
  };
}

function inferredOllamaName(model: LlmfitModel): string | null {
  if (model.ollamaName) return model.ollamaName;
  const match = model.name.match(/^Qwen\/Qwen2\.5-Coder-(1\.5|3|7|14|32)B(?:-Instruct)?$/i);
  return match ? `qwen2.5-coder:${match[1].toLowerCase()}b` : null;
}

function baseCandidate(model: LlmfitModel, contextTokens = OPENCODE_CONTEXT_TOKENS, tools = true): boolean {
  return (!tools || model.capabilities.includes("tool_use"))
    && ["perfect", "good"].includes(model.fitLevel.toLowerCase())
    && model.quality >= 70
    && model.memoryRequiredGb !== null
    && model.memoryRequiredGb > 0
    && model.effectiveContextTokens !== null
    && model.effectiveContextTokens >= contextTokens
    && inferredOllamaName(model) !== null;
}

function agentFamilyRank(model: LlmfitModel): number {
  const ollamaName = inferredOllamaName(model) ?? "";
  if (/^qwen3-coder(?::|$)/i.test(ollamaName)) return 4;
  if (/^qwen3:/i.test(ollamaName)) return 3;
  if (/^qwen2\.5-coder:/i.test(ollamaName)) return 1;
  return 0;
}

function relevantMemoryPool(report: LlmfitReport, model: LlmfitModel): number | null {
  if (model.memoryAvailableGb !== null && model.memoryAvailableGb > 0) return model.memoryAvailableGb;
  if (report.system.unifiedMemory || /cpu|unknown|not detected/i.test(report.system.backend)) {
    return report.system.totalRamGb;
  }
  return null;
}

export function selectLlmfitModels(report: LlmfitReport, contentContextTokens = OPENCODE_CONTEXT_TOKENS): { agent: LlmfitModel | null; content: LlmfitModel | null } {
  if (!Number.isFinite(report.system.totalRamGb) || report.system.totalRamGb <= 0) {
    return { agent: null, content: null };
  }
  // Preserve at least 15% of llmfit's evaluated unified/VRAM/CPU pool for the runtime and tools.
  const agentCandidates = report.models.filter((model) => {
    const memoryPoolGb = relevantMemoryPool(report, model);
    return baseCandidate(model)
      && agentFamilyRank(model) >= 3
      && memoryPoolGb !== null
      && model.memoryRequiredGb! <= memoryPoolGb * 0.85;
  });
  const agent = [...agentCandidates].sort((a, b) =>
    agentFamilyRank(b) - agentFamilyRank(a)
    || b.quality - a.quality
    || Number(b.installed) - Number(a.installed)
    || b.score - a.score
  )[0] ?? null;
  // Content generation has no agent tool loop, but still leaves 25% headroom for the pipeline.
  const contentCandidates = report.models.filter((model) => {
    const memoryPoolGb = relevantMemoryPool(report, model);
    return baseCandidate(model, contentContextTokens, false)
      && !/embedding|rerank/i.test(model.category)
      && memoryPoolGb !== null
      && model.memoryRequiredGb! <= memoryPoolGb * 0.75;
  });
  const content = [...contentCandidates].sort((a, b) =>
    b.quality - a.quality
    || Number(b.installed) - Number(a.installed)
    || b.score - a.score
  )[0] ?? null;
  return { agent, content };
}

export function fallbackAgentForMemory(totalRamGb: number): string | null {
  if (totalRamGb >= 32) return "qwen3-coder";
  if (totalRamGb >= 16) return "qwen3:8b";
  if (totalRamGb >= 11) return "qwen3:4b";
  return totalRamGb >= MIN_AGENT_MEMORY_GB ? "qwen3:1.7b" : null;
}

export function fallbackContentForMemory(totalRamGb: number): string | null {
  if (totalRamGb >= 32) return "qwen2.5-coder:14b";
  if (totalRamGb >= 14) return "qwen2.5-coder:7b";
  if (totalRamGb >= 8) return "qwen2.5-coder:3b";
  return totalRamGb >= MIN_CONTENT_MEMORY_GB ? "qwen2.5-coder:1.5b" : null;
}

function fallbackSystem(): LlmfitSystem {
  const appleUnified = process.platform === "darwin" && process.arch === "arm64";
  return {
    cpuName: cpus()[0]?.model || `${process.platform}/${process.arch}`,
    totalRamGb: Math.round((totalmem() / GIB) * 10) / 10,
    backend: appleUnified ? "Metal (inferred)" : "not detected",
    unifiedMemory: appleUnified,
  };
}

function runLlmfit(useUvx: boolean): { report: LlmfitReport | null; note: string } {
  const command = useUvx ? "uvx" : "llmfit";
  const args = [
    ...(useUvx ? ["llmfit"] : []),
    "--no-dashboard",
    "--max-context", String(OPENCODE_CONTEXT_TOKENS),
    "fit", "--json", "--tool-use", "--perfect",
    "--sort", "score", "--limit", "2000",
  ];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: MAX_LLMFIT_OUTPUT_BYTES,
    shell: false,
  });
  if (result.error) {
    const missing = "code" in result.error && result.error.code === "ENOENT";
    return {
      report: null,
      note: missing
        ? `${command} was not found; using a conservative memory-tier fallback`
        : `${command} failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim().split("\n").at(-1) || `exit ${result.status}`;
    return { report: null, note: `${command} failed: ${detail}` };
  }
  try {
    return { report: parseLlmfitReport(result.stdout), note: useUvx ? "llmfit via explicit uvx run" : "installed llmfit" };
  } catch (error) {
    return { report: null, note: `llmfit returned unusable JSON: ${(error as Error).message}` };
  }
}

function validOllamaModelName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(value)
    && !value.includes("..")
    && !value.includes("//");
}

export function runtimeAgentName(baseModel: string): string {
  if (!validOllamaModelName(baseModel)) throw new Error(`Invalid Ollama model name: ${baseModel}`);
  const separator = baseModel.lastIndexOf(":");
  return separator === -1
    ? `${baseModel}-opencode:32k`
    : `${baseModel.slice(0, separator)}-opencode:${baseModel.slice(separator + 1)}`;
}

export function runtimeContentName(baseModel: string): string {
  if (!validOllamaModelName(baseModel)) throw new Error(`Invalid Ollama model name: ${baseModel}`);
  const separator = baseModel.lastIndexOf(":");
  return separator === -1
    ? `${baseModel}-content:32k`
    : `${baseModel.slice(0, separator)}-32k:${baseModel.slice(separator + 1)}`;
}

export function canonicalOllamaName(value: string): string {
  if (!validOllamaModelName(value)) throw new Error(`Invalid Ollama model name: ${value}`);
  const lastColon = value.lastIndexOf(":");
  const lastSlash = value.lastIndexOf("/");
  const tagged = lastColon > lastSlash;
  const path = (tagged ? value.slice(0, lastColon) : value).toLowerCase();
  const tag = (tagged ? value.slice(lastColon + 1) : "latest").toLowerCase();
  const parts = path.split("/");
  if (parts.length > 3) throw new Error(`Invalid Ollama model name: ${value}`);
  const [host, namespace, model] = parts.length === 1
    ? ["registry.ollama.ai", "library", parts[0]]
    : parts.length === 2
      ? ["registry.ollama.ai", parts[0], parts[1]]
      : parts;
  return `${host}/${namespace}/${model}:${tag}`;
}

/** Create an explicit 32K Ollama alias for an agent or content runtime. This runs only as a separate opt-in command. */
export function createOllamaProfile(baseModel: string, alias: string): void {
  if (!validOllamaModelName(baseModel)) throw new Error(`Invalid Ollama base model name: ${baseModel}`);
  if (!validOllamaModelName(alias)) throw new Error(`Invalid Ollama alias: ${alias}`);
  if (canonicalOllamaName(baseModel) === canonicalOllamaName(alias)) {
    throw new Error("Ollama alias must differ from the base model after default registry, namespace, and tag expansion");
  }
  const profileDir = mkdtempSync(join(tmpdir(), "ai-content-ollama-profile-"));
  const modelfilePath = join(profileDir, "Modelfile");
  try {
    writeFileSync(modelfilePath, `FROM ${baseModel}\nPARAMETER num_ctx ${OPENCODE_CONTEXT_TOKENS}\n`, "utf8");
    const result = spawnSync("ollama", ["create", alias, "-f", modelfilePath], {
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(String(result.stderr || result.stdout || `ollama exited ${result.status}`).trim());
    }
    console.log(`created ollama/${alias} from ${baseModel} with num_ctx=${OPENCODE_CONTEXT_TOKENS}`);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}

export function buildLocalRecommendation(report: LlmfitReport | null, analyzerNote: string): LocalModelRecommendation {
  const system = report?.system ?? fallbackSystem();
  const selected = report ? selectLlmfitModels(report) : { agent: null, content: null };
  const agent = selected?.agent;
  const content = selected?.content;
  const agentBaseModel = agent ? inferredOllamaName(agent)! : report ? null : fallbackAgentForMemory(system.totalRamGb);
  const contentBaseModel = content ? inferredOllamaName(content)! : report ? null : fallbackContentForMemory(system.totalRamGb);
  const contentModel = contentBaseModel ? runtimeContentName(contentBaseModel) : null;
  const agentRuntimeName = agentBaseModel ? runtimeAgentName(agentBaseModel) : null;
  const lowMemory = system.totalRamGb < 14;
  return {
    source: report ? "llmfit" : "memory-tier fallback",
    analyzerNote,
    system,
    agentModel: agentRuntimeName ? `ollama/${agentRuntimeName}` : null,
    agentBaseModel,
    agentContextTokens: OPENCODE_CONTEXT_TOKENS,
    agentValidation: agent
        ? "Hardware-fit candidate only; validate OpenCode tool execution under supervision before repository work."
        : agentBaseModel
          ? "Memory-tier fallback only; validate 32K fit and native OpenCode tool execution before repository work."
          : "No local agent recommendation passed the hardware or minimum-memory gates.",
    contentBaseModel,
    contentModel,
    contentValidation: contentModel
        ? "Hardware-fit candidate only. Check this exact writer and context, then review its task-quality results and a complete artifact."
        : report
          ? "No llmfit content candidate met the quality, 32K-context, Ollama-name, and 25% headroom gates."
          : `No fallback content model is emitted below ${MIN_CONTENT_MEMORY_GB.toFixed(1)} GB total memory.`,
    fitLevel: agent?.fitLevel ?? "not measured",
    memoryRequiredGb: agent?.memoryRequiredGb ?? null,
    estimatedTps: agent?.estimatedTps ?? null,
    rationale: agent
      ? `${agent.name} is a ${agent.fitLevel.toLowerCase()} 32K-context fit with native-tool-family priority and at least 15% headroom in llmfit's evaluated memory pool.`
      : agentBaseModel
        ? `No usable llmfit report was available, so the agent recommendation uses the ${system.totalRamGb.toFixed(1)} GB memory tier.`
        : report
          ? "No llmfit agent candidate passed every gate, so no local agent setup is emitted."
          : `${system.totalRamGb.toFixed(1)} GB is below the ${MIN_AGENT_MEMORY_GB.toFixed(1)} GB minimum fallback tier, so no local agent setup is emitted.`,
    warnings: [
      ...(!report ? ["Install llmfit or explicitly use --use-uvx before relying on this fallback for a purchase or deployment decision."] : []),
      ...(report && !agent ? ["No llmfit agent candidate met the native-tool-family, quality, 32K-context, Ollama-name, and 15% headroom gates; no local agent setup is emitted."] : []),
      ...(report && !content ? ["No local content model met every llmfit gate; no content model or model-check command is emitted."] : []),
      ...(!report && !agentBaseModel ? [`No local agent is emitted below ${MIN_AGENT_MEMORY_GB.toFixed(1)} GB total memory.`] : []),
      ...(!report && !contentBaseModel ? [`No local content model is emitted below ${MIN_CONTENT_MEMORY_GB.toFixed(1)} GB total memory.`] : []),
      ...(lowMemory ? ["Under 14 GB, test smaller local models one task at a time and inspect their output."] : []),
      "llmfit estimates hardware fit, not instruction-following; one live probe is not proof of reliable multi-file engineering.",
      "The OpenCode agent model and AI_CONTENT_MODEL_NAME are separate settings.",
    ],
  };
}

export function formatRecommendation(result: LocalModelRecommendation): string {
  const memoryKind = result.system.unifiedMemory ? "unified memory" : "RAM";
  const metrics = [
    `fit=${result.fitLevel}`,
    result.memoryRequiredGb === null ? null : `estimated memory=${result.memoryRequiredGb.toFixed(2)} GB`,
    result.estimatedTps === null ? null : `estimated speed=${result.estimatedTps.toFixed(1)} tok/s`,
    `context=${result.agentContextTokens}`,
  ].filter(Boolean).join(", ");
  const agentRuntimeName = result.agentModel?.replace(/^ollama\//, "") ?? null;
  const agentLabel = result.agentModel && result.agentBaseModel
    ? `${result.agentModel} (base: ${result.agentBaseModel})`
    : "none (no candidate passed every gate)";
  const agentSetup = result.agentModel && result.agentBaseModel && agentRuntimeName
    ? `  ollama pull ${result.agentBaseModel}\n  npm run models:ollama-profile -- --base ${result.agentBaseModel} --name ${agentRuntimeName}\n  opencode --model ${result.agentModel}`
    : "  No local OpenCode agent setup emitted.";
  const contentLabel = result.contentModel && result.contentBaseModel
    ? `${result.contentModel} (base: ${result.contentBaseModel})`
    : "none (no candidate passed every gate)";
  const contentSetup = result.contentModel && result.contentBaseModel
    ? `${result.contentBaseModel === result.agentBaseModel ? "" : `\n  ollama pull ${result.contentBaseModel}`}\n  npm run models:ollama-profile -- --base ${result.contentBaseModel} --name ${result.contentModel}`
    : "";
  const modelChecks = result.contentModel ? `

MODEL CHECK (macOS/Linux)
  AI_CONTENT_MODEL_PROVIDER=ollama AI_CONTENT_MODEL_NAME=${result.contentModel} npm run model:check

MODEL CHECK (PowerShell)
  $env:AI_CONTENT_MODEL_PROVIDER="ollama"; $env:AI_CONTENT_MODEL_NAME="${result.contentModel}"; npm run model:check` : "";
  const configNote = agentRuntimeName === "qwen3-opencode:8b"
    ? "OpenCode configuration template: examples/opencode.local.example.json"
    : agentRuntimeName
      ? "The bundled OpenCode configuration template is M5/Qwen3-8B-specific; use the emitted --model command for this recommendation."
      : "No OpenCode configuration is emitted because no local agent passed every gate.";
  return `LOCAL MODEL RECOMMENDATION
  Hardware: ${result.system.cpuName}; ${result.system.totalRamGb.toFixed(1)} GB ${memoryKind}; ${result.system.backend}
  Analyzer: ${result.analyzerNote}
  OpenCode agent: ${agentLabel}
  Harness content model: ${contentLabel}
  Evidence: ${metrics}
  Agent validation: ${result.agentValidation}
  Content validation: ${result.contentValidation}
  Why: ${result.rationale}

NEXT COMMANDS
${agentSetup}${contentSetup}${modelChecks}

${configNote}
${result.warnings.map((warning) => `WARNING: ${warning}`).join("\n")}`;
}

export function recommendLocalModels(options: RecommendOptions = {}): LocalModelRecommendation {
  const analysis = runLlmfit(options.useUvx === true);
  const recommendation = buildLocalRecommendation(analysis.report, analysis.note);
  console.log(options.json ? JSON.stringify(recommendation, null, 2) : formatRecommendation(recommendation));
  return recommendation;
}
