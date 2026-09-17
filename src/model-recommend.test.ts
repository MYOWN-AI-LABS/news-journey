import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocalRecommendation,
  canonicalOllamaName,
  officialOllamaCatalogMapping,
  createOllamaProfile,
  fallbackAgentForMemory,
  fallbackContentForMemory,
  formatRecommendation,
  parseLlmfitReport,
  runtimeAgentName,
  runtimeContentName,
  selectLlmfitModels,
} from "./model-recommend.js";

test('only the explicitly documented official family has a catalog lookup; model routes remain exact', () => {
  const match = officialOllamaCatalogMapping('Qwen/Qwen3.5-9B', 'qwen3.5:9b-q4_K_M');
  assert.equal(match?.installedName, 'qwen3.5:9b-q4_K_M');
  assert.equal(match?.registryUrl, 'https://registry.ollama.ai/v2/library/qwen3.5/manifests/9b-q4_K_M');
  assert.equal(match?.quantization, 'Q4_K_M');
  assert.equal(officialOllamaCatalogMapping('Qwen/Qwen3.5-4B', 'qwen3.5:4b')?.registryUrl, 'https://registry.ollama.ai/v2/library/qwen3.5/manifests/4b');
  assert.equal(officialOllamaCatalogMapping('Qwen/Qwen3.5-4B', 'qwen3.5:4b-q4_K_M')?.quantization, 'Q4_K_M');
  for (const [catalog, installed] of [
    ['Other/Qwen3.5-9B', 'qwen3.5:9b-q4_K_M'], ['Qwen/Qwen3.5-4B', 'qwen3.5:9b-q4_K_M'],
    ['Qwen/Qwen3.5-9B', 'qwen3.5:4b-q4_K_M'], ['Qwen/Qwen3.5-9B', 'custom/qwen3.5:9b-q4_K_M'],
    ['Qwen/Qwen3.5-9B', 'qwen3.5:9b-instruct-q4_K_M'], ['Qwen/Qwen3.5-9B', 'qwen3.5:9b-unknown'],
    ['Qwen/Qwen3.5-9B', 'other.example/library/qwen3.5:9b-q4_K_M'],
  ]) assert.equal(officialOllamaCatalogMapping(catalog!, installed!), null);
});

const fixture = {
  models: [
    {
      name: "Qwen/Qwen2.5-Coder-3B-Instruct",
      category: "Coding",
      ollama_name: null,
      installed: false,
      fit_level: "Perfect",
      memory_required_gb: 4.71,
      memory_available_gb: 16,
      estimated_tps: 27.4,
      effective_context_length: 32768,
      score: 80.5,
      score_components: { quality: 73.7 },
      capability_ids: ["tool_use"],
    },
    {
      name: "Qwen/Qwen2.5-Coder-7B-Instruct",
      category: "Coding",
      ollama_name: "qwen2.5-coder:7b",
      installed: true,
      fit_level: "Perfect",
      memory_required_gb: 9.87,
      memory_available_gb: 16,
      estimated_tps: 11.1,
      effective_context_length: 32768,
      score: 79.9,
      score_components: { quality: 88.7 },
      capability_ids: ["tool_use"],
    },
    {
      name: "Qwen/Qwen2.5-Coder-14B-Instruct",
      category: "Coding",
      ollama_name: "qwen2.5-coder:14b",
      installed: true,
      fit_level: "Perfect",
      memory_required_gb: 14.62,
      memory_available_gb: 16,
      estimated_tps: 11.4,
      effective_context_length: 32768,
      score: 75,
      score_components: { quality: 91.7 },
      capability_ids: ["tool_use"],
    },
    {
      name: "Qwen/Qwen3-8B",
      category: "General",
      ollama_name: "qwen3:8b",
      installed: true,
      fit_level: "Perfect",
      memory_required_gb: 13.19,
      memory_available_gb: 16,
      estimated_tps: 10.3,
      effective_context_length: 32768,
      score: 67.4,
      score_components: { quality: 83 },
      capability_ids: ["tool_use"],
    },
    {
      name: "Example/NoTools",
      category: "Coding",
      ollama_name: "no-tools:7b",
      installed: true,
      fit_level: "Perfect",
      effective_context_length: 32768,
      score: 99,
      score_components: { quality: 99 },
      capability_ids: [],
    },
    {
      name: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
      category: "Coding",
      ollama_name: null,
      installed: false,
      fit_level: "Perfect",
      estimated_tps: 55,
      effective_context_length: 32768,
      score: 82,
      score_components: { quality: 58.7 },
      capability_ids: ["tool_use"],
    },
  ],
  system: {
    cpu_name: "Apple M5",
    total_ram_gb: 16,
    backend: "Metal",
    unified_memory: true,
  },
};

test("llmfit selection preserves headroom and separates agent from content models", () => {
  const report = parseLlmfitReport(JSON.stringify(fixture));
  const selected = selectLlmfitModels(report);
  assert.equal(selected.agent?.name, "Qwen/Qwen3-8B");
  assert.equal(selected.content?.name, "Qwen/Qwen2.5-Coder-7B-Instruct");
  const recommendation = buildLocalRecommendation(report, "fixture");
  assert.equal(recommendation.agentModel, "ollama/qwen3-opencode:8b");
  assert.equal(recommendation.agentBaseModel, "qwen3:8b");
  assert.equal(recommendation.contentBaseModel, "qwen2.5-coder:7b");
  assert.equal(recommendation.contentModel, "qwen2.5-coder-32k:7b");
  assert.match(recommendation.agentValidation, /Hardware-fit candidate only/);
  assert.doesNotMatch(JSON.stringify(recommendation), /passed a live|passed the live|2026-08-30/);

  const discreteGpu = parseLlmfitReport(JSON.stringify({
    system: { ...fixture.system, total_ram_gb: 16, unified_memory: false, backend: "CUDA" },
    models: [
      { ...fixture.models[3], name: "Qwen/Qwen3-14B", ollama_name: "qwen3:14b", memory_required_gb: 20, memory_available_gb: 24 },
      { ...fixture.models[2], memory_required_gb: 18, memory_available_gb: 24 },
    ],
  }));
  assert.equal(selectLlmfitModels(discreteGpu).agent?.ollamaName, "qwen3:14b");
  assert.equal(selectLlmfitModels(discreteGpu).content?.ollamaName, "qwen2.5-coder:14b");

  const constrainedGpu = parseLlmfitReport(JSON.stringify({
    system: { ...fixture.system, total_ram_gb: 64, unified_memory: false, backend: "CUDA" },
    models: [{ ...fixture.models[3], memory_required_gb: 7.25, memory_available_gb: 8 }],
  }));
  assert.equal(selectLlmfitModels(constrainedGpu).agent, null);
  const noFitRecommendation = buildLocalRecommendation(constrainedGpu, "fixture");
  assert.equal(noFitRecommendation.agentBaseModel, null);
  assert.equal(noFitRecommendation.agentModel, null);
  assert.doesNotMatch(formatRecommendation(noFitRecommendation), /opencode --model/);
});

test("memory fallback is conservative at common local-hardware tiers", () => {
  assert.equal(fallbackAgentForMemory(7.9), "qwen3:1.7b");
  assert.equal(fallbackAgentForMemory(6.7), null);
  assert.equal(fallbackAgentForMemory(8), "qwen3:1.7b");
  assert.equal(fallbackAgentForMemory(11), "qwen3:4b");
  assert.equal(fallbackAgentForMemory(16), "qwen3:8b");
  assert.equal(fallbackAgentForMemory(32), "qwen3-coder");
  assert.equal(fallbackContentForMemory(16), "qwen2.5-coder:7b");
  assert.equal(fallbackContentForMemory(3.8), null);
  assert.equal(runtimeAgentName("qwen3-coder:30b"), "qwen3-coder-opencode:30b");
  assert.equal(runtimeContentName("qwen2.5-coder:7b"), "qwen2.5-coder-32k:7b");
});

test("Ollama aliases cannot disguise the base through default name parts", () => {
  const canonical = "registry.ollama.ai/library/qwen3:latest";
  assert.equal(canonicalOllamaName("qwen3"), canonical);
  assert.equal(canonicalOllamaName("QWEN3:latest"), canonical);
  assert.equal(canonicalOllamaName("library/qwen3"), canonical);
  assert.equal(canonicalOllamaName(canonical), canonical);
  assert.equal(canonicalOllamaName("team/qwen3"), "registry.ollama.ai/team/qwen3:latest");
  assert.throws(
    () => createOllamaProfile("qwen3", "QWEN3:latest"),
    /default registry, namespace, and tag expansion/
  );
  assert.throws(
    () => createOllamaProfile("qwen3", "library/qwen3:latest"),
    /default registry, namespace, and tag expansion/
  );
  assert.throws(
    () => createOllamaProfile("qwen3", "registry.ollama.ai\/library\/qwen3:latest"),
    /default registry, namespace, and tag expansion/
  );
});

test("human output creates a 32K alias and provides portable model-check commands", () => {
  const recommendation = buildLocalRecommendation(parseLlmfitReport(JSON.stringify(fixture)), "fixture");
  const output = formatRecommendation(recommendation);
  assert.match(output, /--base qwen3:8b --name qwen3-opencode:8b/);
  assert.match(output, /--base qwen2\.5-coder:7b --name qwen2\.5-coder-32k:7b/);
  assert.match(output, /opencode --model ollama\/qwen3-opencode:8b/);
  assert.doesNotMatch(output, /opencode run --model/);
  assert.match(output, /AI_CONTENT_MODEL_NAME=qwen2\.5-coder-32k:7b/);
  assert.match(output, /MODEL CHECK \(macOS\/Linux\)/);
  assert.match(output, /MODEL CHECK \(PowerShell\)/);
  assert.match(output, /\$env:AI_CONTENT_MODEL_PROVIDER="ollama"/);
});

test("llmfit parser rejects malformed reports", () => {
  assert.throws(() => parseLlmfitReport("null"), /must be an object/);
  assert.throws(() => parseLlmfitReport(JSON.stringify({ models: [] })), /models and system/);
  assert.throws(() => parseLlmfitReport("x".repeat(8 * 1024 * 1024 + 1)), /exceeded 8 MiB/);
  assert.throws(
    () => parseLlmfitReport(JSON.stringify({ ...fixture, system: { ...fixture.system, total_ram_gb: 0 } })),
    /total_ram_gb must be a positive finite number/
  );
  const negativeMemory = parseLlmfitReport(JSON.stringify({
    ...fixture,
    models: [{ ...fixture.models[3], memory_required_gb: -1 }],
  }));
  assert.equal(negativeMemory.models[0].memoryRequiredGb, null);
  assert.equal(selectLlmfitModels(negativeMemory).agent, null);
});

test("agent selection rejects known text-only tool behavior and short or unsafe model names", () => {
  const report = parseLlmfitReport(JSON.stringify({
    ...fixture,
    models: [
      fixture.models[1],
      { ...fixture.models[3], effective_context_length: 8192 },
      { ...fixture.models[3], name: "Unsafe", ollama_name: "qwen3:8b;echo nope" },
    ],
  }));
  const selected = selectLlmfitModels(report);
  assert.equal(selected.agent, null);
  assert.equal(selected.content?.name, "Qwen/Qwen2.5-Coder-7B-Instruct");
});

test("an analyzed report never substitutes an agent-only model for missing content", () => {
  const report = parseLlmfitReport(JSON.stringify({ ...fixture, models: [fixture.models[3]] }));
  const recommendation = buildLocalRecommendation(report, "fixture");
  assert.equal(recommendation.contentBaseModel, null);
  assert.equal(recommendation.contentModel, null);
  assert.match(formatRecommendation(recommendation), /Harness content model: none/);
  assert.doesNotMatch(formatRecommendation(recommendation), /MODEL CHECK/);
});

test("untagged Qwen3-Coder is recognized as the preferred agent family", () => {
  const report = parseLlmfitReport(JSON.stringify({
    system: { ...fixture.system, total_ram_gb: 32 },
    models: [{
      ...fixture.models[3],
      name: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      ollama_name: "qwen3-coder",
      category: "Coding",
      memory_required_gb: 15.6,
      memory_available_gb: 32,
      score_components: { quality: 71.2 },
    }],
  }));
  assert.equal(selectLlmfitModels(report).agent?.ollamaName, "qwen3-coder");
  assert.equal(buildLocalRecommendation(report, "fixture").agentModel, "ollama/qwen3-coder-opencode:32k");
});

test('an 8K general text model can be a writing candidate without qualifying for 32K coding', () => {
  const report = parseLlmfitReport(JSON.stringify({ ...fixture, models: [{ ...fixture.models[1], name: 'Fixture/General-4B', ollama_name: 'general:4b', category: 'General', effective_context_length: 8192, memory_required_gb: 4.5, capability_ids: [] }] }));
  const selected = selectLlmfitModels(report, 8192);
  assert.equal(selected.content?.ollamaName, 'general:4b');
  assert.equal(selected.agent, null);
  assert.equal(selectLlmfitModels(report, 32768).content, null);
});
