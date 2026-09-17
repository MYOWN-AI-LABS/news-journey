import { vocabularyLabels } from "./pipeline/selection-policy.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, mkdirSync, copyFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseEnv } from "node:util";
import { releaseLock } from "./release-lock.js";
import { CODE_ROOT, activeRoot, createWorkspace, authorize, contained, atomicJson, read } from "./workspaces.js";
import { validateOpenCodeModel } from "./llm/opencode.js";

export interface ExecutiveBrief {
  name: string; publication: string; audience: string; tone: string;
  topics: string[]; sources: { name: string; url: string }[]; avoid: string[]; notes: string;
  model?: string; modelName?: string; modelUrl?: string; reasoningEffort?: string;
  areas: string[]; publicApis: "auto" | "off";
}
const digest = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const placeholder = /your (name|publication|first topic|second topic)|who you want to reach|your-trusted-publication|\{[^}]+\}/i;

/** Small human-readable contract; no model is needed to configure another model. */
export function parseBrief(input: string): ExecutiveBrief {
  if (input.length > 20000) throw new Error("CONTENT.md exceeds 20,000 characters");
  const text = input.replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "");
  const field = (name: string) => text.match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*)$`, "mi"))?.[1].trim() ?? "";
  const section = (name: string) => text.match(new RegExp(`^##\\s+${name}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "mi"))?.[1].trim() ?? "";
  const list = (name: string) => section(name).split(/\r?\n/).map(s => s.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  const publication = field("Publication"), name = field("Name") || publication, audience = field("Audience"), topics = list("Topics");
  for (const [label, value] of Object.entries({ Publication: publication, Audience: audience, Topics: topics.join(" ") })) {
    if (!value || placeholder.test(value)) throw new Error(`Personalize ${label} in profile/CONTENT.md`);
  }
  const sources = list("Sources").map(line => {
    const link = line.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    const url = new URL(link?.[2] ?? line);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || placeholder.test(url.href) || /\.example$/.test(url.hostname)) throw new Error("Sources must contain real feed URLs without credentials");
    return { name: link?.[1] ?? url.hostname, url: url.href };
  });
  const publicApis = field("Public APIs") || "auto";
  if (!["auto", "off"].includes(publicApis)) throw new Error("Public APIs must be auto or off");
  if (!sources.length && publicApis === "off") throw new Error("Add a trusted RSS feed or set Public APIs: auto to discover sources from your topics");
  const areas = [...list("Areas"), ...field("Areas").split(",").map(s => s.trim()).filter(Boolean)];
  const model = field("Model") || undefined, modelUrl = field("Model URL") || undefined;
  const reasoningEffort = field("Reasoning effort") || undefined;
  if(reasoningEffort && (!["none","low","medium","high","max"].includes(reasoningEffort)||!model||!["ollama","openai-compatible"].includes(model)))throw new Error("Reasoning effort requires Model ollama/openai-compatible and none, low, medium, high or max");
  validateWriter(model, modelUrl);
  if (model === "opencode" && field("Model name")) validateOpenCodeModel(field("Model name"));
  return { name, publication, audience, tone: field("Tone") || "Clear, concise, practical, and grounded in sources", topics, areas, publicApis: publicApis as "auto" | "off", sources, avoid: list("Avoid"), notes: section("Notes"), model, modelName: field("Model name") || undefined, modelUrl, reasoningEffort };
}

function validateWriter(provider?: string, url?: string): void {
  if (provider && !["claude", "codex", "opencode", "zai", "grok", "gemini", "antigravity", "ollama", "bedrock", "openai-compatible"].includes(provider)) throw new Error("Unknown Model; use claude, codex, opencode, zai, grok, gemini, ollama, bedrock or openai-compatible");
  if (url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Model URL must be HTTP(S), with no credentials/query/fragment");
    if (provider === "bedrock") throw new Error("Bedrock uses an AWS region and credential chain, not a Model URL");
    if (["claude", "codex", "opencode"].includes(provider || "")) throw new Error("CLI writers use their selected CLI provider, not a Model URL");
  }
}

/** Change only the writer; publication, source choices and finished drafts are preserved. */
export function saveWriter(root: string, provider: string, name: string, url: string, localRescue?: boolean): void {
  authorize("manage", { root });
  validateWriter(provider, url);
  const model = read<any>(contained(root, "config/model.json"), {});
  if (provider === "opencode") validateOpenCodeModel(name || model.providers?.opencode?.model);
  if (localRescue !== undefined) model.rescue = { ...model.rescue, enabled: localRescue, localTimeoutSeconds: model.rescue?.localTimeoutSeconds ?? 90 };
  model.provider = provider;
  const settings = (model.providers ??= {})[provider === "openai-compatible" ? "openaiCompatible" : provider] ??= {};
  if (name) settings.model = name;
  else if (provider === "codex") delete settings.model;
  if (url) settings.baseUrl = url.replace(/\/$/, "");
  syncModelCredentials(root, CODE_ROOT, provider, true, false);
  atomicJson(contained(root, "config/model.json"), model);
  const briefFile = contained(root, "state/journey-brief.json");
  if (existsSync(briefFile)) atomicJson(briefFile, { ...read<any>(briefFile, {}), model: provider, modelName: settings.model || '', modelUrl: settings.baseUrl || '' });
}

export function configureExecutive(codeRoot = CODE_ROOT, suppliedBrief?: string, preserveModel = false): { root: string; changed: boolean; publication: string } {
  const input = suppliedBrief === undefined ? contained(codeRoot,"profile/CONTENT.md") : "";
  if(suppliedBrief === undefined && !existsSync(input))throw new Error("Run node start.mjs for guided setup, or ask your coding agent to create profile/CONTENT.md from your publication brief.");
  if(suppliedBrief === undefined && !statSync(input).isFile())throw new Error("profile/CONTENT.md must be a file");
  const briefText = suppliedBrief ?? readFileSync(input, "utf8");
  const b = parseBrief(briefText);
  let root = codeRoot === CODE_ROOT ? activeRoot() : join(codeRoot, "workspaces/default");
  if (root === codeRoot || !existsSync(join(root, "workspace.json"))) root = createWorkspace("default", false, codeRoot);
  authorize("manage", { root });
  const unlock = releaseLock(root);
  try {
  if (!preserveModel && b.model === "opencode") validateOpenCodeModel(b.modelName || read<any>(join(root, "config/model.json"), {}).providers?.opencode?.model);
  if (!preserveModel) syncModelCredentials(root, codeRoot, b.model ?? read<{provider?:string}>(join(root, "config/model.json"), {}).provider ?? "claude", Boolean(b.model), suppliedBrief === undefined);
  const marker = join(root, "state/onboarding.json");
  const sourceHash = digest(briefText);
  if (read<{ sourceHash?: string }>(marker, {}).sourceHash === sourceHash) return { root, changed: false, publication: b.publication };
  const config = <T extends Record<string, any>>(name: string) => read<T>(join(root, "config", name + ".json"), {} as T);
  const sources = config("sources");
  const otherSources = existsSync(marker) ? (sources.enabledSources ?? []).filter((id: string) => !["rss", "publicApis", "web"].includes(id)) : [];
  delete sources.webSources; // Fixed discovered pages belong to the previous brief; new setup must discover again.
  sources.enabledSources = [...otherSources, ...(b.sources.length ? ["rss"] : []), ...(b.publicApis !== "off" && sources.enabledSources?.includes("publicApis") && sources.publicApis?.endpoints?.length ? ["publicApis"] : [])];
  sources.publicApis = { ...sources.publicApis, endpoints: sources.publicApis?.endpoints ?? [], setupMode: b.publicApis };
  sources.rss = b.sources;
  sources.editorial = { preferredTopics: b.topics, excludedTopics: b.avoid, selectionNotes: `${b.notes}\nAudience: ${b.audience}. Tone: ${b.tone}.`, areas: { mission: b.notes || `Explain verifiable developments in ${b.topics.join(", ")} for ${b.audience}.`, focusAreas: vocabularyLabels([...b.topics, ...b.areas]), verticals: vocabularyLabels([b.audience]) } };
  const pipeline = config("pipeline");
  pipeline.autonomy = "review"; pipeline.topicsPerRun = 1;
  for (const key of ["siteUrl", "newsletterUrl"]) if (/example\.com/.test(pipeline[key] ?? "")) delete pipeline[key];
  if (/example/.test(pipeline.youtube?.channelUrl ?? "")) delete pipeline.youtube;
  const edition = config("editions/daily-roundup");
  Object.assign(edition, { displayName: b.publication, newsletterTitle: b.publication, newsletterLine: b.publication, prompt: `${b.notes}\nCover ${b.topics.join(", ")} for ${b.audience}.`, source: "harvest", repoRadar: false });
  if (!edition.coverFile || edition.coverFile === "examples/assets/placeholder-cover.svg" || edition.coverFile === "assets/publication-cover.svg" || /^assets\/publication-cover-[a-f0-9]{64}\.svg$/.test(edition.coverFile)) {
    const xml = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!));
    mkdirSync(join(root,"assets"),{recursive:true});
    const cover = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 628" role="img" aria-label="${xml(b.publication)}"><rect width="1200" height="628" fill="#17362d"/><path d="M80 110H240" stroke="#ace3bc" stroke-width="8"/><text x="80" y="290" fill="#f3f5f1" font-family="Georgia,serif" font-size="${Math.min(76,1800/b.publication.length)}">${xml(b.publication)}</text><text x="80" y="375" fill="#ace3bc" font-family="sans-serif" font-size="${Math.min(28,1300/b.audience.length)}">${xml(b.audience)}</text><text x="80" y="535" fill="#f3f5f1" font-family="sans-serif" font-size="26">${xml(b.name)}</text></svg>`;
    edition.coverFile = `assets/publication-cover-${digest(cover)}.svg`;
    if (!existsSync(join(root, edition.coverFile))) writeFileSync(join(root, edition.coverFile), cover);
  }
  const model = config("model");
  if (b.model && !preserveModel) {
    model.provider = b.model;
    const key = b.model === "openai-compatible" ? "openaiCompatible" : b.model;
    const settings = model.providers[key] ??= {};
    if (b.modelName) settings.model = b.modelName;
    if (b.reasoningEffort) settings.reasoningEffort = b.reasoningEffort;
    if (b.modelUrl) settings.baseUrl = b.modelUrl.replace(/\/$/, "");
  }
  const values: Record<string, unknown> = { sources, pipeline, "editions/daily-roundup": edition, model, publisher: { name: b.name, publication: b.publication, audience: b.audience, tone: b.tone } };
  // A dated backup protects prior operator edits; the source hash makes rerunning unchanged intake a no-op.
  const backup = join(root, "state/onboarding-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const [name, value] of Object.entries(values)) {
    const destination = join(root, "config", name + ".json");
    if (existsSync(destination)) { const prior = join(backup, name + ".json"); mkdirSync(dirname(prior), { recursive: true }); copyFileSync(destination, prior); }
    atomicJson(destination, value);
  }
  atomicJson(marker, { sourceHash, configuredAt: new Date().toISOString(), inputs: [suppliedBrief === undefined ? "CONTENT.md" : "browser"], publication: b.publication });
  return { root, changed: true, publication: b.publication };
  } finally { unlock(); }
}

/** Only the chosen model's key crosses this explicit intake boundary; other workspace secrets stay isolated. */
function syncModelCredentials(root: string, codeRoot: string, provider: string, explicitModel: boolean, importLegacy = true): void {
  const keys: Record<string,string> = {zai:"ZAI_API_KEY",grok:"XAI_API_KEY",gemini:"GEMINI_API_KEY","openai-compatible":"OPENAI_COMPATIBLE_API_KEY"};
  const key = keys[provider];
  const file = join(root, ".env");
  let text = existsSync(file) ? readFileSync(file,"utf8") : "";
  const original = text;
  const current = parseEnv(text);
  const set = (name:string, value?:string) => {
    // Model tokens are single-line; preserve every unrelated dotenv byte, including Windows paths.
    if (/[\r\n]/.test(current[name]??"") || /[\r\n]/.test(value??"")) throw new Error(`Use a single-line ${name} in the private .env file`);
    text = text.replace(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*(?:\\r?\\n|$)`,"gm"),"");
    if(value!==undefined) {
      const quote = ["'",'"',"`"].find(q=>!value.includes(q));
      if(!quote) throw new Error(`Unsupported quoting in ${name}; supply this key through the process environment`);
      text += (text&&!text.endsWith("\n")?"\n":"") + name+"="+quote+value+quote+"\n";
      current[name]=value;
    } else delete current[name];
  };
  // A generic key belongs to the workspace's prior provider. It must never shadow a new provider key.
  if(current.AI_CONTENT_MODEL_API_KEY) {
    const prior = current.AI_CONTENT_MODEL_PROVIDER || read<{provider?:string}>(join(root,"config/model.json"),{}).provider;
    const priorKey = prior && keys[prior];
    if(priorKey) { if(!current[priorKey])set(priorKey,current.AI_CONTENT_MODEL_API_KEY);set("AI_CONTENT_MODEL_API_KEY"); }
    else if(prior!==provider) throw new Error("Remove the previous provider's generic AI_CONTENT_MODEL_API_KEY from this workspace before switching providers");
  }
  // An explicit brief selects the model/endpoint. Stale dotenv overrides must not redirect its key.
  if(explicitModel)for(const name of ["AI_CONTENT_MODEL_PROVIDER","AI_CONTENT_MODEL_BASE_URL","AI_CONTENT_MODEL_NAME"]){if(current[name]!==undefined)set(name);}
  for (const [source, explicit] of [[join(codeRoot,".env"),false],[join(codeRoot,"profile/.env"),true]] as const) {
    if (!importLegacy || !key || !existsSync(source)) continue;
    const values = parseEnv(readFileSync(source,"utf8"));
    const sourceProvider = values.AI_CONTENT_MODEL_PROVIDER || (explicit ? provider : read<{provider?:string}>(join(codeRoot,"config/model.json"),{}).provider);
    const value = values[key] || (sourceProvider===provider ? values.AI_CONTENT_MODEL_API_KEY : undefined);
    if (value && (explicit || !current[key]) && current[key] !== value) set(key,value);
  }
  if (text!==original) { const tmp=file+".onboarding.tmp";writeFileSync(tmp,text,{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,file); }
}
