import { assertProDistribution } from '../release-profile.js';
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../post/adapter.js";
import { activeRoot, authorize, contained } from "../workspaces.js";
import { todayStamp } from "../util.js";
import { addDays, appendSnapshots, availableWeeks, buildWeekView, dashboardWeekOptions, defaultCompletedWeek, discoverNewsletterPublications, loadAnalyticsStore, loadLegacyManualSnapshots, weekStartFor } from "./model.js";
import { renderAnalyticsDashboard, renderAnalyticsReport } from "./render.js";
import { appendAccountSnapshots, collectLinkedInAccount, collectXAccount, latestAccountSnapshots, loadAccountStore } from "./account.js";

export async function runAnalytics(action: string, days = 30, requestedWeek?: string): Promise<void> {
  assertProDistribution("Audience analytics");
  if (!["collect", "weekly", "account", "report", "dashboard", "due"].includes(action)) throw new Error("Unknown analytics action");
  authorize(["collect", "weekly", "account"].includes(action) ? "manage" : "read");
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("days must be 1–365");
  const root = activeRoot();
  const catalog = discoverNewsletterPublications(root);
  if (["collect", "weekly"].includes(action)) {
    const selected = catalog.filter((p) => p.date >= addDays(todayStamp(), -days) && p.date <= todayStamp());
    // Browser destinations are deliberately sequential: two collectors cannot own one Chrome profile.
    for (const adapter of Object.values(ADAPTERS)) {
      const snapshots = await adapter.collectMetrics(selected);
      if (snapshots.length) { appendSnapshots(root, snapshots); console.log(`${adapter.platform}: ${snapshots.filter((s) => s.status === "collected" || s.status === "partial").length}/${snapshots.length} measured`); }
    }
  }
  if (["account", "weekly"].includes(action)) {
    const account = [await collectLinkedInAccount(), await collectXAccount()];
    appendAccountSnapshots(root, account);
    console.log(account.map((s) => `${s.platform} account: ${s.status}`).join("\n"));
  }
  const snapshots = [...loadAnalyticsStore(root).snapshots, ...loadLegacyManualSnapshots(root, catalog)];
  if (requestedWeek && !/^\d{4}-\d{2}-\d{2}$/.test(requestedWeek)) throw new Error("week must be YYYY-MM-DD");
  const week = requestedWeek ? weekStartFor(requestedWeek) : defaultCompletedWeek(catalog, todayStamp());
  const view = buildWeekView(catalog, snapshots, week);
  if (action === "due") {
    for (const issue of view.newsletters) for (const channel of issue.channels) if (channel.receipt && !["collected", "partial"].includes(channel.status)) console.log(`${issue.publication.key} ${channel.platform}: ${channel.status} ${channel.note ?? "no current measurement"}`);
  }
  if (["report", "dashboard", "weekly"].includes(action)) {
    mkdirSync(contained(root, "docs"), { recursive: true });
    writeFileSync(contained(root, "docs/metrics-report.md"), renderAnalyticsReport(view, new Date().toISOString()));
    const views = dashboardWeekOptions(availableWeeks(catalog), week).map((w) => buildWeekView(catalog, snapshots, w));
    writeFileSync(contained(root, "docs/analytics-dashboard.html"), renderAnalyticsDashboard(views, new Date().toISOString(), week, latestAccountSnapshots(loadAccountStore(root))));
    console.log(`Analytics artifacts written; ${view.measuredSurfaces}/${view.expectedSurfaces} current measurements in ${week}`);
  }
}
