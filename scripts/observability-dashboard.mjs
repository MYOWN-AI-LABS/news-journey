import { activeRoot, authorize, contained, loadWorkspaceEnv } from "../src/workspaces.ts";
loadWorkspaceEnv(); authorize("read");
// OBSERVABILITY DASHBOARD — what shipped, what's still owed, and what was built but never posted.
//
// Run: node scripts/observability-dashboard.mjs   → writes docs/observability-dashboard.html
//
// Sources (all local, plus one optional network check):
//   workdir/videos/*/meta.json → per-video, per-platform post records — the truth for "shipped"
//   config/platforms.json      → which platforms are ENABLED, so "owed" means owed, not N/A
//   workdir/newsletters/*      → which days produced a newsletter issue
//   config/pipeline.json       → optional `siteUrl`, used for a real HEAD check against the public
//                                 archive; omitted entirely when siteUrl is not configured, rather
//                                 than reporting a state this harness cannot back with a real check
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = activeRoot();
const VIDEOS = join(ROOT, "workdir/videos");
const OUT = join(ROOT, "docs/observability-dashboard.html");
const DAYS = Number(process.env.DASH_DAYS || 21);
const OWED_WINDOW_DAYS = Number(process.env.DASH_OWED_WINDOW_DAYS || 3);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Escaping HTML metacharacters does not make a URL safe to put in `href`: `javascript:alert(1)`
 * contains none of `&<>"'`, so `esc()` passes it through untouched, and a click executes it. `rec.url`
 * traces back to a platform's post response — this pipeline's own poster code writes it, but a
 * malformed or unexpected value should render as inert text, not a clickable script trigger. Allow
 * only http(s); anything else (including a malformed URL) is not linked.
 */
function safeHref(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const cfg = (() => { try { return readJson(join(ROOT, "config/pipeline.json")); } catch { return {}; } })();
const PLATFORMS = (() => {
  try { return Object.keys(readJson(join(ROOT, "config/platforms.json"))); } catch { return []; }
})();
const enabled = (() => {
  try {
    const c = readJson(join(ROOT, "config/platforms.json"));
    return Object.fromEntries(PLATFORMS.map((p) => [p, !!c[p]?.enabled]));
  } catch {
    return Object.fromEntries(PLATFORMS.map((p) => [p, false]));
  }
})();

const issueKeyFor = (v) => (v.edition === "daily-roundup" ? v.day : `${v.day}-${v.edition}`);

/**
 * A single real HTTP check per issue, done ONCE at generation time and reported honestly.
 *
 * This is deliberately not the full independent-verifier design the production system has (asking
 * every platform's own API whether a post is actually live) — that is a larger feature this harness
 * does not yet carry. What is here never fabricates a LIVE state: an issue is LIVE only when a
 * request to the configured `siteUrl` actually returned 200 for its exact page, and everything else
 * reports as MISSING (no local source), UNVERIFIED (siteUrl not configured, so nothing was checked),
 * or the exact HTTP status observed.
 */
function archiveState(key) {
  const hasHtml = existsSync(join(ROOT, "workdir/newsletters", `${key}.html`));
  const hasJson = existsSync(join(ROOT, "workdir/newsletters", `${key}.json`));
  const url = cfg.siteUrl ? `${cfg.siteUrl.replace(/\/$/, "")}/issues/${key}.html` : null;
  if (!hasHtml && !hasJson) return { key, url, state: "missing", label: "MISSING", detail: "no local newsletter source" };
  if (!url) return { key, url, state: "unverified", label: "UNVERIFIED", detail: "no siteUrl configured — nothing was checked" };
  let code;
  try {
    code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", url], { encoding: "utf8" }).trim();
  } catch {
    code = "err";
  }
  if (code === "200") return { key, url, state: "live", label: "LIVE", detail: `HTTP ${code}` };
  return { key, url, state: "failure", label: "FAILED", detail: `HTTP ${code}` };
}

const videos = [];
if (existsSync(VIDEOS)) {
  for (const dir of readdirSync(VIDEOS)) {
    const metaPath = join(VIDEOS, dir, "meta.json");
    if (!/^\d{8}/.test(dir) || !existsSync(metaPath)) continue;
    let meta;
    try { meta = readJson(metaPath); } catch { continue; }
    videos.push({
      id: dir,
      day: `${dir.slice(0, 4)}-${dir.slice(4, 6)}-${dir.slice(6, 8)}`,
      edition: meta.edition || "daily-roundup",
      status: meta.status || "?",
      posts: meta.posts || {},
      createdAt: meta.createdAt || null,
      updatedAt: meta.updatedAt || null,
    });
  }
}
videos.sort((a, b) => b.id.localeCompare(a.id));
const recent = videos.filter((v) => v.status !== "rejected").slice(0, DAYS);

const archiveIssues = [];
const seenKeys = new Set();
for (const video of recent) {
  const key = issueKeyFor(video);
  if (seenKeys.has(key)) continue;
  seenKeys.add(key);
  archiveIssues.push({ ...archiveState(key), day: video.day, edition: video.edition });
}
const archiveCounts = Object.fromEntries(
  ["live", "failure", "missing", "unverified"].map((state) => [state, archiveIssues.filter((i) => i.state === state).length])
);

// OWED = actionable backlog, deliberately NOT every historical gap. A platform only counts as owed
// if it's enabled now, the video is approved/posted, there's no post record, and the video is
// recent — an old gap on a platform enabled last week is history, not a to-do.
const cutoff = new Date(Date.now() - OWED_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
const SHIPPABLE = ["approved", "posted"];
const owed = (v, p) => enabled[p] && !v.posts[p] && SHIPPABLE.includes(v.status) && v.day >= cutoff;
const totalOwed = recent.reduce((n, v) => n + PLATFORMS.filter((p) => owed(v, p)).length, 0);

// A production that never reached approved/posted was never attempted on any platform. Without a
// distinct state, a run stuck at "rendered" draws the same faint dot as "platform disabled", and an
// edition can sit unshipped for days while the page still looks clean. This is the failure the
// dashboard exists to catch, so stuck productions get their own state and their own panel.
const stuck = recent.filter((v) => !SHIPPABLE.includes(v.status));

/** Exactly one state per cell — every one visually distinct and named in the legend. */
function cellState(v, p) {
  if (v.posts[p]) return "ok";
  if (!enabled[p]) return "off";
  if (!SHIPPABLE.includes(v.status)) return "stuck";
  if (v.day >= cutoff) return "owed";
  return "missed";
}
const STATE = {
  ok: { mark: "✓", label: "shipped" },
  owed: { mark: "✗", label: "owed — enabled, ready, not posted" },
  stuck: { mark: "◍", label: "never attempted — production never left the pipeline" },
  missed: { mark: "○", label: "missed — real gap, older than the owed window" },
  off: { mark: "—", label: "platform off in config/platforms.json" },
};

const perPlatform = PLATFORMS.map((p) => {
  const applicable = recent.filter((v) => SHIPPABLE.includes(v.status));
  const done = applicable.filter((v) => v.posts[p]).length;
  return { p, enabled: enabled[p], done, total: applicable.length, owed: applicable.filter((v) => owed(v, p)).length };
});

const hhmm = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
};
const ago = (iso) => {
  if (!iso) return "";
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
};
function timing(v) {
  const times = PLATFORMS.map((p) => v.posts[p]?.postedAt).filter(Boolean).sort();
  if (times.length) {
    const span = times.length > 1 && hhmm(times[0]) !== hhmm(times.at(-1)) ? `${hhmm(times[0])}–${hhmm(times.at(-1))}` : hhmm(times[0]);
    return {
      text: `posted ${span}`,
      cls: "t-ok",
      title: PLATFORMS.filter((p) => v.posts[p]?.postedAt).map((p) => `${p} ${hhmm(v.posts[p].postedAt)}`).join(" · "),
    };
  }
  if (v.status.startsWith("failed") || v.status === "rejected") {
    return { text: `failed ${hhmm(v.updatedAt)} · ${ago(v.updatedAt)} ago`, cls: "t-bad", title: `died at ${v.updatedAt || "unknown"}` };
  }
  return { text: v.updatedAt ? `ready ${hhmm(v.updatedAt)} · ${ago(v.updatedAt)} idle` : "", cls: "t-wait", title: `status ${v.status} since ${v.updatedAt || "unknown"}` };
}

const grid = recent
  .map((v) => {
    const cells = PLATFORMS.map((p) => {
      const rec = v.posts[p];
      const st = cellState(v, p);
      const { mark } = STATE[st];
      const when = rec?.postedAt ? ` at ${hhmm(rec.postedAt)}` : "";
      const title = rec ? `${p} — shipped${when}: ${rec.url || rec.id}` : `${p} — ${STATE[st].label}`;
      const href = rec?.url ? safeHref(rec.url) : null;
      const inner = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${mark}</a>` : mark;
      return `<td class="${st}" title="${esc(title)}">${inner}</td>`;
    }).join("");
    const key = issueKeyFor(v);
    const archive = archiveIssues.find((a) => a.key === key) ?? { label: "—", state: "unverified", url: null, detail: "" };
    const archiveHref = archive.url ? safeHref(archive.url) : null;
    const archiveCell = archiveHref
      ? `<td class="archive archive-${archive.state}" title="${esc(`${archive.label} — ${archive.detail}`)}"><a href="${esc(archiveHref)}" target="_blank" rel="noopener">${esc(archive.label)}</a></td>`
      : `<td class="archive archive-${archive.state}" title="${esc(archive.detail)}">${esc(archive.label)}</td>`;
    const ed = v.edition !== "daily-roundup" ? `<span class="ed">${esc(v.edition.replace(/-/g, " "))}</span>` : "";
    const t = timing(v);
    return `<tr><td class="day">${esc(v.day)} ${ed}</td>${cells}${archiveCell}<td class="st ${esc(v.status)}">${esc(v.status)}</td><td class="when ${t.cls}" title="${esc(t.title)}">${esc(t.text)}</td></tr>`;
  })
  .join("\n");

const platformCards = perPlatform
  .map((r) => {
    const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    return `<div class="pcard${r.enabled ? "" : " dim"}">
      <div class="pname">${esc(r.p)}${r.enabled ? "" : ' <span class="tag">off</span>'}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="pmeta">${r.done}/${r.total} · ${pct}%${r.owed ? ` · <b class="warn">${r.owed} owed</b>` : ""}</div>
    </div>`;
  })
  .join("");

const siteUrlHref = cfg.siteUrl ? safeHref(cfg.siteUrl) : null;
const archiveCard = `<div class="pcard archive-card">
  <div class="pname">${siteUrlHref ? `<a href="${esc(siteUrlHref)}" target="_blank" rel="noopener">public archive ↗</a>` : "public archive"}</div>
  <div class="bar"><i style="width:${archiveIssues.length ? Math.round((archiveCounts.live / archiveIssues.length) * 100) : 0}%"></i></div>
  <div class="pmeta">${archiveCounts.live}/${archiveIssues.length} live${archiveCounts.failure ? ` · <b class="warn">${archiveCounts.failure} failed</b>` : ""}${archiveCounts.missing ? ` · ${archiveCounts.missing} missing` : ""}${archiveCounts.unverified ? ` · ${archiveCounts.unverified} unverified` : ""}</div>
</div>`;

const stuckPanel = !stuck.length
  ? ""
  : `<div class="panel">
  <h2>Built but never shipped <span style="color:var(--stuck);font-size:12px">· ${stuck.length}</span></h2>
  <table class="tbl">
    <tr><th>day</th><th>edition</th><th>stopped at</th><th>platforms posted</th></tr>
    ${stuck.map((v) => `<tr>
      <td style="white-space:nowrap">${esc(v.day)}</td>
      <td>${esc(v.edition.replace(/-/g, " "))}</td>
      <td style="color:var(--stuck)">${esc(v.status)}</td>
      <td>${PLATFORMS.filter((p) => v.posts[p]).length} of ${PLATFORMS.filter((p) => enabled[p]).length} enabled</td>
    </tr>`).join("")}
  </table>
  <p style="color:var(--dim);font-size:12px;margin:10px 0 0">A production only posts once its status reaches
  <code>approved</code> or <code>posted</code>. Anything stopped before that was never attempted on any
  platform — the grid below shows <span style="color:var(--stuck)">◍</span> for those rows.</p>
</div>`;

const archiveNote = cfg.siteUrl
  ? `exact-page checks run against ${esc(cfg.siteUrl)} when this page was generated`
  : "no siteUrl configured in config/pipeline.json — archive liveness was not checked";

const html = `<!doctype html><meta charset="utf-8"><title>Observability — News Journey</title>
<style>
:root{--bg:#0c0e16;--panel:#141826;--panel2:#1b2030;--line:#2a3147;--ink:#e8ecf6;--dim:#8b94ad;--ok:#34d399;--owed:#f87171;--stuck:#fbbf24;--missed:#6b7490;--acc:#7c5cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:22px}
h1{font-size:19px;margin:0 0 3px}.sub{color:var(--dim);font-size:12.5px;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:11px;margin-bottom:20px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:13px 15px}
.kpi b{display:block;font-size:23px;letter-spacing:-.5px}.kpi span{color:var(--dim);font-size:12px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px 17px;margin-bottom:16px}
.panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:0 0 12px;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{padding:5px 7px;text-align:center;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.day{text-align:left;white-space:nowrap;color:var(--dim);font-variant-numeric:tabular-nums}
td.ok{color:var(--ok);font-weight:700}
td.owed{color:var(--owed);font-weight:700}
td.stuck{color:var(--stuck);font-weight:700}
td.missed{color:var(--missed)}
td.off{color:#2c3348}
td.ok a{color:var(--ok);text-decoration:none}td.ok a:hover{text-decoration:underline}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:11.5px;color:var(--dim);margin-top:10px}
.legend span b{font-weight:700;margin-right:5px;font-size:13px}
.ed{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:0 5px;font-size:10px;color:var(--acc);margin-left:5px}
td.st{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
td.when{text-align:left;white-space:nowrap;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dim)}
td.when.t-ok{color:var(--ok)}td.when.t-bad{color:var(--owed)}td.when.t-wait{color:var(--stuck)}
td.archive{font-size:10px;font-weight:750;letter-spacing:.035em;white-space:nowrap}
.archive a{text-decoration:none}.archive a:hover{text-decoration:underline}
.archive-live,.archive-live a{color:var(--ok)}
.archive-failure,.archive-failure a{color:var(--owed)}
.archive-missing,.archive-missing a{color:var(--missed)}
.archive-unverified,.archive-unverified a{color:var(--dim)}
.pgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:11px}
.pcard{background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:11px 12px}.pcard.dim{opacity:.45}
.pname{font-size:12.5px;font-weight:600;text-transform:capitalize;margin-bottom:7px}
.tag{font-size:9.5px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px;text-transform:uppercase}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;color:var(--dim);font-weight:500;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:0 10px 6px 0;border-bottom:1px solid var(--line)}
.tbl td{padding:6px 10px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr:last-child td{border-bottom:0}
.bar{height:5px;background:#0e1220;border-radius:3px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),#a78bfa)}
.pmeta{color:var(--dim);font-size:11.5px;margin-top:6px}.warn{color:var(--owed)}
.archive-card{border-color:color-mix(in srgb,var(--acc) 62%,var(--line))}
.foot{color:var(--dim);font-size:11.5px;margin-top:6px}
a{color:var(--acc)}
</style>
<h1>Observability — News Journey</h1>
<div class="sub">Last ${recent.length} productions · generated ${esc(new Date().toISOString().replace("T", " ").slice(0, 16))}</div>

<div class="kpis">
  <div class="kpi"><b>${recent.reduce((n, v) => n + PLATFORMS.filter((p) => v.posts[p]).length, 0)}</b><span>posts shipped</span></div>
  <div class="kpi"><b style="${totalOwed ? "color:var(--owed)" : ""}">${totalOwed}</b><span>owed (last ${OWED_WINDOW_DAYS} days)</span></div>
  <div class="kpi"><b style="${stuck.length ? "color:var(--stuck)" : ""}">${stuck.length}</b><span>built but never shipped</span></div>
  <div class="kpi"><b>${archiveCounts.live ?? 0}</b><span>archive issues verified live</span></div>
</div>
${stuckPanel}

<div class="panel">
  <h2>Per-platform coverage</h2>
  <div class="pgrid">${archiveCard}${platformCards}</div>
</div>

<div class="panel">
  <h2>What shipped, what's owed</h2>
  <table>
    <tr><th style="text-align:left">Day</th>${PLATFORMS.map((p) => `<th>${esc(p.slice(0, 2))}</th>`).join("")}<th>Archive</th><th>Status</th><th style="text-align:left">When</th></tr>
    ${grid || `<tr><td colspan="${PLATFORMS.length + 3}" style="color:var(--dim)">no productions found in workdir/videos</td></tr>`}
  </table>
  <div class="legend">
    <span><b style="color:var(--ok)">✓</b>shipped — click to open the live post</span>
    <span><b style="color:var(--owed)">✗</b>owed — enabled, ready, not posted (last ${OWED_WINDOW_DAYS} days)</span>
    <span><b style="color:var(--stuck)">◍</b>never attempted — production never left the pipeline</span>
    <span><b style="color:var(--missed)">○</b>missed — real gap, older than the owed window</span>
    <span><b style="color:#2c3348">—</b>platform off in config</span>
    <span><b style="color:var(--ok)">LIVE</b>archive page returned HTTP 200 when checked</span>
    <span><b style="color:var(--owed)">FAILED</b>local issue exists, archive page did not return 200</span>
    <span><b style="color:var(--missed)">MISSING</b>no local newsletter source for that day</span>
  </div>
  <div class="foot">Columns: ${PLATFORMS.map((p) => `${p.slice(0, 2)}=${p}`).join(" · ") || "no platforms configured"} · ${archiveNote}.</div>
</div>
`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
console.log(`  ${recent.reduce((n, v) => n + PLATFORMS.filter((p) => v.posts[p]).length, 0)} posts shipped · ${totalOwed} owed · ${stuck.length} built-but-not-shipped`);
