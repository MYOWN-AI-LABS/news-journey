import { validDay, safeId, contained } from "./workspaces.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Script, Topic } from "./types.js";
import { NEWSLETTER_DIR } from "./pipeline/newsletter.js";
import { VIDEOS_DIR, normalizeUrl, readJson, todayStamp, log } from "./util.js";
import { publicResponse, safePublicUrl } from "./sources/public-apis.js";

export interface UrlCheck {
  url: string;
  ok: boolean;
  status: number | string;
  context: string;
}

/** HEAD-check (GET fallback — some sites reject HEAD) that a cited URL actually resolves. */
export async function checkUrl(url: string, context: string, request: typeof publicResponse = publicResponse): Promise<UrlCheck> {
  let target: string;
  try { target = safePublicUrl(url, "Cited source"); }
  catch (error) { return { url, ok: false, status: (error as Error).message.slice(0, 100), context }; }
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await request(target, { "User-Agent": "Content-Harness/0.2" }, 12_000, 5_000_000, method);
      if (res.ok) return { url, ok: true, status: res.status, context };
      if (method === "GET") {
        // 401/403/429 = bot-block: the page EXISTS, the server just refuses our automated request
        // (e.g. OpenAI returns 403 to curl/fetch but 200 in a browser). It resolves for humans, so it
        // is NOT a dead link — count it live so the newsletter doesn't drop a valid story (and validate
        // doesn't fail on it). Only 404/410/unreachable are truly dead.
        const botBlock = [401, 403, 429].includes(res.status);
        return { url, ok: botBlock, status: res.status, context };
      }
    } catch (e) {
      const message = (e as Error).message;
      // Shared transport rejects all 3xx+ responses. Preserve the existing bot-block distinction
      // only after a completed public connection; a DNS/private/redirect failure cannot count live.
      const status = message.match(/^Public API HTTP (\d{3}); redirects are not followed$/)?.[1];
      if (method === "GET") return { url, ok: Boolean(status && [401, 403, 429].includes(Number(status))), status: status ? Number(status) : message.slice(0, 100), context };
    }
  }
  return { url, ok: false, status: "unreachable", context };
}

export async function checkUrls(entries: { url: string; context: string }[]): Promise<UrlCheck[]> {
  const unique = new Map(entries.map((e) => [e.url, e]));
  return Promise.all([...unique.values()].map((e) => checkUrl(e.url, e.context)));
}

/** Validate every URL cited by a day's outputs (newsletter issue + video topics).
 *  Returns dead links; used by the CLI, the pre-publish hook, and CI-style checks. */
export async function validateDay(day = todayStamp(), editionId?: string): Promise<UrlCheck[]> {
  validDay(day); if (editionId) safeId(editionId);
  const entries: { url: string; context: string }[] = [];
  const key = editionId && editionId !== "daily-roundup" ? `${day}-${editionId}` : day; // edition-scoped issue

  // H3: when scoped to one edition, validate just it; otherwise validate EVERY issue for the day
  // (daily + any weekly edition) — weekly editions were previously never URL-validated on any path.
  const issueFiles = editionId
    ? [`${key}.json`].filter((f) => existsSync(join(NEWSLETTER_DIR, f)))
    : (existsSync(NEWSLETTER_DIR) ? readdirSync(NEWSLETTER_DIR).filter((f) => new RegExp(`^${day}(-[a-z0-9-]+)?\\.json$`).test(f)) : []);
  for (const f of issueFiles) {
    const d = readJson<{ issue: { lead: { sourceUrl: string; title: string }; items: { url: string; name: string }[]; radar: { url: string; repo: string }[]; signals: { url: string; source: string }[] } }>(join(NEWSLETTER_DIR, f));
    entries.push({ url: d.issue.lead.sourceUrl, context: `${f} lead: ${d.issue.lead.title}` });
    d.issue.items.forEach((i) => entries.push({ url: i.url, context: `${f} item: ${i.name}` }));
    d.issue.radar.forEach((r) => entries.push({ url: r.url, context: `${f} repo radar: ${r.repo}` }));
    d.issue.signals.forEach((s) => entries.push({ url: s.url, context: `${f} signal: ${s.source}` }));
  }

  if (existsSync(VIDEOS_DIR)) {
    for (const id of readdirSync(VIDEOS_DIR).filter((i) => i.startsWith(day.replace(/-/g, "")))) {
      const topic = readJson<Topic>(join(VIDEOS_DIR, id, "topic.json"));
      entries.push({ url: topic.primaryUrl, context: `video ${id}: primary` });
      (topic.stories ?? []).forEach((s) => entries.push({ url: s.primaryUrl, context: `video ${id}: ${s.headline}` }));
      const scriptPath = join(VIDEOS_DIR, id, "script.json");
      if (existsSync(scriptPath)) {
        const script = readJson<Script>(scriptPath);
        const urlRe = /https?:\/\/[^\s)\]]+/g;
        (script.publish.description.match(urlRe) ?? []).forEach((u) =>
          entries.push({ url: u.replace(/[.,]$/, ""), context: `video ${id}: description` })
        );
      }
    }
  }

  if (entries.length === 0) {
    log(`validate: nothing to check for ${day}`);
    return [];
  }

  // Use the same complete-event comparison as the preview and publication gates.
  const repeats: UrlCheck[] = [];
  const { crossPipelineCheck } = await import("./pipeline/cross-pipeline-check.js");
  for (const file of issueFiles) {
    const issue = readJson<{ sourceVideoId?: string; video?: { id: string } }>(join(NEWSLETTER_DIR, file));
    const id = issue.sourceVideoId ?? issue.video?.id;
    if (!id) continue; // URL-only legacy history is uncertain, not a duplicate verdict.
    safeId(id);
    const topicPath = contained(VIDEOS_DIR, id, "topic.json");
    if (!existsSync(topicPath)) continue;
    const topic = readJson<Topic>(topicPath);
    const result = await crossPipelineCheck((topic.stories ?? []).map(story => story.primaryUrl), day, id, 30, topic.stories);
    for (const repeat of result.repeats) repeats.push({ url: repeat.url, ok: false, status: "REPEAT", context: `same supported event in ${repeat.foundIn}` });
  }
  for (const r of repeats) log(`🔁 [REPEAT] ${r.url}  (${r.context})`);
  const results = await checkUrls(entries);
  // 401/403/429 = bot-blocked, not dead — those resolve fine for humans in a browser
  const isWarn = (r: UrlCheck) => [401, 403, 429].includes(r.status as number);
  const dead = results.filter((r) => !r.ok && !isWarn(r));
  for (const r of results) {
    log(`${r.ok ? "✅" : isWarn(r) ? "⚠️ " : "❌"} [${r.status}] ${r.url}  (${r.context})`);
  }
  const problems = [...dead, ...repeats];
  log(
    problems.length === 0
      ? `validate: all ${results.length} cited URLs live, no repeated coverage`
      : `validate: ${dead.length} dead link(s), ${repeats.length} repeat(s) — fix before publishing`
  );
  return problems;
}
