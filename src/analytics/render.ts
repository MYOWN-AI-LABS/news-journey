import type { AnalyticsPlatform, ChannelView, MetricValues, WeekAnalyticsView } from "./model.js";
import { ANALYTICS_PLATFORMS, addDays, exposureMetric, interactionCount } from "./model.js";
import type { AccountSnapshot } from "./account.js";

const PLATFORM_META: Record<AnalyticsPlatform, { label: string; short: string; color: string }> = {
  linkedin: { label: "LinkedIn", short: "LI", color: "#0a66c2" },
  instagram: { label: "Instagram", short: "IG", color: "#c13584" },
  youtube: { label: "YouTube", short: "YT", color: "#e62117" },
  x: { label: "X", short: "X", color: "#45515f" },
  threads: { label: "Threads", short: "TH", color: "#7157d9" },
  tiktok: { label: "TikTok", short: "TT", color: "#00a6a6" },
};

const METRIC_LABELS: Record<keyof MetricValues, string> = {
  impressions: "Impressions",
  reach: "Reach",
  views: "Views",
  reactions: "Reactions",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  reposts: "Reposts",
  quotes: "Quotes",
  saves: "Saves",
  bookmarks: "Bookmarks",
  clicks: "Link clicks",
  followersGained: "Followers gained",
  subscribersGained: "Subscribers gained",
  accountSubscribers: "Account subscribers",
  avgWatchTimeSeconds: "Avg watch",
  totalWatchTimeSeconds: "Total watch",
  videoDurationSeconds: "Video length",
};

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]!));
}

function number(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function signedNumber(value: number): string {
  return `${value >= 0 ? "+" : "−"}${number(Math.abs(value))}`;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toFixed(1)}%`;
}

function seconds(value: number): string {
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60);
  return `${minutes}m ${Math.round(value % 60)}s`;
}

function metricValue(key: keyof MetricValues, value: number): string {
  return key === "avgWatchTimeSeconds" || key === "totalWatchTimeSeconds" || key === "videoDurationSeconds"
    ? seconds(value)
    : number(value);
}

function displayDate(day: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${day}T12:00:00Z`));
}

function platformSummary(view: WeekAnalyticsView, platform: AnalyticsPlatform): string {
  const channels = view.newsletters.map((newsletter) => newsletter.channels.find((channel) => channel.platform === platform)!).filter((channel) => channel.receipt);
  const measured = channels.filter((channel) => Object.keys(channel.metrics).length);
  const exposureLabel = measured.map((channel) => channel.exposureLabel).find(Boolean) ?? null;
  const totalExposure = measured.reduce((sum, channel) => sum + (channel.exposure ?? 0), 0);
  const hasExposure = measured.some((channel) => channel.exposure !== null);
  const rates = measured.map((channel) => channel.engagementRate).filter((value): value is number => value !== null);
  const averageRate = rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null;
  const meta = PLATFORM_META[platform];
  return `<article class="platform-summary" style="--platform:${meta.color}">
    <div class="platform-summary__head"><span class="channel-mark">${meta.short}</span><strong>${meta.label}</strong></div>
    <div class="platform-summary__number">${number(hasExposure ? totalExposure : null)}</div>
    <div class="platform-summary__label">${exposureLabel ? `${esc(exposureLabel)} observed` : "No exposure metric"}</div>
    <div class="platform-summary__foot"><span>${measured.length}/${channels.length} measured</span><span>${percent(averageRate)} avg engagement</span></div>
  </article>`;
}

function statusLabel(channel: ChannelView): string {
  if (channel.source === "manual-legacy" && channel.status !== "stale") return "manual fallback";
  return channel.status.replace("-", " ");
}

function channelCard(channel: ChannelView): string {
  const meta = PLATFORM_META[channel.platform];
  const primary = channel.exposure;
  const primaryLabel = channel.exposureLabel ?? "exposure unavailable";
  const detailMetrics = (Object.entries(channel.metrics) as [keyof MetricValues, number][])
    .filter(([key]) => key !== channel.exposureLabel && key !== "accountSubscribers" && key !== "videoDurationSeconds")
    .slice(0, 6);
  const deltaExposure = channel.exposureLabel ? channel.delta[channel.exposureLabel] : undefined;
  const href = channel.receipt?.url;
  const title = href
    ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${meta.label}<span aria-hidden="true"> ↗</span></a>`
    : meta.label;
  const metricRows = detailMetrics.length
    ? detailMetrics.map(([key, value]) => `<div><dt>${esc(METRIC_LABELS[key])}</dt><dd>${metricValue(key, value)}</dd></div>`).join("")
    : `<div class="empty-detail">${channel.receipt ? "No metric values returned." : "No confirmed destination receipt."}</div>`;
  const captured = channel.capturedAt ? new Date(channel.capturedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not collected";
  const hasMetrics = Object.keys(channel.metrics).length > 0;
  return `<article class="channel-card channel-card--${channel.status}" style="--platform:${meta.color}">
    <div class="channel-card__head"><span class="channel-mark">${meta.short}</span><h4>${title}</h4><span class="status status--${channel.status}">${esc(statusLabel(channel))}</span></div>
    <div class="channel-primary"><strong>${number(primary)}</strong><span>${esc(primaryLabel)}</span></div>
    <div class="channel-pulse">
      <span><b>${percent(channel.engagementRate)}</b> engagement</span>
      <span><b>${hasMetrics ? number(channel.interactions) : "—"}</b> interactions</span>
      ${typeof deltaExposure === "number" ? `<span><b>${signedNumber(deltaExposure)}</b> since prior snapshot</span>` : ""}
    </div>
    <dl class="metric-list">${metricRows}</dl>
    <p class="channel-source">${esc(channel.source ?? "collector not run")} · ${esc(captured)}</p>
    ${channel.note ? `<p class="channel-note">${esc(channel.note)}</p>` : ""}
  </article>`;
}

/** One dot per platform in receipt order — lets the executive read every edition's channel health
 *  at a glance from the collapsed summary row, without expanding a single card. */
function statusDots(newsletter: WeekAnalyticsView["newsletters"][number]): string {
  return newsletter.channels.map((channel) => {
    const meta = PLATFORM_META[channel.platform];
    return `<span class="status-dot status-dot--${channel.status}" style="--platform:${meta.color}" title="${esc(meta.label)}: ${esc(statusLabel(channel))}"></span>`;
  }).join("");
}

function newsletterCard(newsletter: WeekAnalyticsView["newsletters"][number]): string {
  const publication = newsletter.publication;
  const links = [
    publication.newsletterUrl ? `<a href="${esc(publication.newsletterUrl)}" target="_blank" rel="noreferrer">LinkedIn issue ↗</a>` : `<span class="link-missing">LinkedIn issue URL unconfirmed</span>`,
    `<a href="${esc(publication.archiveUrl)}" target="_blank" rel="noreferrer">Archive ↗</a>`,
  ].join("");
  const measured = newsletter.channels.filter((channel) => channel.status === "collected" || channel.status === "partial").length;
  return `<details class="newsletter-card">
    <summary class="newsletter-head">
      <div><span class="eyebrow">${esc(displayDate(publication.date))} · ${esc(publication.editionId)} · ${measured}/${newsletter.channels.length} measured</span><h3>${esc(publication.editionTitle)}</h3><p>${esc(publication.headline)}</p></div>
      <div class="newsletter-head__right"><div class="status-dots">${statusDots(newsletter)}</div><nav aria-label="Newsletter links" onclick="event.stopPropagation()">${links}</nav></div>
    </summary>
    <div class="channel-grid">${newsletter.channels.map(channelCard).join("")}</div>
  </details>`;
}

function topSignals(view: WeekAnalyticsView): string {
  const signals = view.newsletters.flatMap((newsletter) => newsletter.channels.map((channel) => ({ newsletter, channel })))
    .filter(({ channel }) => channel.receipt && channel.engagementRate !== null)
    .sort((a, b) => (b.channel.engagementRate ?? 0) - (a.channel.engagementRate ?? 0))
    .slice(0, 5);
  if (!signals.length) return `<p class="empty">No measured engagement rates for this week yet.</p>`;
  return `<ol class="signal-list">${signals.map(({ newsletter, channel }) => {
    const meta = PLATFORM_META[channel.platform];
    return `<li><span class="signal-rank">${percent(channel.engagementRate)}</span><span><strong>${esc(newsletter.publication.headline)}</strong><small>${meta.label} · ${number(channel.interactions)} interactions / ${number(channel.exposure)} ${esc(channel.exposureLabel)}</small></span></li>`;
  }).join("")}</ol>`;
}

function withinTrailingDays(day: string, generatedAt: string, days: number): boolean {
  const cutoff = new Date(generatedAt);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return new Date(`${day}T12:00:00Z`) >= cutoff;
}

const ACCOUNT_SCOPE_LABEL: Partial<Record<AnalyticsPlatform, string>> = {
  linkedin: "newsletter subscribers",
  x: "profile followers",
};

/** ONE grid, all 6 platforms, always — this used to be two sections (a 2-platform "Account
 *  analytics" and a 6-platform "Overall analytics" with a near-identical per-platform grid next to
 *  it), which is exactly the "showing only 2 accounts and not all 6" defect: Instagram and YouTube
 *  DO have real per-post data (28/28 measured), it just never appeared in the account-labeled grid
 *  because no dedicated account-level collector exists for them yet. A platform with a real account
 *  snapshot (LinkedIn subscribers, X followers) leads with that number; a platform with only
 *  per-post data (Instagram, YouTube) leads with its trailing-30-day exposure total instead of
 *  being blank; a platform with neither (Threads, TikTok) says so with the real collector reason,
 *  never a bare dash. Interaction counts sum validly across channels (same unit); exposure
 *  (impressions/reach/views) never does — the one rule this file repeats everywhere. */
function channelActivityGrid(cells: ChannelView[], accountSnapshots: AccountSnapshot[]): string {
  const byPlatform = new Map(accountSnapshots.map((snap) => [snap.platform, snap]));
  const cards = ANALYTICS_PLATFORMS.map((platform) => {
    const meta = PLATFORM_META[platform];
    const platformCells = cells.filter((channel) => channel.platform === platform);
    const platformMeasured = platformCells.filter((channel) => Object.keys(channel.metrics).length);
    const exposureLabel = platformMeasured.map((channel) => channel.exposureLabel).find(Boolean) ?? null;
    const totalExposure = platformMeasured.reduce((sum, channel) => sum + (channel.exposure ?? 0), 0);
    const hasExposure = platformMeasured.some((channel) => channel.exposure !== null);
    const account = byPlatform.get(platform as AccountSnapshot["platform"]);

    let headline: string;
    let label: string;
    const foot: string[] = [];
    if (account) {
      // LinkedIn / X: the real account total (subscribers/followers) leads.
      const gained = account.metrics.subscribersGained7d;
      headline = number(account.metrics.subscribers);
      label = `${ACCOUNT_SCOPE_LABEL[platform] ?? "account total"}${typeof gained === "number" ? ` · ${signedNumber(gained)} (7d)` : ""}`;
      if (hasExposure) foot.push(`${number(totalExposure)} ${esc(exposureLabel ?? "")} from posts (30d)`);
    } else if (platformCells.length === 0) {
      headline = "—";
      label = "No posts on this channel in range";
    } else if (hasExposure) {
      // Instagram / YouTube today: no dedicated account-level collector yet, so the per-post
      // rollup IS the headline — never leave the card blank just because it isn't LinkedIn/X.
      headline = number(totalExposure);
      label = `${esc(exposureLabel ?? "")} · 30d total from posts`;
      foot.push("Account-level tracking not built yet");
    } else {
      // Threads / TikTok today: real receipts exist but nothing measured — show the actual
      // collector reason (never a bare dash pretending nothing happened).
      const reason = platformCells.map((channel) => channel.note).find(Boolean);
      headline = "—";
      label = reason ? esc(reason).slice(0, 90) : "Not available";
    }
    foot.push(`${platformMeasured.length}/${platformCells.length} posts measured`);

    return `<article class="platform-summary" style="--platform:${meta.color}">
      <div class="platform-summary__head"><span class="channel-mark">${meta.short}</span><strong>${meta.label}</strong></div>
      <div class="platform-summary__number">${headline}</div>
      <div class="platform-summary__label">${label}</div>
      <div class="platform-summary__foot">${foot.map((line) => `<span>${line}</span>`).join("")}</div>
    </article>`;
  }).join("");
  return `<div class="platform-grid">${cards}</div>`;
}

/** Trailing-30-day rollup across every already-built week view — no separate data pull, just
 *  aggregation of the same per-channel ChannelView data each week panel already renders. */
function overallAnalytics(views: WeekAnalyticsView[], generatedAt: string, accountSnapshots: AccountSnapshot[]): string {
  const recent = views.filter((view) => withinTrailingDays(view.weekEnd, generatedAt, 30));
  const cells = recent.flatMap((view) => view.newsletters.flatMap((newsletter) => newsletter.channels)).filter((channel) => channel.receipt);
  const measured = cells.filter((channel) => Object.keys(channel.metrics).length);
  const totalInteractions = measured.reduce((sum, channel) => sum + channel.interactions, 0);
  const totalPosts = new Set(recent.flatMap((view) => view.newsletters.map((newsletter) => newsletter.publication.contentId))).size;
  if (!recent.length) return `<section class="coverage-card"><div><h2>Channel activity — trailing 30 days</h2><p class="empty">No weeks loaded within the last 30 days.</p></div></section>`;
  return `<section class="coverage-card">
    <div><h2>Channel activity — trailing 30 days</h2><p>Every channel, accumulated across every reporting week ending in the last 30 days (${recent.length} week${recent.length === 1 ? "" : "s"} loaded). Views, reach and impressions remain channel-native and are never blended into one score.</p></div>
    <div class="kpi-grid" style="margin-top:20px">
      <article><span>Posts published</span><strong>${totalPosts}</strong><small>Distinct content IDs</small></article>
      <article><span>Confirmed channel posts</span><strong>${cells.length}</strong><small>Exact receipt IDs</small></article>
      <article><span>Measured surfaces</span><strong>${measured.length}</strong><small>${percent(cells.length ? measured.length / cells.length : null)} coverage</small></article>
      <article><span>Total interactions</span><strong>${number(totalInteractions)}</strong><small>Reactions+likes+comments+shares+reposts+quotes+saves, summed across channels</small></article>
    </div>
    <div style="margin-top:16px">${channelActivityGrid(cells, accountSnapshots)}</div>
  </section>`;
}

/** Ranks POSTS (not channel cells) by interactions accumulated across every channel that post has,
 *  over the trailing 30 days. Exposure is listed per-channel for context, never summed — same rule
 *  as overallAnalytics(). */
function topPostsMonthly(views: WeekAnalyticsView[], generatedAt: string): string {
  const recent = views.filter((view) => withinTrailingDays(view.weekEnd, generatedAt, 30));
  const byPost = new Map<string, { publication: WeekAnalyticsView["newsletters"][number]["publication"]; interactions: number; exposures: { label: string; value: number }[] }>();
  for (const view of recent) {
    for (const newsletter of view.newsletters) {
      const key = newsletter.publication.contentId;
      const entry = byPost.get(key) ?? { publication: newsletter.publication, interactions: 0, exposures: [] };
      for (const channel of newsletter.channels) {
        if (!Object.keys(channel.metrics).length) continue;
        entry.interactions += channel.interactions;
        if (channel.exposure !== null && channel.exposureLabel) {
          entry.exposures.push({ label: `${PLATFORM_META[channel.platform].label} ${number(channel.exposure)} ${channel.exposureLabel}`, value: channel.exposure });
        }
      }
      byPost.set(key, entry);
    }
  }
  const ranked = [...byPost.values()].filter((entry) => entry.exposures.length || entry.interactions > 0).sort((a, b) => b.interactions - a.interactions).slice(0, 10);
  if (!ranked.length) return `<p class="empty">No measured posts in the last 30 days yet.</p>`;
  return `<ol class="signal-list">${ranked.map((entry, index) => `<li><span class="signal-rank">#${index + 1}</span><span><strong>${esc(entry.publication.headline)}</strong><small>${number(entry.interactions)} interactions total${entry.exposures.length ? ` · ${entry.exposures.map((exposure) => esc(exposure.label)).join(" · ")}` : ""}</small></span></li>`).join("")}</ol>`;
}

/** The 2-minute read: current reporting week vs the week immediately before it, on the SAME unit
 *  each time (a platform's own exposure metric against its own prior value — never a cross-platform
 *  blend). Answers "what improved, what didn't" before any detail section. */
function executiveSummary(views: WeekAnalyticsView[], activeWeek: string): string {
  const current = views.find((view) => view.weekStart === activeWeek);
  if (!current) return "";
  const prior = views.find((view) => view.weekStart === addDays(activeWeek, -7));

  const cellsOf = (view: WeekAnalyticsView) => view.newsletters.flatMap((newsletter) => newsletter.channels).filter((channel) => channel.receipt);
  const interactionsOf = (view: WeekAnalyticsView) => cellsOf(view).filter((channel) => Object.keys(channel.metrics).length).reduce((sum, channel) => sum + channel.interactions, 0);

  const currentInteractions = interactionsOf(current);
  const priorInteractions = prior ? interactionsOf(prior) : null;
  const interactionsDelta = priorInteractions && priorInteractions > 0 ? (currentInteractions - priorInteractions) / priorInteractions : null;

  const coverage = current.expectedSurfaces ? current.measuredSurfaces / current.expectedSurfaces : 0;
  const priorCoverage = prior && prior.expectedSurfaces ? prior.measuredSurfaces / prior.expectedSurfaces : null;

  const platformDeltas = ANALYTICS_PLATFORMS.map((platform) => {
    if (!prior) return null;
    const curCells = cellsOf(current).filter((channel) => channel.platform === platform && Object.keys(channel.metrics).length);
    const curExposure = curCells.reduce((sum, channel) => sum + (channel.exposure ?? 0), 0);
    const priCells = cellsOf(prior).filter((channel) => channel.platform === platform && Object.keys(channel.metrics).length);
    const priExposure = priCells.reduce((sum, channel) => sum + (channel.exposure ?? 0), 0);
    if (!curCells.some((c) => c.exposure !== null) || !priCells.some((c) => c.exposure !== null) || priExposure <= 0) return null;
    return { platform, delta: (curExposure - priExposure) / priExposure };
  }).filter((entry): entry is { platform: AnalyticsPlatform; delta: number } => entry !== null);

  const best = platformDeltas.length ? platformDeltas.reduce((a, b) => (b.delta > a.delta ? b : a)) : null;
  const worst = platformDeltas.length ? platformDeltas.reduce((a, b) => (b.delta < a.delta ? b : a)) : null;
  const gaps = current.unavailableSurfaces + current.errorSurfaces;
  const decliningWorst = worst && worst.delta < 0;

  return `<section class="exec-summary">
    <div class="section-title"><span class="eyebrow">Executive summary</span><h2>What changed this week</h2><p>Current reporting week vs the one immediately before it. Same metric, same platform, never blended across channels.</p></div>
    <div class="kpi-grid">
      <article><span>Total interactions</span><strong>${number(currentInteractions)}</strong><small>${interactionsDelta === null ? "No prior week loaded to compare" : `${signedPercent(interactionsDelta)} vs prior week`}</small></article>
      <article><span>Coverage</span><strong>${percent(coverage)}</strong><small>${priorCoverage === null ? "No prior week loaded to compare" : `${signedPercent(coverage - priorCoverage)} vs prior week`}</small></article>
      <article class="${best ? "kpi-good" : ""}"><span>Improved most</span><strong>${best ? esc(PLATFORM_META[best.platform].label) : "—"}</strong><small>${best ? `${signedPercent(best.delta)} exposure vs prior week` : "Not enough data to compare"}</small></article>
      <article class="${decliningWorst || gaps ? "kpi-warn" : ""}"><span>Needs attention</span><strong>${decliningWorst ? esc(PLATFORM_META[worst!.platform].label) : gaps ? "Collector gaps" : "—"}</strong><small>${decliningWorst ? `${signedPercent(worst!.delta)} exposure vs prior week` : gaps ? `${gaps} surfaces unavailable this week` : "Nothing declining"}</small></article>
    </div>
  </section>`;
}

function weekPanel(view: WeekAnalyticsView, active: boolean): string {
  const gaps = view.unavailableSurfaces + view.errorSurfaces;
  const coverage = view.expectedSurfaces ? view.measuredSurfaces / view.expectedSurfaces : 0;
  return `<section class="week-panel${active ? " is-active" : ""}" data-week-panel="${esc(view.weekStart)}"${active ? "" : " hidden"}>
    <div class="kpi-grid">
      <article><span>Newsletters</span><strong>${view.newsletters.length}</strong><small>${displayDate(view.weekStart)}–${displayDate(view.weekEnd)}</small></article>
      <article><span>Confirmed channel posts</span><strong>${view.expectedSurfaces}</strong><small>Exact receipt IDs, not inferred posts</small></article>
      <article><span>Measured surfaces</span><strong>${view.measuredSurfaces}</strong><small>${percent(coverage)} coverage${view.staleSurfaces ? ` · ${view.staleSurfaces} stale` : ""}</small></article>
      <article class="${gaps ? "kpi-warn" : ""}"><span>Collector gaps</span><strong>${gaps}</strong><small>${view.unavailableSurfaces} unavailable · ${view.errorSurfaces} errors</small></article>
    </div>
    <section class="coverage-card">
      <div><h2>Channel coverage</h2><p>Lifetime post metrics captured by the weekly job. Views, reach and impressions remain separate—there is no blended vanity score.</p></div>
      <div class="coverage-track" role="img" aria-label="${Math.round(coverage * 100)} percent of confirmed channel posts measured"><span style="width:${Math.round(coverage * 100)}%"></span></div>
      <div class="platform-grid">${ANALYTICS_PLATFORMS.map((platform) => platformSummary(view, platform)).join("")}</div>
    </section>
    <section class="feedback-card"><div><span class="eyebrow">Feedback loop</span><h2>Strongest measured response</h2><p>Ranked within this week by interactions divided by that channel’s own exposure metric.</p></div>${topSignals(view)}</section>
    <section class="newsletters"><div class="section-title"><span class="eyebrow">Exact attribution</span><h2>Every newsletter, every channel</h2><p>Each channel cell is bound to the newsletter’s source video ID and the destination receipt stored at publish time.</p></div>${view.newsletters.length ? view.newsletters.map(newsletterCard).join("") : `<p class="empty">No newsletters found for this week.</p>`}</section>
  </section>`;
}

export function renderAnalyticsDashboard(views: WeekAnalyticsView[], generatedAt: string, defaultWeek: string, accountSnapshots: AccountSnapshot[] = []): string {
  const activeWeek = views.some((view) => view.weekStart === defaultWeek) ? defaultWeek : views[0]?.weekStart ?? defaultWeek;
  const options = views.map((view) => `<option value="${esc(view.weekStart)}"${view.weekStart === activeWeek ? " selected" : ""}>Week of ${esc(displayDate(view.weekStart))} · ${view.newsletters.length} newsletters</option>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Content Engine · Weekly Analytics</title>
<meta name="description" content="Weekly, post-attributed analytics for each configured newsletter and channel.">
<style>
:root{--ink:#12202a;--muted:#60717b;--paper:#f4f7f5;--card:#fff;--line:#dce5e0;--accent:#126b59;--accent-2:#e6f3ef;--warn:#a95614;--warn-bg:#fff4e7;--error:#a23838;--error-bg:#fff0f0;--shadow:0 14px 42px rgba(18,32,42,.08)}
*{box-sizing:border-box}html{background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;min-width:0}.shell{width:min(1480px,calc(100% - 40px));margin:0 auto;padding:42px 0 80px}a{color:inherit;text-underline-offset:3px}.masthead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:end;margin-bottom:28px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}.brand-mark{width:34px;height:34px;border-radius:9px;background:var(--accent);display:grid;place-items:center;color:#fff;font-weight:800;letter-spacing:-.04em}.brand-name{font-size:13px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.masthead h1{font-family:Georgia,serif;font-size:clamp(36px,5vw,68px);line-height:.98;letter-spacing:-.045em;margin:0;max-width:870px}.masthead p{color:var(--muted);font-size:16px;max-width:740px;margin:18px 0 0}.week-picker{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow);min-width:320px}.week-picker label{display:block;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}.week-picker select{width:100%;border:0;background:transparent;color:var(--ink);font:700 14px/1.3 inherit;outline:none}.generated{font-size:11px;color:var(--muted);margin:8px 0 0}.week-panel{display:none}.week-panel.is-active{display:block}.kpi-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.kpi-grid article{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;min-width:0}.kpi-grid span{display:block;color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}.kpi-grid strong{display:block;font-size:34px;line-height:1;margin:12px 0 8px}.kpi-grid small{display:block;color:var(--muted);line-height:1.35}.kpi-grid .kpi-warn{background:var(--warn-bg);border-color:#f0d1ae}.coverage-card,.feedback-card{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:24px;margin-bottom:18px;box-shadow:var(--shadow)}h2{font-family:Georgia,serif;font-size:28px;letter-spacing:-.025em;margin:0 0 6px}.coverage-card>div:first-child p,.feedback-card>div:first-child p,.section-title p{color:var(--muted);margin:0;max-width:820px}.coverage-track{height:9px;background:#e6ece9;border-radius:999px;margin:20px 0;overflow:hidden}.coverage-track span{display:block;height:100%;background:linear-gradient(90deg,var(--accent),#38a685);border-radius:inherit}.platform-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.platform-summary{border:1px solid var(--line);border-top:3px solid var(--platform);border-radius:12px;padding:13px;min-width:0}.platform-summary__head{display:flex;align-items:center;gap:7px}.platform-summary__number{font-size:25px;font-weight:800;margin-top:14px}.platform-summary__label,.platform-summary__foot{color:var(--muted);font-size:11px}.platform-summary__foot{display:grid;gap:3px;margin-top:10px}.channel-mark{width:25px;height:25px;display:inline-grid;place-items:center;border-radius:7px;background:color-mix(in srgb,var(--platform) 12%,white);color:var(--platform);font-size:9px;font-weight:900;letter-spacing:.02em;flex:0 0 auto}.feedback-card{display:grid;grid-template-columns:minmax(240px,.7fr) minmax(0,1.3fr);gap:32px;align-items:start}.eyebrow{color:var(--accent);font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}.signal-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}.signal-list li{display:grid;grid-template-columns:72px minmax(0,1fr);gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}.signal-list li:last-child{border:0}.signal-rank{font-size:18px;font-weight:900;color:var(--accent)}.signal-list strong,.signal-list small{display:block}.signal-list small{color:var(--muted);margin-top:2px}.section-title{margin:44px 0 18px}.newsletter-card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:24px;margin-bottom:18px;box-shadow:var(--shadow);min-width:0}.newsletter-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:start;padding-bottom:20px;border-bottom:1px solid var(--line);margin-bottom:18px}.newsletter-head h3{font-family:Georgia,serif;font-size:27px;letter-spacing:-.02em;margin:5px 0}.newsletter-head p{color:var(--muted);margin:0;font-size:15px}.newsletter-head nav{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.newsletter-head nav a,.link-missing{border:1px solid var(--line);border-radius:999px;padding:7px 11px;text-decoration:none;font-size:11px;font-weight:750}.link-missing{color:var(--muted);border-style:dashed}.channel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.channel-card{border:1px solid var(--line);border-top:4px solid var(--platform);border-radius:16px;padding:16px;min-width:0;background:#fff}.channel-card--unavailable,.channel-card--stale{background:var(--warn-bg)}.channel-card--error{background:var(--error-bg)}.channel-card--missing{background:#f7f8f8;border-top-color:#a8b3b7}.channel-card__head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center}.channel-card h4{font-size:14px;margin:0;min-width:0}.channel-card h4 a{text-decoration:none}.status{border-radius:999px;padding:4px 7px;font-size:9px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;background:var(--accent-2);color:var(--accent);white-space:nowrap}.status--unavailable,.status--stale{background:#f6ddbd;color:#835016}.status--error{background:#f1caca;color:#8c3030}.status--missing{background:#e6eaeb;color:#647379}.channel-primary{display:flex;align-items:baseline;gap:8px;margin:19px 0 10px}.channel-primary strong{font-size:31px;line-height:1}.channel-primary span{color:var(--muted);font-size:11px;text-transform:capitalize}.channel-pulse{display:flex;gap:8px 14px;flex-wrap:wrap;color:var(--muted);font-size:11px;padding-bottom:13px;border-bottom:1px solid var(--line)}.channel-pulse b{color:var(--ink)}.metric-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 14px;margin:13px 0}.metric-list div{display:flex;justify-content:space-between;gap:8px;font-size:11px}.metric-list dt{color:var(--muted)}.metric-list dd{margin:0;font-weight:750}.empty-detail{grid-column:1/-1;color:var(--muted);font-size:11px}.channel-source,.channel-note{font-size:10px;color:var(--muted);margin:8px 0 0;overflow-wrap:anywhere}.channel-note{color:var(--warn)}.empty{color:var(--muted);border:1px dashed var(--line);border-radius:15px;padding:22px}.method{margin-top:38px;border-top:1px solid var(--line);padding-top:22px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;gap:20px}.method strong{color:var(--ink)}
.exec-summary{margin-bottom:22px}.kpi-grid .kpi-good{background:var(--accent-2);border-color:#a9d6c9}
details.disclosure{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:24px;margin-bottom:18px;box-shadow:var(--shadow)}
details.disclosure summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px}
details.disclosure summary::-webkit-details-marker{display:none}
details.disclosure summary::after{content:"+";font-size:22px;font-weight:400;color:var(--muted);flex:none;transition:transform .2s}
details.disclosure[open] summary::after{transform:rotate(45deg)}
details.disclosure .disclosure-body{margin-top:18px}
details.newsletter-card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:24px;margin-bottom:14px;box-shadow:var(--shadow);min-width:0}
details.newsletter-card summary{cursor:pointer;list-style:none}
details.newsletter-card summary::-webkit-details-marker{display:none}
details.newsletter-card[open] summary{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:18px}
details.newsletter-card .channel-grid{margin-top:0}
.newsletter-head__right{display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.status-dots{display:flex;gap:5px}
.status-dot{width:11px;height:11px;border-radius:50%;background:var(--platform);flex:none}
.status-dot--unavailable,.status-dot--stale{background:#d9a259}
.status-dot--error{background:var(--error)}
.status-dot--missing{background:#c3ccce}
@media(max-width:1050px){.platform-grid{grid-template-columns:repeat(3,1fr)}.channel-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:700px){.shell{width:min(100% - 24px,1480px);padding-top:22px}.masthead{grid-template-columns:1fr;gap:20px}.masthead h1{font-size:42px}.week-picker{min-width:0;width:100%}.kpi-grid{grid-template-columns:1fr 1fr}.kpi-grid article{padding:15px}.kpi-grid strong{font-size:28px}.coverage-card,.feedback-card,.newsletter-card{padding:17px;border-radius:18px}.platform-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.feedback-card{grid-template-columns:1fr;gap:14px}.newsletter-head{grid-template-columns:1fr}.newsletter-head nav{justify-content:flex-start}.channel-grid{grid-template-columns:1fr}.channel-card{padding:15px}.method{display:block}.method span{display:block;margin-top:7px}}
@media(max-width:420px){.kpi-grid{grid-template-columns:1fr}.platform-grid{grid-template-columns:1fr 1fr}.masthead h1{font-size:36px}.channel-card__head{grid-template-columns:auto minmax(0,1fr)}.channel-card__head .status{grid-column:1/-1;justify-self:start}.signal-list li{grid-template-columns:62px minmax(0,1fr)}}
@media print{html{background:#fff}.shell{width:100%;padding:0}.masthead{margin-bottom:18px}.week-picker{box-shadow:none}.week-panel{display:none!important}.week-panel.is-active{display:block!important}.coverage-card,.feedback-card,.newsletter-card{box-shadow:none;break-inside:avoid}.channel-card{break-inside:avoid}.channel-grid{grid-template-columns:repeat(3,1fr)}details.disclosure .disclosure-body,details.newsletter-card .channel-grid{display:block!important}details summary::after{display:none}}
</style></head><body><main class="shell">
<header class="masthead"><div><div class="brand"><span class="brand-mark">CE</span><span class="brand-name">Content Engine · Feedback Loop</span></div><h1>Weekly analytics, attributed to the post.</h1><p>Every newsletter is joined to its exact channel receipts before metrics are collected. Missing access stays visible; unavailable data is never converted into zero.</p></div><div class="week-picker"><label for="week-select">Reporting week</label><select id="week-select">${options}</select><p class="generated">Generated ${esc(new Date(generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }))}</p></div></header>
${executiveSummary(views, activeWeek)}
${overallAnalytics(views, generatedAt, accountSnapshots)}
<details class="disclosure"><summary><div><span class="eyebrow">Trailing 30 days</span><h2>Top posts, accumulated</h2><p>Ranked by interactions summed across every channel that post has. Exposure per channel is listed for context, never summed into the ranking.</p></div></summary><div class="disclosure-body">${topPostsMonthly(views, generatedAt)}</div></details>
${views.map((view) => weekPanel(view, view.weekStart === activeWeek)).join("")}
<footer class="method"><strong>Measurement policy</strong><span>Automated official APIs first · exact receipt IDs · append-only snapshots · manual data only as labeled fallback · channel-native denominators remain separate.</span></footer>
</main><script>
const select=document.getElementById('week-select');
const panels=[...document.querySelectorAll('[data-week-panel]')];
function showWeek(week){if(!panels.some(p=>p.dataset.weekPanel===week))return;for(const panel of panels){const active=panel.dataset.weekPanel===week;panel.hidden=!active;panel.classList.toggle('is-active',active)}select.value=week;history.replaceState(null,'','#'+week)}
select.addEventListener('change',()=>showWeek(select.value));
const requested=location.hash.slice(1);if(requested)showWeek(requested);
</script></body></html>`.replace(/[ \t]+$/gm, "");
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`)].join("\n");
}

export function renderAnalyticsReport(view: WeekAnalyticsView, generatedAt: string): string {
  const lines = [
    `# Content Engine — weekly post-attributed analytics`,
    "",
    `Week: ${view.weekStart} through ${view.weekEnd} · generated ${generatedAt}`,
    "",
    `Coverage: ${view.measuredSurfaces}/${view.expectedSurfaces} confirmed channel posts measured · ${view.unavailableSurfaces} unavailable · ${view.errorSurfaces} errors · ${view.staleSurfaces} stale fallbacks.`,
    "",
    "> Views, reach and impressions are channel-native denominators and are not added into one cross-platform score.",
    "",
  ];
  for (const newsletter of view.newsletters) {
    lines.push(`## ${newsletter.publication.editionTitle}`);
    lines.push("");
    lines.push(`${newsletter.publication.date} · ${newsletter.publication.headline} · content ID \`${newsletter.publication.contentId}\``);
    lines.push("");
    lines.push(markdownTable(
      ["Channel", "Receipt", "Status", "Exposure", "Interactions", "Engagement", "Captured"],
      newsletter.channels.map((channel) => [
        PLATFORM_META[channel.platform].label,
        channel.receipt?.id ?? "missing",
        statusLabel(channel),
        channel.exposureLabel ? `${number(channel.exposure)} ${channel.exposureLabel}` : "—",
        Object.keys(channel.metrics).length ? number(interactionCount(channel.metrics)) : "—",
        percent(channel.engagementRate),
        channel.capturedAt ?? "—",
      ]),
    ));
    lines.push("");
  }
  return lines.join("\n");
}
