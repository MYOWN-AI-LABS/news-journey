import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { activeRoot, authorize, atomicJson, read, contained } from "../workspaces.js";
import { releaseLock } from "../release-lock.js";
import { getEnabledSources } from "../source-preferences.js";
import { sha1 } from "../util.js";
import { fetchPublicApiCatalog, fetchConfiguredPublicApis, fetchPublicApiSample, safePublicUrl, type PublicApiCatalogEntry, type PublicApiEndpointConfig, type Requester } from "./public-apis.js";

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const sportsTerms = /\b(sports?|football|soccer|cricket|basketball|baseball|hockey|tennis|golf|padel|rugby|volleyball|badminton|athletics|olympics?|f1|formula 1|motorsport\w*|nba|nfl|nhl|mlb|cfl|afl|epl|premier league|chess)\b/i;
const families: [RegExp, string[]][] = [
  [/\b(health\w*|medic\w*|clinical|biolog\w*|cancer|pharma\w*)\b/i, ["Health", "Science & Math"]],
  [/\b(ai|artificial intelligence|machine learning|robot\w*|software|coding|developer\w*)\b/i, ["Machine Learning", "Development", "Programming", "Open Source Projects"]],
  [/\b(space\w*|astronom\w*|rocket\w*|quantum|physics|science|research)\b/i, ["Science & Math"]],
  [/\b(climate|environment\w*|energy|ecolog\w*)\b/i, ["Environment", "Weather", "Open Data"]],
  [/\b(financ\w*|invest\w*|econom\w*|bank\w*)\b/i, ["Finance", "Business", "Currency Exchange"]],
];

/** These are executable mappings, not a substitute for searching the full live catalog. */
export function readyEndpoint(entry: PublicApiCatalogEntry, topics: string[]): PublicApiEndpointConfig | undefined {
  const query = topics.join(" ").slice(0, 400);
  const base = { maxItems: 10, timeoutMs: 20000, name: entry.name };
  if (entry.name === "Crossref Metadata Search") return { ...base, id: "crossref", url: `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=10`, itemPath: "message.items", fields: { title: "title.0", url: "URL", summary: "abstract" } };
  if (entry.name === "Europe PMC") return { ...base, id: "europe-pmc", url: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(topics.map(t => `(${t.replace(/[()"\\]/g, " ")})`).join(" OR "))}&format=json&resultType=core&pageSize=10`, itemPath: "resultList.result", fields: { title: "title", url: "fullTextUrlList.fullTextUrl.0.url", summary: "abstractText", publishedAt: "firstPublicationDate" } };
  if (entry.name === "Spaceflight News") return { ...base, id: "spaceflight-news", url: "https://api.spaceflightnewsapi.net/v4/articles/?limit=10", itemPath: "results", fields: { title: "title", url: "url", summary: "summary", publishedAt: "published_at" } };
  if (entry.name === "Launch Library 2") return { ...base, id: "launch-library-2", url: "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=10&mode=list", itemPath: "results", fields: { title: "name", url: "url", summary: "status.description" } };
  if (entry.name === "Dev.to") {
    const tags = ["ai", "python", "javascript", "typescript", "devops", "security", "programming"];
    const tag = tags.find(t => words(query).includes(t)) ?? (/machine learning|artificial intelligence/i.test(query) ? "ai" : "programming");
    return { ...base, id: "dev-to", url: `https://dev.to/api/articles?tag=${tag}&per_page=10`, fields: { title: "title", url: "url", summary: "description", publishedAt: "published_at" } };
  }
}

export interface ApiChoice extends PublicApiCatalogEntry {
  id: string; reason: string; connection: "ready" | "needs-key" | "needs-setup" | "https-required";
  endpoint?: PublicApiEndpointConfig; automatic: boolean;
}

export function matchTopicApis(entries: PublicApiCatalogEntry[], topics: string[], areas: string[] = []): ApiChoice[] {
  const terms = [...topics, ...areas];
  const input = terms.join(" ");
  // Explicit category choices and topic vocabulary both matter; short terms match whole words (AI != retail).
  const matchedFamilies = families.filter(([re]) => re.test(input));
  const inferred = new Set(matchedFamilies.flatMap(([, cats]) => cats.map(c => c.toLowerCase())));
  for (const area of areas) inferred.add(area.toLowerCase());
  const stop = new Set(["and", "the", "for", "with", "of", "in", "to", "a", "an"]);
  const rawTokens = [...new Set(terms.flatMap(words).filter(w => w.length > 1 && !stop.has(w)))];
  // A format/cadence word must not make unrelated subject catalogs a topic match.
  const generic = new Set(['news', 'latest', 'current', 'updates', 'update', 'coverage', 'daily', 'weekly', 'newsletter', 'briefing', 'stories']);
  const specificTokens = rawTokens.filter(t => !generic.has(t));
  const tokens = specificTokens.length ? specificTokens : rawTokens;
  return entries.map(entry => {
    const content = `${entry.name} ${entry.description}`;
    // The upstream Sports & Fitness category also contains medical/fitness APIs.
    // Require actual sports vocabulary for a sports-only category suggestion.
    const sportsCategoryOnly = sportsTerms.test(input) && /^sports?\b/i.test(entry.category) && !sportsTerms.test(content);
    const haystack = new Set(words(`${content} ${sportsCategoryOnly ? '' : entry.category}`));
    const hits = tokens.filter(t => haystack.has(t));
    const categoryMatch = !sportsCategoryOnly && (terms.some(t => t.toLowerCase() === entry.category.toLowerCase()) ||
      inferred.has(entry.category.toLowerCase()) && matchedFamilies.some(([re, cats]) => cats.some(c => c.toLowerCase() === entry.category.toLowerCase()) && re.test(content)));
    const endpoint = readyEndpoint(entry, topics.length ? topics : areas);
    let automatic = false;
    if (endpoint?.id === "crossref") automatic = /\b(research|science|health\w*|medic\w*|biolog\w*|ai|machine learning|artificial intelligence|robot\w*|quantum|climate|education|chem\w*)\b/i.test(input);
    if (endpoint?.id === "europe-pmc") automatic = families[0][0].test(input);
    if (endpoint?.id === "dev-to") automatic = families[1][0].test(input);
    if (endpoint && ["spaceflight-news", "launch-library-2"].includes(endpoint.id)) automatic = /\b(space\w*|astronom\w*|rocket\w*|launch\w*)\b/i.test(input);
    const score = hits.length * 5 + (categoryMatch ? 3 : 0) + (automatic ? 15 : 0);
    const connection: ApiChoice["connection"] = endpoint ? "ready" : entry.https.toLowerCase() !== "yes" ? "https-required" : !/^(no|none|)$/i.test(entry.auth) ? "needs-key" : "needs-setup";
    return { score, choice: { ...entry, id: endpoint?.id ?? "catalog-" + sha1(entry.documentationUrl + entry.name).slice(0, 12), reason: hits.length ? `Matches ${hits.join(", ")}` : `Related to ${entry.category}`, connection, endpoint, automatic } };
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score || a.choice.name.localeCompare(b.choice.name)).map(x => x.choice);
}

export function jsonCollections(value: unknown, path = "", depth = 0): { path: string; records: unknown[] }[] {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.some(x => x && typeof x === "object" && !Array.isArray(x)) ? [{ path, records: value }] : [];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).slice(0, 50).flatMap(([key, child]) => jsonCollections(child, path ? `${path}.${key}` : key, depth + 1));
}
export function recordFields(value: unknown, path = "", depth = 0): { path: string; sample: string }[] {
  if (depth > 5 || value === null || value === undefined || /(?:token|secret|password|authorization|cookie|api.?key)/i.test(path)) return [];
  if (typeof value !== "object") return [{ path, sample: String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100) }];
  return Object.entries(value).slice(0, 50).flatMap(([key, child]) => recordFields(child, path ? `${path}.${key}` : key, depth + 1));
}

export async function connectApi(root: string, endpoint: PublicApiEndpointConfig, request?: Requester, credential?: { name: string; value: string }, managed = false): Promise<number> {
  authorize("manage", { root });
  const quote = credential && ["'", '"', "`"].find(q => !credential.value.includes(q));
  if (credential && (!/^[A-Z][A-Z0-9_]*$/.test(credential.name) || /[\r\n]/.test(credential.value) || !quote)) throw new Error("Unsupported API credential format; use a single-line header value");
  const items = await fetchConfiguredPublicApis({ endpoints: [endpoint] }, request);
  const unlock = releaseLock(root);
  try {
    const file = contained(root, "config/sources.json");
    const cfg = read<any>(file, {});
    const endpoints: PublicApiEndpointConfig[] = cfg.publicApis?.endpoints ?? [];
    const prior = endpoints.find(e => e.id === endpoint.id);
    // Preserve an existing operator mapping; replacing it is a separate deliberate reconnect.
    if (prior && JSON.stringify(prior) !== JSON.stringify(endpoint) && !(managed && cfg.publicApis?.managedEndpoints?.[endpoint.id] === sha1(JSON.stringify(prior)))) throw new Error(`API ${endpoint.id} is already configured differently; existing settings were preserved`);
    const backup = contained(root, "state/source-backups", new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(backup, { recursive: true });
    if (existsSync(file)) copyFileSync(file, contained(backup, "sources.json"));
    cfg.publicApis = { ...cfg.publicApis, endpoints: prior ? endpoints.map(e => e.id === endpoint.id ? endpoint : e) : [...endpoints, endpoint] };
    if (managed) cfg.publicApis.managedEndpoints = { ...cfg.publicApis.managedEndpoints, [endpoint.id]: sha1(JSON.stringify(endpoint)) };
    cfg.enabledSources = [...new Set([...(cfg.enabledSources ?? getEnabledSources(cfg)), "publicApis"])];
    if (credential) {
      const envFile = contained(root, ".env");
      const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
      if (existsSync(envFile)) { copyFileSync(envFile, contained(backup, ".env")); chmodSync(contained(backup, ".env"), 0o600); }
      const next = text + (text && !text.endsWith("\n") ? "\n" : "") + credential.name + "=" + quote + credential.value + quote + "\n";
      const tmp = contained(root, ".env.source-setup.tmp");
      writeFileSync(tmp, next, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, envFile);
    }
    atomicJson(file, cfg);
    const report = read<DiscoveryReport | null>(contained(root, "state/source-discovery.json"), null);
    if (report) {
      report.results = [...report.results.filter(r => r.id !== endpoint.id), { id: endpoint.id, name: endpoint.name, status: "connected", items: items.length, configHash: sha1(JSON.stringify(endpoint)) }];
      if (!report.choices.some(c => c.id === endpoint.id)) report.choices.push({ id: endpoint.id, name: endpoint.name, category: "Custom sources", description: "Connected through guided JSON setup", documentationUrl: endpoint.url, auth: endpoint.headerEnv && Object.keys(endpoint.headerEnv).length ? "apiKey" : "No", https: "Yes", cors: "Unknown", connection: "ready", reason: "Selected by you", automatic: false, endpoint });
      try { saveReport(root, report); } catch (e) { console.error("Connected, but could not update the source report: " + (e as Error).message); }
    }
    return items.length;
  } finally { unlock(); }
}

interface ConnectionResult { id: string; name: string; status: "connected" | "failed"; items?: number; error?: string; configHash?: string }
export interface DiscoveryReport { automatic?: boolean; checkedAt: string; inputHash: string; catalogSize: number; topics: string[]; areas: string[]; choices: ApiChoice[]; results: ConnectionResult[]; catalogError?: string }

function saveReport(root: string, report: DiscoveryReport): void {
  atomicJson(contained(root, "state/source-discovery.json"), report);
  const connected = new Map(report.results.map(r => [r.id, r]));
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your API sources</title><style>body{font:17px/1.6 system-ui;max-width:1050px;margin:40px auto;padding:24px;color:#17362d;background:#f3f5f1}h1{font:42px Georgia}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:16px}article{background:white;border:1px solid #d9e3da;border-radius:12px;padding:20px;overflow-wrap:anywhere}a{color:#126749}small{display:block}code{overflow-wrap:anywhere}.status{font-weight:bold}</style><h1>Your API sources</h1><p>${esc(report.topics.join(", "))}${report.areas.length ? " · " + esc(report.areas.join(", ")) : ""}</p><p>Catalog: ${report.catalogSize} entries · Checked ${esc(report.checkedAt)}. ${report.results.filter(r => r.status === "connected").length} connections passed a live data check.</p>${report.catalogError ? `<p>${esc(report.catalogError)}</p>` : ""}<p>To choose another API, run <code>npm run sources:setup</code>. Supported sources connect after a live check. Other JSON APIs have a guided connection flow; some require an account or key. Refresh with <code>npm run sources:setup -- --auto --refresh</code>.</p><label>Find an API <input id="search" type="search" placeholder="Name, area or keyword" style="font:inherit;padding:8px;max-width:100%;box-sizing:border-box"></label><div class="grid">${report.choices.map(c => { const result = connected.get(c.id); let link = ""; try { link = safePublicUrl(c.documentationUrl, "Documentation"); } catch {} return `<article><h2>${esc(c.name)}</h2><small>${esc(c.category)} · ${esc(c.reason)}</small><p class="status">${esc(result ? result.status === "connected" ? `Connected · ${result.items} sample records` : "Connection failed" : c.connection === "ready" ? "Ready to connect" : c.connection === "needs-key" ? "Account or key required" : c.connection === "https-required" ? "HTTPS endpoint required" : "Guided setup available")}</p><p>${esc(c.description)}</p>${result?.error ? `<p>${esc(result.error)}</p>` : ""}${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Provider documentation</a>` : ""}<small>ID: ${esc(c.id)}</small></article>`; }).join("")}</div>${report.choices.length ? "" : "<p>No matching APIs were found. Add a broader area to your publication brief or connect a JSON API with npm run sources:connect.</p>"}<p>Catalog: <a href="https://github.com/public-apis/public-apis">public-apis/public-apis</a> (<a href="https://github.com/public-apis/public-apis/blob/master/LICENSE">MIT license</a>). Provider access requirements vary.</p><script>document.getElementById('search').addEventListener('input',function(){const q=this.value.toLowerCase();document.querySelectorAll('article').forEach(a=>{a.hidden=!a.textContent.toLowerCase().includes(q)})})</script></html>`;
  writeFileSync(contained(root, "state/sources.html"), html);
}

export async function setupApiSources(root = activeRoot(), options: { automatic?: boolean; refresh?: boolean; select?: string[]; entries?: PublicApiCatalogEntry[]; request?: Requester } = {}): Promise<DiscoveryReport> {
  authorize("manage", { root });
  const cfg = read<any>(contained(root, "config/sources.json"), {});
  const topics: string[] = cfg.editorial?.preferredTopics ?? [];
  const areas: string[] = cfg.editorial?.areas?.focusAreas?.filter((v: string) => v !== "other" && !topics.includes(v)) ?? [];
  if (!topics.length && !areas.length) throw new Error("Choose topics or areas in your publication setup before discovering APIs");
  const inputHash = sha1(JSON.stringify({ topics, areas }));
  const previous = read<DiscoveryReport | null>(contained(root, "state/source-discovery.json"), null);
  if (previous) previous.results = previous.results.filter(r => r.status === "failed" || cfg.enabledSources?.includes("publicApis") && cfg.publicApis?.endpoints?.some((e: PublicApiEndpointConfig) => e.id === r.id && (!r.configHash || r.configHash === sha1(JSON.stringify(e)))));
  if (options.automatic && !options.select && !options.refresh && previous?.automatic && previous.inputHash === inputHash && !previous.catalogError && previous.results.every(r => r.status !== "failed")) {
    saveReport(root, previous);
    console.log(`API discovery already checked. Open ${contained(root, "state/sources.html")}`);
    return previous;
  }
  let entries: PublicApiCatalogEntry[] = [];
  let catalogError: string | undefined;
  try { entries = options.entries ?? await fetchPublicApiCatalog(); }
  catch (e) { catalogError = "Catalog unavailable: " + (e as Error).message; console.log(catalogError); }
  const choices = matchTopicApis(entries, topics, areas);
  const report: DiscoveryReport = { automatic: Boolean(options.automatic && !options.select), checkedAt: new Date().toISOString(), inputHash, catalogSize: entries.length, topics, areas, choices, results: [], ...(catalogError ? { catalogError } : {}) };
  let selected = options.select ? choices.filter(c => options.select!.includes(c.id)) : options.automatic ? choices.filter(c => c.automatic && c.endpoint) : [];
  if (options.select?.some(id => !choices.some(c => c.id === id))) throw new Error("Unknown API selection; run sources:setup to see matching choices");
  if (!options.automatic && !options.select && choices.length) {
    if (!process.stdin.isTTY) throw new Error("Use sources:setup --auto or --select <id,id> outside an interactive terminal");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const filter = (await terminal.question("Filter matching APIs by name or category (Enter for first 25): ")).trim().toLowerCase();
      const visible = choices.filter(c => !filter || `${c.name} ${c.category} ${c.description}`.toLowerCase().includes(filter)).slice(0,25);
      console.log(`Showing ${visible.length} of ${choices.length} topic matches. All matches are in state/sources.html.`);
      visible.forEach((c,i) => console.log(`${i + 1}. ${c.name} · ${c.category} · ${c.connection}\n   ${c.reason}`));
      for (;;) {
        const text = (await terminal.question("Choose API numbers (commas), or Enter to keep existing sources: ")).trim();
        if (!text) break;
        const nums = text.split(",").map(s => Number(s.trim()));
        if (nums.every(n => Number.isInteger(n) && n > 0 && n <= visible.length)) { selected = [...new Set(nums)].map(n => visible[n - 1]); break; }
        console.log("Choose numbers from the list.");
      }
    } finally { terminal.close(); }
  }
  for (const choice of selected) {
    try {
      const prior = cfg.publicApis?.endpoints?.find((e: PublicApiEndpointConfig) => e.id === choice.id);
      const managed = Boolean(options.automatic && choice.endpoint && (!prior || cfg.publicApis?.managedEndpoints?.[choice.id] === sha1(JSON.stringify(prior))));
      const endpoint = managed ? choice.endpoint : prior ?? choice.endpoint;
      const count = endpoint ? await connectApi(root, endpoint, options.request, undefined, managed) : await connectApiWizard(root, choice);
      const installed = read<any>(contained(root, "config/sources.json"), {}).publicApis?.endpoints?.find((e: PublicApiEndpointConfig) => e.id === choice.id);
      report.results.push({ id: choice.id, name: choice.name, status: "connected", items: count, configHash: sha1(JSON.stringify(installed)) });
      console.log(`Connected ${choice.name}: ${count} records with source links`);
    } catch (e) {
      const error = (e as Error).message;
      report.results.push({ id: choice.id, name: choice.name, status: "failed", error });
      console.log(`${choice.name}: ${error}`);
    }
  }
  for (const result of previous?.results ?? []) if (result.status === "connected" && !report.results.some(r => r.id === result.id)) {
    report.results.push(result);
    if (!report.choices.some(c => c.id === result.id)) {
      const old = previous!.choices.find(c => c.id === result.id);
      if (old) report.choices.push({ ...old, reason: "Previously connected; settings preserved" });
    }
  }
  saveReport(root, report);
  console.log(`${choices.length} relevant APIs found. Open ${contained(root, "state/sources.html")}`);
  return report;
}

export async function connectApiWizard(root = activeRoot(), choice?: ApiChoice): Promise<number> {
  authorize("manage", { root });
  if (!process.stdin.isTTY) throw new Error("This API needs guided setup: run npm run sources:connect in a terminal");
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  let envName: string | undefined, previousKey: string | undefined, key: string | undefined;
  try {
    const ask = async (label: string, valid: (s: string) => boolean = s => Boolean(s)) => { for (;;) { const s = (await terminal.question(label)).trim(); if (valid(s)) return s; console.log("Please choose a valid value."); } };
    if (choice) console.log(`${choice.name}\nProvider documentation: ${choice.documentationUrl}\nUse its read-only JSON endpoint; documentation pages are not data endpoints.`);
    const name = choice?.name ?? await ask("API name: ");
    const id = choice?.id ?? "custom-" + sha1(name).slice(0, 12);
    const url = await ask("HTTPS JSON endpoint URL: ", s => { try { safePublicUrl(s, "Endpoint"); return !/[?&](api[_-]?key|token|access_token|secret)=/i.test(s); } catch { return false; } });
    const header = await ask("Authentication header [Enter for no key; commonly X-Api-Key or Authorization]: ", s => !s || /^[A-Za-z0-9-]+$/.test(s) && !/^(host|connection|content-length|transfer-encoding)$/i.test(s));
    const headerEnv: Record<string,string> = {};
    if (header) {
      envName = "PUBLIC_API_" + id.toUpperCase().replace(/-/g, "_") + "_KEY";
      previousKey = process.env[envName];
      process.stdout.write("Header value (hidden; include Bearer if required): "); muted = true;
      try { key = (await terminal.question("")).trim(); } finally { muted = false; process.stdout.write("\n"); }
      if (!key || /[\r\n]/.test(key)) throw new Error("A single-line header value is required");
      process.env[envName] = key; headerEnv[header] = envName;
    }
    const sample = await fetchPublicApiSample({ id, url, headerEnv });
    const collections = jsonCollections(sample);
    if (!collections.length && sample && typeof sample === "object" && !Array.isArray(sample)) collections.push({ path: "", records: [sample] });
    if (!collections.length) throw new Error("This endpoint returned no JSON records");
    let collection = collections[0];
    if (collections.length > 1) {
      collections.forEach((c,i) => console.log(`${i+1}. ${c.path || "Whole response"} (${c.records.length} records)`));
      collection = collections[Number(await ask("Which list contains your content? ", s => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= collections.length)) - 1];
    }
    const sampleRecord = collection.records.find(r => r && typeof r === "object" && !Array.isArray(r));
    const fields = recordFields(sampleRecord);
    fields.forEach((f,i) => console.log(`${i+1}. ${f.path}: ${f.sample}`));
    const choose = async (label: string, required: boolean) => {
      const answer = await ask(label, s => !required && !s || /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= fields.length);
      return answer ? fields[Number(answer)-1].path : undefined;
    };
    const title = (await choose("Which field is the title? (number): ", true))!;
    const itemUrl = (await choose("Which field links to the original record? (number): ", true))!;
    const summary = await choose("Summary field (number, or Enter to skip): ", false);
    const publishedAt = await choose("Publication date field (number, or Enter to skip): ", false);
    const endpoint: PublicApiEndpointConfig = { id, name, url, itemPath: collection.path, maxItems: 20, headerEnv, fields: { title, url: itemUrl, ...(summary ? { summary } : {}), ...(publishedAt ? { publishedAt } : {}) } };
    const count = await connectApi(root, endpoint, undefined, envName && key ? { name: envName, value: key } : undefined);
    console.log(`Connected ${name}; ${count} source records verified. Settings saved in this workspace.`);
    return count;
  } finally {
    terminal.close();
    if (envName) { if (previousKey === undefined) delete process.env[envName]; else process.env[envName] = previousKey; }
  }
}
