import { newsletterVisual, newsletterMotionForSource, STORY_VISUAL_CSS, newsletterVisualScript } from "./newsletter-visuals.js";
import { EXAMPLE_PUBLISHER, type Publisher } from "../publisher.js";
import { brandTheme, type BrandTheme } from "../personalization.js";
import { NEWSLETTER_SECTION_HEADINGS } from "./newsletter-contract.js";
import { isPublicVideoUrl } from "../post/public-video-url.js";
// Neutral newsletter edition. The harness ships NO house design: this shell is a plain, readable layout
// driven entirely by the customer's brand tokens (light/dark, accent, fonts, identity), and a workspace
// can replace the whole shell with its own `branding/newsletter.html` — the harness then only fills the
// placeholders listed in docs/branding.md. System fonts only; nothing is fetched from a font or script CDN.

import type { StoryDiagram, StoryMotion } from "../types.js";

/**
 * One story's mechanism map plus the diagram authored for it, in published order.
 *
 * `n` is the 1-based story number the diagram was authored against, so a renderer can address the
 * drawing without re-deriving position from array order.
 */
export type NewsletterMotionStory = (StoryMotion | { kind: 'text-card'; status: string }) & {
  n: number;
  title: string;
  url: string;
  diagram?: StoryDiagram;
  figureDataUri?: string;
};

export interface NewsletterBrand {
  organization: string;
  tagline: string;
  website: string;
  footer: string;
  theme: BrandTheme;
}

export interface NewsletterData {
  publisher?: Publisher;
  sourceVideoId?: string | null;
  issue: {
    subject: string;
    lead: { title: string; body: string; sourceName: string; sourceUrl: string };
    items: { name: string; url: string; line: string }[];
    radar: { repo: string; url: string; line: string }[];
    signals: { source: string; line: string; url: string }[];
  };
  issueNo: number;
  date: string;
  dateLong: string;
  video: { id: string; headline: string; durationSec: number; videoUrl: string; posted?: boolean } | null;
  coveredWeek: string[];
  audioDataUri?: string | null; // self-contained voiceover embed (data:audio/mp4;base64,...)
  captionWords?: { w: string; start: number; end: number }[] | null; // karaoke sync for the player
  videoDataUri?: string | null; // embedded mp4 until the video is publicly posted
  editionBadge?: string | null; // special-edition masthead badge, e.g. "EXTRA!! EDITION!! № 1 · WEEK 1"
  editionTitle?: string | null; // article title the publisher uses (overrides the default)
  editionCover?: string | null; // cover file (repo-relative) the publisher uploads for this edition
  logoDataUri?: string | null;  // the customer's own logo (config/personalization.json); null = neutral text mark
  styleDirection?: string;      // customer style direction; "" = neutral house style
  /** Edition accent (hex); used only when the customer chose no accent of their own. */
  editionAccent?: string | null;
  /** The customer's brand: identity lines and resolved theme tokens. Absent → the neutral light default. */
  brand?: NewsletterBrand | null;
  /** The workspace's own shell (`branding/newsletter.html`); its placeholders are filled, nothing else touched. */
  customShell?: string | null;
  /** The exact story-owned motion/diagram objects used by the corresponding video. Both media read
   *  this same set, which is what makes "drawn identically in both media" true by construction. */
  motionStories?: NewsletterMotionStory[] | null;
}

/** "#F59E0B" → "245,158,11", for rgba() tints of the accent. */
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return Number.isNaN(n) || full.length !== 6 ? "47,111,143" : `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// URLs originate from scraped web content via the LLM — allowlist schemes so a
// hostile feed item can't smuggle javascript:/data: into a clickable href.
const safeUrl = (u: string): string => {
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? u : "#";
  } catch {
    return "#";
  }
};

/** Placeholders a custom shell may use. Text values are HTML-escaped; `html` values are complete markup. */
export const SHELL_PLACEHOLDERS = {
  text: ["title", "publication", "author", "organization", "tagline", "website", "footer", "date", "issueNo", "readMinutes", "subject", "coveredWeek"],
  html: ["logo", "video", "lead", "items", "radar", "signals", "styles", "scripts"],
} as const;

/** Fill a customer shell: only the listed placeholders are replaced; anything else in the file is theirs. */
export function fillShell(shell: string, values: Record<string, string>): string {
  const names = [...SHELL_PLACEHOLDERS.text, ...SHELL_PLACEHOLDERS.html] as readonly string[];
  return shell.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, name: string) => names.includes(name) ? values[name] ?? "" : match);
}

export function renderNewsletterHtml(d: NewsletterData): string {
  const { issue } = d;
  const pub = d.publisher ?? EXAMPLE_PUBLISHER;
  const theme = d.brand?.theme ?? brandTheme({ theme: "", accent: "", fontPairing: "", newsletterPreset: "" }, d.editionAccent || undefined);
  const accentRgb = hexToRgb(theme.accent);
  const brand = { organization: d.brand?.organization ?? "", tagline: d.brand?.tagline ?? "", website: d.brand?.website ?? "", footer: d.brand?.footer ?? "" };
  const readMins = Math.max(1, Math.round(
    (issue.lead.body.split(" ").length + issue.items.length * 22 + issue.radar.length * 14) / 220
  ));

  const items = issue.items
    .map(
      (it, i) => `
      <div class="item">
        <span class="idx">${i + 1}</span>
        <div>
          <a class="item-name" href="${esc(safeUrl(it.url))}">${esc(it.name)}</a>
          <p class="item-line">${esc(it.line)}</p>
          ${newsletterVisual(newsletterMotionForSource(d,it.url,i+1),d.date)}
        </div>
      </div>`
    )
    .join("");

  const radarRows = issue.radar
    .map(
      (r) => `
      <div class="radar-row">
        <a class="radar-repo" href="${esc(safeUrl(r.url))}">${esc(r.repo)}</a>
        <span class="radar-line">${esc(r.line)}</span>
      </div>`
    )
    .join("");
  // Optional supporting sections are omitted entirely when no verified candidates exist.
  const radar = issue.radar.length ? `
  <section class="sec">
    <h2 class="sec-title">${NEWSLETTER_SECTION_HEADINGS.radar}</h2>
    <div class="radar">${radarRows}</div>
  </section>` : "";

  const signals = issue.signals.length
    ? `
    <section class="sec">
      <h2 class="sec-title">${NEWSLETTER_SECTION_HEADINGS.otherDesks}</h2>
      ${issue.signals
        .map(
          (s) => `<p class="signal-line"><span class="signal-src">${esc(s.source)}</span> <a href="${esc(safeUrl(s.url))}">${esc(s.line)}</a></p>`
        )
        .join("")}
    </section>`
    : "";

  // words embedded for karaoke sync; <-escape so content can never close the script tag
  const wordsJson = JSON.stringify(
    (d.captionWords ?? []).map((w) => [Math.round(w.start * 100) / 100, Math.round(w.end * 100) / 100, w.w])
  ).replace(/</g, "\\u003c");
  const publicVideoUrl = d.video?.posted && isPublicVideoUrl(d.video.videoUrl) ? d.video.videoUrl : null;

  const video = d.video
    ? `
    <div class="video-card" id="briefing">
      <button class="vc-play" id="bplay" aria-label="play the audio briefing">▶</button>
      <div class="vc-meta">
        <div class="vc-kicker">This edition's briefing · ${d.video.durationSec} s</div>
        <div class="vc-title">${esc(d.video.headline)}</div>
        <div class="vc-sub"><span id="btime">Listen — ${d.video.durationSec} seconds</span> · ${
          d.videoDataUri
            ? `<a href="#" id="bwatch" role="button">Watch the video</a>`
            : publicVideoUrl
              ? `<a href="${esc(safeUrl(publicVideoUrl))}">Watch the video</a>`
              : `<span>Video available after publishing</span>`
        }</div>
      </div>
      <div class="vc-track" id="btrack" title="seek"><div class="vc-fill" id="bfill"></div></div>
      ${d.audioDataUri ? `<audio id="baud" preload="metadata" src="${d.audioDataUri}"></audio>` : ""}
    </div>
    ${d.videoDataUri ? `
    <div class="vidpanel" id="bvidpanel">
      <video id="bvid" controls playsinline preload="metadata" src="${d.videoDataUri}"></video>
    </div>` : ""}
    <div class="transcript" id="btranscript">
      <div class="tr-label">Transcript — words light up as they are spoken; click any word to jump</div>
      <div class="tr-body" id="btrbody"></div>
    </div>`
    : "";

  const lead = `
  <section class="lead">
    <h2 class="sec-title">${esc(issue.lead.title)}</h2>
    <p>${esc(issue.lead.body)}</p>
    <a class="src" href="${esc(safeUrl(issue.lead.sourceUrl))}">Source: ${esc(issue.lead.sourceName)}</a>
  ${newsletterVisual(newsletterMotionForSource(d,issue.lead.sourceUrl),d.date)}
  </section>`;

  const itemsSection = issue.items.length ? `
  <section class="sec">
    <h2 class="sec-title">${NEWSLETTER_SECTION_HEADINGS.worthYourTime}</h2>
    ${items}
  </section>` : "";

  const logo = d.logoDataUri ? `<img class="brand-logo" src="${d.logoDataUri}" alt="${esc(pub.publication)} logo" style="display:block;max-height:64px;max-width:240px;margin:0 0 10px">` : "";

  const styles = `<style>
:root{
  --bg:${theme.bg}; --surface:${theme.surface}; --ink:${theme.ink}; --muted:${theme.muted}; --hair:${theme.hair};
  --accent:${theme.accent}; --accentRgb:${accentRgb};
  --heading:${theme.headingFont}; --body:${theme.bodyFont};
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font:400 17px/1.6 var(--body);-webkit-font-smoothing:antialiased}
.wrap{max-width:680px;margin:0 auto;padding:40px 24px 64px}
a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
h1,h2,h3{font-family:var(--heading);letter-spacing:-.01em}
.masthead{border-bottom:2px solid var(--ink);padding-bottom:20px;margin-bottom:28px}
.mast-rail{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--muted);margin-bottom:14px}
h1.brand{font-size:40px;line-height:1.05;font-weight:700}
.org{margin-top:6px;font-size:15px;color:var(--muted)}
.tagline{margin-top:10px;font-size:15px;color:var(--muted)}
.video-card{display:flex;align-items:center;gap:16px;position:relative;background:var(--surface);border:1px solid var(--hair);border-radius:12px;padding:18px 20px;margin:0 0 28px}
.vc-play{flex:none;width:52px;height:52px;border-radius:50%;display:grid;place-items:center;background:var(--accent);border:0;color:#fff;font-size:18px;padding-left:3px;cursor:pointer;font-family:inherit}
.vc-meta{min-width:0}
.vc-kicker{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.vc-title{font-family:var(--heading);font-size:19px;font-weight:600;line-height:1.3}
.vc-sub{font-size:13px;color:var(--muted);margin-top:6px}
.vc-track{position:absolute;left:0;right:0;bottom:0;height:14px;cursor:pointer;opacity:0;transition:opacity .3s}
.vc-track:before{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(var(--accentRgb),.2)}
.video-card.playing .vc-track,.video-card.started .vc-track{opacity:1}
.vc-fill{position:absolute;left:0;bottom:0;height:3px;width:0%;background:var(--accent)}
.vidpanel{max-height:0;overflow:hidden;opacity:0;transition:max-height .5s,opacity .4s;margin:-18px 0 28px;background:var(--surface);border:1px solid transparent;border-top:0;border-radius:0 0 12px 12px;text-align:center}
.vidpanel.open{max-height:600px;opacity:1;padding:16px 0;border-color:var(--hair)}
.vidpanel video{height:540px;max-width:94%;border-radius:10px;background:#000}
.transcript{max-height:0;overflow:hidden;opacity:0;transition:max-height .5s,opacity .4s;margin:-18px 0 28px;background:var(--surface);border:1px solid transparent;border-top:0;border-radius:0 0 12px 12px;padding:0 20px}
.transcript.open{max-height:300px;opacity:1;padding:16px 20px;border-color:var(--hair)}
.tr-label{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.tr-body{max-height:215px;overflow-y:auto;font-size:15px;line-height:1.9;color:var(--muted);padding-right:8px}
.tr-body span{cursor:pointer;border-radius:3px}
.tr-body .said{color:var(--ink)}
.tr-body .now{color:#fff;background:var(--accent);padding:0 3px}
.sec{margin-bottom:34px}
.sec-title{font-size:26px;line-height:1.2;font-weight:700;margin-bottom:12px}
.lead{border-left:4px solid var(--accent);padding-left:20px;margin-bottom:36px}
.lead .sec-title{font-size:30px}
.lead p{font-size:17px}
.lead .src{display:inline-block;margin-top:12px;font-size:13px}
.item{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--hair)}
.item:last-of-type{border-bottom:0}
.idx{font-family:var(--heading);font-weight:700;color:var(--accent);flex:none;min-width:22px;padding-top:2px}
.item-name{font-family:var(--heading);font-size:18px;font-weight:600;line-height:1.3}
.item-line{color:var(--ink);font-size:15.5px;margin-top:4px}
.radar{background:var(--surface);border:1px solid var(--hair);border-radius:10px;padding:4px 16px}
.radar-row{display:grid;gap:4px;padding:10px 0;border-bottom:1px solid var(--hair);font-size:14px}
.radar-row:last-child{border-bottom:0}
.radar-repo{font-weight:600}
.radar-line{color:var(--muted)}
.signal-line{padding:6px 0;font-size:15px}
.signal-src{font-size:12px;letter-spacing:.04em;color:var(--muted);text-transform:uppercase;margin-right:8px}
.footer{border-top:1px solid var(--hair);margin-top:40px;padding-top:20px;font-size:14px;color:var(--muted)}
.footer .sig{font-family:var(--heading);font-size:18px;color:var(--ink)}
.footer p{margin-top:8px}
.footer a{color:var(--accent)}
${STORY_VISUAL_CSS}
</style>`;

  const scripts = `<script>
/* briefing player: ▶ plays the embedded audio, seek bar + karaoke transcript sync */
(function(){
  var WORDS = ${wordsJson};
  var card = document.getElementById('briefing'), play = document.getElementById('bplay');
  if (!card || !play) return;
  var aud = document.getElementById('baud');
  if (!aud) { // no embedded audio — ▶ falls back to opening the video
    play.addEventListener('click', function () { var a = card.querySelector('.vc-sub a'); if (a) location.href = a.href; });
    return;
  }
  var fill = document.getElementById('bfill'), track = document.getElementById('btrack'),
      timeEl = document.getElementById('btime'), trWrap = document.getElementById('btranscript'),
      trBody = document.getElementById('btrbody');
  var lastIdx = -1, spans = [];
  for (var w = 0; w < WORDS.length; w++) {
    var sp = document.createElement('span');
    sp.textContent = WORDS[w][2];
    sp.dataset.i = w;
    trBody.appendChild(sp);
    trBody.appendChild(document.createTextNode(' '));
    spans.push(sp);
  }
  trBody.addEventListener('click', function (e) {
    var i = e.target && e.target.dataset ? e.target.dataset.i : null;
    if (i != null) { aud.currentTime = WORDS[+i][0]; aud.play(); }
  });
  function fmt(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  play.addEventListener('click', function () { if (aud.paused) { aud.play(); } else { aud.pause(); } });
  aud.addEventListener('play', function () { card.classList.add('playing', 'started'); if (spans.length) trWrap.classList.add('open'); play.textContent = '❚❚'; });
  aud.addEventListener('pause', function () { card.classList.remove('playing'); play.textContent = '▶'; });
  aud.addEventListener('ended', function () {
    card.classList.remove('playing'); play.textContent = '▶'; fill.style.width = '0%';
    timeEl.textContent = 'Listen again';
    for (var k = 0; k < spans.length; k++) spans[k].className = '';
    lastIdx = -1;
  });
  track.addEventListener('click', function (e) { var r = track.getBoundingClientRect(); if (aud.duration) aud.currentTime = ((e.clientX - r.left) / r.width) * aud.duration; });
  function highlight(i) {
    var a = Math.min(lastIdx < 0 ? 0 : lastIdx, i), b = Math.max(lastIdx < 0 ? 0 : lastIdx, i);
    for (var k = a; k <= b && k < spans.length; k++) spans[k].className = k < i ? 'said' : k === i ? 'now' : '';
    if (lastIdx >= 0 && lastIdx < spans.length) spans[lastIdx].className = lastIdx < i ? 'said' : '';
    spans[i].className = 'now';
    var top = spans[i].offsetTop - trBody.offsetTop;
    if (top < trBody.scrollTop + 20 || top > trBody.scrollTop + trBody.clientHeight - 40) trBody.scrollTop = top - trBody.clientHeight / 2;
  }
  aud.addEventListener('timeupdate', function () {
    var t = aud.currentTime;
    if (aud.duration) fill.style.width = (t / aud.duration * 100) + '%';
    timeEl.textContent = fmt(t) + ' / ' + fmt(aud.duration || 0);
    if (!spans.length) return;
    var i = 0, lo = 0, hi = WORDS.length - 1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (WORDS[mid][0] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i !== lastIdx) { highlight(i); lastIdx = i; }
  });
})();
/* embedded video: the link toggles the panel; audio and video never play together */
(function(){
  var btn = document.getElementById('bwatch'), panel = document.getElementById('bvidpanel');
  if (!btn || !panel) return;
  var vid = document.getElementById('bvid'), aud = document.getElementById('baud');
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    var open = panel.classList.toggle('open');
    btn.textContent = open ? 'Hide the video' : 'Watch the video';
    if (open) { if (aud && !aud.paused) aud.pause(); vid.play().catch(function(){}); } else { vid.pause(); }
  });
  vid.addEventListener('play', function () { if (aud && !aud.paused) aud.pause(); });
  if (aud) aud.addEventListener('play', function () { if (!vid.paused) vid.pause(); });
})();
</script>
<script>${newsletterVisualScript(d.captionWords??[])}</script>`;

  const values: Record<string, string> = {
    title: esc(`${pub.publication} · ${d.date}`),
    publication: esc(pub.publication), author: esc(pub.name), organization: esc(brand.organization), tagline: esc(brand.tagline),
    website: esc(safeUrl(brand.website) === "#" ? "" : brand.website), footer: esc(brand.footer),
    date: esc(d.dateLong), issueNo: String(d.issueNo), readMinutes: String(readMins), subject: esc(issue.subject),
    coveredWeek: d.coveredWeek.map(esc).join(" · "),
    logo, video, lead, items: itemsSection, radar, signals, styles, scripts,
  };
  if (d.customShell) return fillShell(d.customShell, values);

  const website = values.website ? `<a href="${values.website}">${values.website.replace(/^https:\/\//, "")}</a>` : "";
  return `<!doctype html>
<html lang="en" data-theme="${theme.mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${values.title}</title>
${styles}
</head>
<body${d.styleDirection ? ` data-style="${esc(d.styleDirection)}"` : ""}>
<div class="wrap">

  <header class="masthead">
    <div class="mast-rail">
      <span>Issue ${values.issueNo}</span>
      <span>${values.date}</span>
      <span>${values.readMinutes} min read</span>
    </div>
    ${logo}
    <h1 class="brand">${values.publication}</h1>
    ${brand.organization ? `<p class="org">${values.organization}</p>` : ""}
    <p class="tagline">${brand.tagline ? values.tagline : `${esc(pub.audience)} · ${esc(pub.tone)}`}</p>
  </header>

  ${video}
  ${lead}
  ${itemsSection}
  ${radar}
  ${signals}

  <footer class="footer">
    <div class="sig">${values.author}${brand.organization ? ` · ${values.organization}` : ""}</div>
    ${d.coveredWeek.length ? `<p><b>Covered this week:</b> ${values.coveredWeek}</p>` : ""}
    ${website ? `<p>${website}</p>` : ""}
    ${brand.footer ? `<p>${values.footer}</p>` : ""}
    <p>${values.publication}${d.publisher ? "" : " · Fictional beta content. Replace the sample identity before publication."}</p>
  </footer>

</div>
${scripts}
</body>
</html>`;
}
