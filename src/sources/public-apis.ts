import type { HarvestItem } from "../types.js";
import { log, sha1 } from "../util.js";
import { request } from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";

export const PUBLIC_APIS_CATALOG_URL =
  "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md";

export interface PublicApiCatalogEntry {
  category: string;
  name: string;
  description: string;
  documentationUrl: string;
  auth: string;
  https: string;
  cors: string;
}

export interface PublicApiCatalogSearch {
  query?: string;
  categories?: string[];
  auth?: string[];
  httpsOnly?: boolean;
  limit?: number;
}

export interface PublicApiEndpointConfig {
  id: string;
  name: string;
  url: string;
  canonicalUrl?: string;
  itemPath?: string;
  maxItems?: number;
  timeoutMs?: number;
  headerEnv?: Record<string, string>;
  fields: {
    title: string;
    url?: string;
    summary?: string;
    publishedAt?: string;
    score?: string;
  };
}

export interface PublicApisConfig {
  catalog?: PublicApiCatalogSearch;
  endpoints: PublicApiEndpointConfig[];
}

export type Requester = (url: string, init?: RequestInit) => Promise<Response>;

function markdownText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function parsePublicApisMarkdown(markdown: string): PublicApiCatalogEntry[] {
  const entries: PublicApiCatalogEntry[] = [];
  let category = "";
  let inCatalogTable = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      category = markdownText(heading[1]);
      inCatalogTable = false;
      continue;
    }
    const normalized = line.replace(/^\|/, "").replace(/\|$/, "").toLowerCase();
    if (/^api\s*\|\s*description\s*\|\s*auth\s*\|\s*https\s*\|\s*cors/.test(normalized)) {
      inCatalogTable = Boolean(category);
      continue;
    }
    if (!inCatalogTable || !line.startsWith("|")) continue;
    if (/^\|?\s*:?-+/.test(line)) continue;
    const cells = tableCells(line);
    if (cells.length < 5) continue;
    const link = cells[0].match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)/i);
    if (!link) continue;
    entries.push({
      category,
      name: markdownText(link[1]),
      documentationUrl: link[2].trim(),
      description: markdownText(cells[1]),
      auth: markdownText(cells[2]),
      https: markdownText(cells[3]),
      cors: markdownText(cells[4]),
    });
  }
  if (entries.length === 0) throw new Error("Public APIs catalog contained no parseable API tables");
  return entries;
}

function normalizedAuth(value: string): string {
  return value.trim().toLowerCase() === "none" ? "no" : value.trim().toLowerCase();
}

export function searchPublicApiCatalog(
  entries: PublicApiCatalogEntry[],
  search: PublicApiCatalogSearch = {}
): PublicApiCatalogEntry[] {
  const query = search.query?.trim().toLowerCase();
  const categories = new Set((search.categories ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const auth = new Set((search.auth ?? []).map(normalizedAuth).filter(Boolean));
  const limit = Math.max(1, Math.min(search.limit ?? 20, 100));
  return entries
    .filter((entry) => categories.size === 0 || categories.has(entry.category.toLowerCase()))
    .filter((entry) => auth.size === 0 || auth.has(normalizedAuth(entry.auth)))
    .filter((entry) => !search.httpsOnly || entry.https.toLowerCase() === "yes")
    .filter((entry) => !query || `${entry.name} ${entry.description} ${entry.category}`.toLowerCase().includes(query))
    .slice(0, limit);
}

export async function fetchPublicApiCatalog(request?: Requester): Promise<PublicApiCatalogEntry[]> {
  const response = request
    ? await request(PUBLIC_APIS_CATALOG_URL)
    : await publicResponse(PUBLIC_APIS_CATALOG_URL, { Accept: "text/plain" }, 15_000);
  if (!response.ok) throw new Error(`Public APIs catalog HTTP ${response.status}`);
  return parsePublicApisMarkdown(await response.text());
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host.includes(".") && !isIP(host)) return true;
  if (host === "localhost" || /\.(localhost|local|internal|lan)$/.test(host)) return true;
  if (isIP(host) === 6) {
    // Only global unicast; reject mapped IPv4, loopback, link-local and documentation ranges.
    const first = parseInt(host.split(":")[0], 16);
    return !Number.isFinite(first) || first < 0x2000 || first > 0x3fff || host.startsWith("2001:db8:");
  }
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    // Only 192.0.0.0/24 and 192.0.2.0/24 are reserved; the rest of 192.0.x.x is public (192.0.78.x serves every
    // WordPress.com site, e.g. a transit agency's blog, which a /16 test refused as "private").
    (parts[0] === 192 && (parts[1] === 168 || parts[1] === 0 && [0, 2].includes(parts[2]))) ||
    (parts[0] === 198 && ([18, 19].includes(parts[1]) || parts[1] === 51 && parts[2] === 100)) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}

export function safePublicUrl(raw: string, label: string, base?: string): string {
  let url: URL;
  try { url = new URL(raw, base); } catch { throw new Error(`${label} is not a valid URL`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  if (isPrivateHostname(url.hostname)) throw new Error(`${label} must not target a private or local host`);
  url.hash = "";
  return url.toString();
}

export function readPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (typeof current === "object") return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** Pin the actual connection to public DNS answers; never follow redirects carrying API keys. */
export function publicResponse(url: string, headers: Record<string, string>, timeoutMs: number, maxBytes = 5_000_000, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(safePublicUrl(url, "Public source"), {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      lookup(host, options, callback) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) return callback(error, "", 4);
          if (!addresses.length || addresses.some(a => isPrivateHostname(a.address))) return callback(new Error("Public API DNS resolved to a private or local address"), "", 4);
          const selected = addresses.find(a => !options.family || a.family === options.family) ?? addresses[0];
          if (options.all) callback(null, [selected] as any);
          else callback(null, selected.address, selected.family);
        });
      },
    }, response => {
      if ((response.statusCode ?? 500) >= 300) {
        response.resume(); reject(new Error(`Public API HTTP ${response.statusCode}; redirects are not followed`)); return;
      }
      if ([204, 205].includes(response.statusCode ?? 0)) { response.resume(); reject(new Error("Public API returned no content")); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new Error(`Public response exceeds ${maxBytes} bytes`));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => { try { resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([,v]) => typeof v === "string") as [string,string][]) })); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function endpointHeaders(headerEnv: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Content-Harness/0.2" };
  for (const [header, envName] of Object.entries(headerEnv)) {
    if (!/^[A-Za-z0-9-]+$/.test(header) || /^(host|connection|content-length|transfer-encoding)$/i.test(header)) throw new Error("Unsupported Public API authentication header");
    if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) throw new Error(`Public API header ${header} has invalid environment variable name`);
    const value = process.env[envName]?.trim();
    if (!value) throw new Error(`Public API header ${header} requires environment variable ${envName}`);
    headers[header] = value;
  }
  return headers;
}

export async function fetchPublicApiSample(endpoint: Pick<PublicApiEndpointConfig, "id" | "url" | "headerEnv" | "timeoutMs">, request?: Requester): Promise<unknown> {
  const url = safePublicUrl(endpoint.url, `Public API endpoint ${endpoint.id}`);
  const headers = endpointHeaders(endpoint.headerEnv);
  const response = request
    ? await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) })
    : await publicResponse(url, headers, Math.max(1_000, Math.min(endpoint.timeoutMs ?? 15_000, 30_000)));
  return responseJson(response, endpoint);
}

function validateEndpoint(endpoint: PublicApiEndpointConfig): void {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(endpoint.id)) throw new Error(`Invalid public API endpoint id: ${endpoint.id}`);
  if (!endpoint.name.trim()) throw new Error(`Public API endpoint ${endpoint.id} needs a name`);
  if (!endpoint.fields?.title?.trim()) throw new Error(`Public API endpoint ${endpoint.id} needs fields.title`);
  if (!endpoint.fields.url?.trim() && !endpoint.canonicalUrl?.trim()) {
    throw new Error(`Public API endpoint ${endpoint.id} needs fields.url or canonicalUrl for provenance`);
  }
  safePublicUrl(endpoint.url, `Public API endpoint ${endpoint.id}`);
  if (endpoint.canonicalUrl) safePublicUrl(endpoint.canonicalUrl, `Public API canonicalUrl ${endpoint.id}`);
}

async function responseJson(response: Response, endpoint: Pick<PublicApiEndpointConfig, "id">): Promise<unknown> {
  if (!response.ok) throw new Error(`Public API ${endpoint.id} HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 5_000_000) throw new Error(`Public API ${endpoint.id} response exceeds 5 MB`);
  const body = await response.arrayBuffer();
  if (body.byteLength > 5_000_000) throw new Error(`Public API ${endpoint.id} response exceeds 5 MB`);
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new Error(`Public API ${endpoint.id} returned invalid JSON`); }
}

export async function fetchConfiguredPublicApis(
  config: PublicApisConfig,
  request?: Requester
): Promise<HarvestItem[]> {
  if (!config?.endpoints?.length) throw new Error("publicApis is enabled but publicApis.endpoints is empty");
  const ids = new Set<string>();
  const items: HarvestItem[] = [];
  for (const endpoint of config.endpoints) {
    validateEndpoint(endpoint);
    if (ids.has(endpoint.id)) throw new Error(`Duplicate public API endpoint id: ${endpoint.id}`);
    ids.add(endpoint.id);
    const endpointUrl = safePublicUrl(endpoint.url, `Public API endpoint ${endpoint.id}`);
    const payload = await fetchPublicApiSample(endpoint, request);
    const selected = readPath(payload, endpoint.itemPath);
    const records = Array.isArray(selected) ? selected : selected && typeof selected === "object" ? [selected] : [];
    if (records.length === 0) throw new Error(`Public API ${endpoint.id} itemPath returned no records`);
    const maxItems = Math.max(1, Math.min(endpoint.maxItems ?? 20, 100));
    for (const record of records.slice(0, maxItems)) {
      const title = textValue(readPath(record, endpoint.fields.title)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!title) continue;
      const recordUrl = endpoint.fields.url ? textValue(readPath(record, endpoint.fields.url)).trim() : "";
      if (!recordUrl && !endpoint.canonicalUrl) continue;
      const url = recordUrl
        ? safePublicUrl(recordUrl, `Public API item URL ${endpoint.id}`, endpointUrl)
        : safePublicUrl(endpoint.canonicalUrl!, `Public API canonicalUrl ${endpoint.id}`);
      // Each of these mirrors the `url` guard above: readPath("", path) with an UNSET path returns
      // the entire record (that's the behavior itemPath needs — "no path" means "the whole
      // payload"), so an endpoint config that leaves an optional field unmapped must never reach
      // readPath with `undefined` here, or the whole raw record gets stringified into that field.
      // Discovered live: an endpoint configured without `fields.summary` shipped the complete JSON
      // record (image URLs, license metadata, internal ids) as the story summary.
      const summary = endpoint.fields.summary
        ? textValue(readPath(record, endpoint.fields.summary)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000)
        : "";
      const publishedRaw = endpoint.fields.publishedAt ? textValue(readPath(record, endpoint.fields.publishedAt)).trim() : "";
      const publishedDate = publishedRaw ? new Date(publishedRaw) : null;
      const scoreRaw = endpoint.fields.score ? Number(readPath(record, endpoint.fields.score)) : NaN;
      const source = `public-api:${endpoint.id}` as const;
      items.push({
        id: sha1(`${source}:${url}:${title}`),
        source,
        title,
        url,
        score: Number.isFinite(scoreRaw) ? scoreRaw : 0,
        publishedAt: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : null,
        repo: null,
        summary,
      });
    }
    log(`Public API ${endpoint.id}: ${items.filter((item) => item.source === `public-api:${endpoint.id}`).length} items`);
  }
  if (items.length === 0) throw new Error("Configured public APIs returned no usable items with title and provenance URL");
  return items;
}
