import { newsletterMotionForSource } from "./newsletter-visuals.js";
import { EXAMPLE_PUBLISHER } from "../publisher.js";
import { NEWSLETTER_SECTION_HEADINGS } from "./newsletter-contract.js";
import { isPublicVideoUrl } from "../post/public-video-url.js";
// LinkedIn edition of Example Signal — minimal semantic HTML optimized for pasting
// into LinkedIn's article editor (which strips CSS but keeps h2/h3/p/a/b/i/ul).
// LinkedIn has no publish API for articles/newsletters, so the flow is:
// clipboard (rich text) → paste into the composer → publish.

import type { NewsletterData } from "./newsletter-html.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const safeUrl = (u: string): string => {
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? u : "#";
  } catch {
    return "#";
  }
};

export function renderLinkedInEdition(d: NewsletterData): string {
  const { issue } = d;
  const publicVideoUrl = d.video?.posted && isPublicVideoUrl(d.video.videoUrl) ? d.video.videoUrl : null;
  const figure=(url:string,index=0)=>{const story=newsletterMotionForSource(d,url,index);return story?.figureDataUri ? `<p><img src="${story.figureDataUri}" alt="${esc(story.title)}" style="max-width:100%"></p><p>${esc(story.diagram?.visual?.caveat||story.status)} · Silent visual</p>` : "";};
  const videoLine = d.video
    ? publicVideoUrl
      ? `<p><b>🎬 Today's ${d.video.durationSec}-second video briefing:</b> <a href="${esc(safeUrl(publicVideoUrl))}">${esc(d.video.headline)}</a></p>`
      : `<p><b>🎬 Today's ${d.video.durationSec}-second video briefing:</b> ${esc(d.video.headline)} — video available after publishing.</p>`
    : "";

  const items = issue.items
    .map((it,i) => `<li><b><a href="${esc(safeUrl(it.url))}">${esc(it.name)}</a></b> — ${esc(it.line)}${figure(it.url,i+1)}</li>`)
    .join("\n");
  const itemsSection = issue.items.length
    ? `<h2>${NEWSLETTER_SECTION_HEADINGS.worthYourTime}</h2>\n<ul>\n${items}\n</ul>`
    : "";
  const radarSection = issue.radar.length
    ? `<h2>${NEWSLETTER_SECTION_HEADINGS.radar}</h2>\n<ul>\n${issue.radar
        .map((r) => `<li><a href="${esc(safeUrl(r.url))}">${esc(r.repo)}</a> — ${esc(r.line)}</li>`)
        .join("\n")}\n</ul>`
    : "";
  const signals = issue.signals.length
    ? `<h2>${NEWSLETTER_SECTION_HEADINGS.otherDesks}</h2>\n<ul>\n${issue.signals
        .map((s) => `<li><b>${esc(s.source)}:</b> <a href="${esc(safeUrl(s.url))}">${esc(s.line)}</a></li>`)
        .join("\n")}\n</ul>`
    : "";


  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(issue.subject)}</title></head><body>
<p><i>${esc((d.publisher ?? EXAMPLE_PUBLISHER).publication)} — ${esc((d.publisher ?? EXAMPLE_PUBLISHER).audience)}. ${d.editionBadge ? esc(d.editionBadge) : `Issue № ${d.issueNo}`} · ${esc(d.dateLong)}</i></p>
${videoLine}
<h2>The lead: ${esc(issue.lead.title)}</h2>
<p>${esc(issue.lead.body)} (<a href="${esc(safeUrl(issue.lead.sourceUrl))}">${esc(issue.lead.sourceName)}</a>)</p>
${figure(issue.lead.sourceUrl)}
${itemsSection}
${radarSection}
${signals}
<p><i>Covered this week: ${d.coveredWeek.map(esc).join(" · ")}</i></p>
<p>— ${esc((d.publisher ?? EXAMPLE_PUBLISHER).name)} · ${esc((d.publisher ?? EXAMPLE_PUBLISHER).publication)}</p>
<p><b>Subscribe</b> for the daily briefing, and follow for the 90-second video briefings.</p>
<p><i>${d.publisher ? "" : "Fictional beta content. Replace the sample identity before publication."}</i></p>
</body></html>`;
}
