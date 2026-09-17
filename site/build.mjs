import { publisher } from "../src/publisher.ts";
import { activeRoot, authorize, contained, loadWorkspaceEnv } from "../src/workspaces.ts";
loadWorkspaceEnv(); authorize("read");
// Example Signal — static archive site generator.
// Reads the pipeline's generated newsletter editions (workdir/newsletters/<key>.html
// + <key>.json metadata) and emits a self-contained static site into site/public:
//   /               → branded archive index (all issues, newest first)
//   /issues/<key>   → the exact rich HTML edition, copied verbatim
// Run: node site/build.mjs   (or: npm run site)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = activeRoot();
const brand = publisher();
const NL = join(ROOT, "workdir", "newsletters");
const OUT = contained(ROOT, "site/public");
const ISSUES = join(OUT, "issues");
const NEWSLETTER_URL = process.env.NEWSLETTER_URL ?? "";
const YOUTUBE_URL = process.env.YOUTUBE_URL ?? "";
// Where on-site subscribe forms POST the email. Empty string = route subscribers to the
// LinkedIn newsletter (the live subscription). Set to an ESP endpoint (Buttondown / ConvertKit
// / a Vercel serverless fn) to capture emails on-site.
const SUBSCRIBE_ENDPOINT = process.env.SUBSCRIBE_ENDPOINT ?? "";

const gateCss = readFileSync(join(HERE, "gate.css"), "utf8");
const gateJs = readFileSync(join(HERE, "gate.js"), "utf8");
const GATE_HEAD = `<style>${gateCss}</style>`;
const GATE_BODY =
  `<script>window.DS_SUB=${JSON.stringify({ endpoint: SUBSCRIBE_ENDPOINT, linkedin: NEWSLETTER_URL })}</script>` +
  `<script>${gateJs}</script>`;

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Edition metadata comes only from the committed fictional beta configurations.
const EDITIONS = readdirSync(join(ROOT, "config", "editions"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(ROOT, "config", "editions", name), "utf8")))
  .map((edition) => ({ id: edition.editionId, label: edition.displayName, accent: edition.videoAccent }))
  .sort((a, b) => Number(b.id === "daily-roundup") - Number(a.id === "daily-roundup") || a.label.localeCompare(b.label));
if (!EDITIONS.some((edition) => edition.id === "daily-roundup")) throw new Error("config/editions/daily-roundup.json is required");
const editionOf = (key) => {
  const m = key.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  const id = m ? m[1] : "daily-roundup";
  const edition = EDITIONS.find((e) => e.id === id);
  if (!edition) throw new Error(`Unknown edition artifact: ${key}`);
  return edition;
};

const keys = readdirSync(NL)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5));
const editionsByKey = new Map(keys.map((key) => [key, editionOf(key)]));

rmSync(ISSUES, { recursive: true, force: true });
mkdirSync(ISSUES, { recursive: true });

const issues = [];
for (const key of keys) {
  const htmlPath = join(NL, `${key}.html`);
  if (!existsSync(htmlPath)) continue;
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(NL, `${key}.json`), "utf8"));
  } catch {}
  const date = meta.date || key.slice(0, 10);
  issues.push({
    key,
    date,
    dateLong: meta.dateLong || date,
    issueNo: meta.issueNo,
    subject: meta.issue?.subject || meta.issue?.lead?.title || key,
    leadTitle: meta.issue?.lead?.title || "",
    badge: meta.editionBadge || null,
    edition: editionsByKey.get(key),
  });
  let html = readFileSync(htmlPath, "utf8");
  html = html.replace(/data:video\/[a-z0-9.;+-]*;base64,[A-Za-z0-9+/=]+/gi, "");
  // The embedded-video panel is now empty → remove it, and repoint "WATCH VIDEO" from the panel
  // toggle to the posted LinkedIn/YouTube permalink. Drop the affordance if the video isn't
  // publicly posted yet (videoUrl still a localhost placeholder).
  html = html.replace(/\s*<div class="vidpanel" id="bvidpanel">[\s\S]*?<\/div>\s*/, "\n    ");
  // Private-beta archives do not emit external watch links from generated runtime metadata.
  html = html.replace(/ &nbsp;·&nbsp; <a href="#" id="bwatch" role="button">WATCH VIDEO ▾<\/a>/, "");
  // Inject the subscriber gate (teaser + subscribe wall) into every issue page.
  html = html.replace("</body>", `${GATE_HEAD}${GATE_BODY}</body>`);
  writeFileSync(join(ISSUES, `${key}.html`), html);
}

// newest first; same-day: keep the daily first, editions after
issues.sort((a, b) => b.date.localeCompare(a.date) || a.key.length - b.key.length || a.key.localeCompare(b.key));

const featured = issues[0];
const cards = issues
  .map(
    (it) => `
    <a class="card" data-ed="${it.edition.id}" href="issues/${esc(it.key)}.html">
      <span class="badge" style="color:${it.edition.accent}">${esc(it.badge || `ISSUE № ${it.issueNo ?? ""}`)}</span>
      <span class="date">${esc(it.dateLong)}</span>
      <span class="subj">${esc(it.subject)}</span>
      ${it.leadTitle ? `<span class="lead">${esc(it.leadTitle)}</span>` : ""}
      <span class="read" style="color:${it.edition.accent}">Read issue →</span>
    </a>`
  )
  .join("\n");

// Filter chips — one per edition pipeline that actually has issues, with counts.
const counts = Object.fromEntries(EDITIONS.map((e) => [e.id, issues.filter((i) => i.edition.id === e.id).length]));
const chips =
  `<button class="chip active" data-f="all">All <span>${issues.length}</span></button>` +
  EDITIONS.filter((e) => counts[e.id] > 0)
    .map(
      (e) =>
        `<button class="chip" data-f="${e.id}" style="--c:${e.accent}">${esc(e.label)} <span>${counts[e.id]}</span></button>`
    )
    .join("");

const index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(brand.publication)} — briefing archive · ${esc(brand.name)}</title>
<meta name="description" content="${esc(brand.publication)} — ${esc(brand.audience)}. Archive of every issue.">
<meta property="og:title" content="${esc(brand.publication)} — briefing archive">
<meta property="og:description" content="${esc(brand.publication)} by ${esc(brand.name)}.">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,400..700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0B0B14;--ink:#F4F2FB;--dim:#ABA6C4;--accent:#7C5CFF;--accent2:#00C2FF;--card:#13121E;--hair:#2C2A42}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font:400 16px/1.6 "IBM Plex Sans",sans-serif;-webkit-font-smoothing:antialiased;
  background-image:radial-gradient(900px 600px at 85% -10%,rgba(124,92,255,.16),transparent 60%),radial-gradient(700px 500px at -10% 20%,rgba(0,194,255,.08),transparent 55%),linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px);
  background-size:auto,auto,72px 72px,72px 72px}
.wrap{max-width:1080px;margin:0 auto;padding:56px 26px 90px}
header{border-bottom:1px solid var(--hair);padding-bottom:30px;margin-bottom:40px}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:32px}
.header-text{flex:1;min-width:0}
.header-logo{flex:0 0 auto;width:42%;max-width:460px}
.header-logo img{display:block;width:100%;height:auto;mix-blend-mode:screen}
@media(max-width:760px){.header-inner{flex-direction:column;align-items:stretch}.header-logo{width:100%;max-width:none;order:-1}}
.mono{font-family:"JetBrains Mono",monospace;letter-spacing:.08em}
.kicker{font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.22em;color:var(--accent2);text-transform:uppercase}
h1{font-family:"Fraunces",serif;font-weight:800;font-size:clamp(34px,6vw,62px);line-height:1.02;margin:12px 0 0;letter-spacing:-.01em}
h1 span{color:var(--accent)}
.tag{color:var(--dim);font-size:17px;max-width:640px;margin-top:10px}
.tag b{color:var(--ink);font-weight:600}
.tabs{display:flex;gap:8px;margin:22px 0 0}
.tab{font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.06em;text-transform:uppercase;
  padding:9px 16px;border-radius:999px;border:1px solid var(--hair);color:var(--dim);text-decoration:none;transition:.15s}
.tab:hover{border-color:var(--accent);color:var(--ink)}
.tab.active{background:var(--accent);border-color:var(--accent);color:#0B0B14;font-weight:700}
.actions{margin-top:22px;display:flex;gap:12px;flex-wrap:wrap}
.btn{display:inline-block;padding:11px 18px;border-radius:10px;font-weight:600;font-size:14px;text-decoration:none;border:1px solid var(--hair);color:var(--ink);transition:.16s}
.btn.primary{background:linear-gradient(120deg,var(--accent),#5a3ff0);border-color:transparent}
.btn:hover{transform:translateY(-1px);border-color:var(--accent)}
.count{color:var(--dim);font-size:13px;margin:0 0 18px;font-family:"JetBrains Mono",monospace}
.filters{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 24px}
.chip{--c:#7C5CFF;cursor:pointer;font:600 13px/1 "IBM Plex Sans",sans-serif;color:var(--dim);background:transparent;border:1px solid var(--hair);border-radius:999px;padding:9px 15px;display:inline-flex;gap:7px;align-items:center;transition:.15s}
.chip span{font-family:"JetBrains Mono",monospace;font-size:11px;opacity:.75}
.chip:hover{border-color:var(--c);color:var(--ink)}
.chip.active{background:var(--c);border-color:var(--c);color:#0B0B14}
.chip.active span{color:#0B0B14;opacity:.65}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{display:flex;flex-direction:column;gap:7px;background:var(--card);border:1px solid var(--hair);border-radius:14px;padding:20px;text-decoration:none;color:var(--ink);transition:.18s;position:relative;overflow:hidden}
.card:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 12px 40px rgba(124,92,255,.16)}
.card .badge{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.12em;color:var(--accent2);text-transform:uppercase}
.card .date{font-size:12.5px;color:var(--dim)}
.card .subj{font-family:"Fraunces",serif;font-weight:600;font-size:20px;line-height:1.2;margin-top:2px;text-transform:capitalize}
.card .lead{font-size:13.5px;color:var(--dim);line-height:1.45}
.card .read{margin-top:8px;font-size:13px;font-weight:600;color:var(--accent)}
footer{margin-top:60px;border-top:1px solid var(--hair);padding-top:22px;color:var(--dim);font-size:13px}
footer a{color:var(--accent);text-decoration:none}
.announce{display:flex;gap:10px;align-items:center;justify-content:center;text-decoration:none;
  margin:0 0 30px;padding:11px 18px;border:1px solid var(--hair);border-radius:12px;
  background:linear-gradient(120deg,rgba(121,40,202,.18),rgba(255,0,128,.12));color:var(--ink);
  font-size:14px;transition:.16s}
.announce:hover{border-color:#ff0080;transform:translateY(-1px)}
.announce .pill{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
  background:linear-gradient(90deg,#7928ca,#ff0080);border-radius:999px;padding:4px 10px;color:#fff;flex-shrink:0}
.announce b{font-weight:600}
.announce .go{color:var(--accent2);font-weight:600;flex-shrink:0}
@media(max-width:640px){.announce{flex-wrap:wrap}}
</style>
${GATE_HEAD}
</head>
<body>
<div class="wrap">
  <header>
    <div class="header-inner">
      <div class="header-text">
        <div class="kicker">No hype · just signal</div>
        <h1>${esc(brand.publication)}</h1>
        <p class="tag">${esc(brand.audience)}. Every issue, archived.<br>Built and published by <b>Content Harness</b>, an automated AI content pipeline.</p>
        <div class="actions">
          ${NEWSLETTER_URL ? `<a class="btn primary" href="${NEWSLETTER_URL}" target="_blank" rel="noopener">Subscribe on LinkedIn</a>` : ""}
          ${YOUTUBE_URL ? `<a class="btn" href="${YOUTUBE_URL}" target="_blank" rel="noopener">YouTube channel</a>` : ""}
          ${featured ? `<a class="btn" href="issues/${esc(featured.key)}.html">Latest issue →</a>` : ""}
        </div>
      </div>
      <div class="header-logo" aria-label="Content Harness">CH</div>
    </div>
  </header>
  <p class="count">${issues.length} issues archived · updated ${esc(featured?.dateLong || "")}</p>
  <div class="filters">${chips}</div>
  <div class="grid">
${cards}
  </div>
  <section class="ds-band">
    <h2>Get the daily briefing</h2>
    <p>One email, most mornings: what changed in ${esc(brand.publication)}, why it matters, and where to verify it.</p>
    <form class="ds-sub"><input type="email" required placeholder="you@work.com" aria-label="Email address"><button type="submit">Subscribe free</button></form>
    <a class="ds-li" href="${NEWSLETTER_URL}" target="_blank" rel="noopener">or subscribe on LinkedIn →</a>
  </section>
  <footer>
    <b>${esc(brand.publication)}</b> · ${esc(brand.name)}.<br>
    Replace the sample copy and URLs before publishing.<br>
    © ${new Date().getFullYear()} MyOwnAI Labs. Harness code is licensed under MIT.
  </footer>
</div>
<script>
(function(){
  var chips=[].slice.call(document.querySelectorAll('.chip')), cards=[].slice.call(document.querySelectorAll('.card[data-ed]'));
  chips.forEach(function(c){ c.addEventListener('click', function(){
    chips.forEach(function(x){ x.classList.remove('active'); }); c.classList.add('active');
    var f=c.getAttribute('data-f');
    cards.forEach(function(card){ card.style.display=(f==='all'||card.getAttribute('data-ed')===f)?'':'none'; });
  });});
})();
</script>
${GATE_BODY}
</body>
</html>`;

writeFileSync(join(OUT, "index.html"), index);
console.log(`Built ${issues.length} issues → ${OUT}`);
console.log(featured ? `Latest: ${featured.dateLong} — ${featured.subject}` : "No published issues in this workspace yet.");
