// Unit tests for the PURE video-link logic (snippet + URN detection key).
// Run: npx tsx src/publish/linkVideoIntoNewsletter.test.ts
import { videoLinkSnippet, videoUrnOf } from "./linkVideoIntoNewsletter.js";

let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`PASS ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

const url = "https://www.linkedin.com/feed/update/urn:li:ugcPost:1111222233334444";
const snip = videoLinkSnippet(url);

check("snippet contains the url", snip.includes(url));
check("snippet has the call-to-action", /Watch .*discuss/i.test(snip));
check("snippet escapes & as &amp; (valid html)", snip.includes("&amp;") && !/&(?!amp;)/.test(snip));
check("http url accepted", videoLinkSnippet("http://example.com/x").includes("example.com"));
check("empty url → no snippet", videoLinkSnippet("") === "");
check("non-http url → no snippet", videoLinkSnippet("javascript:alert(1)") === "");
check("whitespace url → no snippet", videoLinkSnippet("   ") === "");

check("urn extracted from feed url", videoUrnOf(url) === "1111222233334444");
// THE invariant the live-editor detection relies on: the URN we dedupe/verify on must actually be
// present in the snippet HTML (it lives inside the <a href>, which survives LinkedIn sanitization).
check("urn is present in the snippet (detection key holds)", snip.includes(videoUrnOf(url)));
check("urn falls back to the url when there's no ugcPost", videoUrnOf("https://x.test/y") === "https://x.test/y");
check("urn handles empty", videoUrnOf("") === "");

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
