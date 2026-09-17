// Unit tests for the pure live/deleted detection. Fixtures include representative LinkedIn
// "article not found" page text.
// Run: npx tsx --test src/pipeline/newsletter-live.test.ts
import { isDeletedPage, isLiveArticleTitle, markerMatchesExpectedSubject } from "./newsletter-live.js";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS ${name}`);
  else { failed++; console.log(`FAIL ${name}`); }
}

// ---- isDeletedPage: only a DEFINITIVE deletion counts (fail-open elsewhere) ----
const NOT_FOUND_HTML = `<html><body>The article you were looking for was not found. Redirecting you to the feed in 5 seconds...</body></html>`;
const LIVE_HTML = `<html><head><title>Example Signal · Extra Edition № 3 | Example Publisher</title></head><body>...</body></html>`;

check("deleted: real LinkedIn not-found body → gone", isDeletedPage(200, NOT_FOUND_HTML) === true);
check("deleted: 404 → gone", isDeletedPage(404, "") === true);
check("deleted: 410 → gone", isDeletedPage(410, "") === true);
check("deleted: live article body → NOT gone", isDeletedPage(200, LIVE_HTML) === false);
check("deleted: 999 authwall → NOT gone (fail-open)", isDeletedPage(999, "Sign in to LinkedIn") === false);
check("deleted: 503 transient → NOT gone (fail-open)", isDeletedPage(503, "") === false);
check("deleted: 401 authwall → NOT gone (fail-open)", isDeletedPage(401, "") === false);

// ---- isLiveArticleTitle: positive proof required ----
const SUBJ = "Washington Bets On Quantum As AI Turns Defensive";
check("live: publication name without subject → NOT live", isLiveArticleTitle("Example Signal · Extra № 3", SUBJ) === false);
check("live: subject words present → live", isLiveArticleTitle("Washington Bets On Quantum As AI Turns Defensive", SUBJ) === true);
check("live: exact subject with publisher suffix → live", isLiveArticleTitle(`${SUBJ} | Example Publisher`, SUBJ) === true);
check("live: LinkedIn login title → NOT live", isLiveArticleTitle("Sign Up | LinkedIn", SUBJ) === false);
check("live: empty title → NOT live", isLiveArticleTitle("", SUBJ) === false);
check("live: partial subject overlap → NOT live", isLiveArticleTitle("Washington Quantum Defensive Update", SUBJ) === false);
check("live: no expected subject → NOT live", isLiveArticleTitle("Example Signal", "") === false);

// ---- marker binding: a marker cannot validate a different local/staged issue ----
check("marker: exact normalized expected subject → match", markerMatchesExpectedSubject(SUBJ, SUBJ) === true);
check("marker: punctuation/case normalization → match", markerMatchesExpectedSubject("WASHINGTON: bets on quantum as AI turns defensive", SUBJ) === true);
check("marker: stale pushed/published subject after current issue changes → NOT match", markerMatchesExpectedSubject("Washington Bets On Quantum Hardware", SUBJ) === false);
check("marker: empty subject → NOT match", markerMatchesExpectedSubject("", SUBJ) === false);

console.log(failed === 0 ? `\n${"".padEnd(0)}ALL PASS` : `\n${failed} FAILED`);
if (failed) process.exit(1);
