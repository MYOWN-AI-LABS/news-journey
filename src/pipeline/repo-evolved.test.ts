import { repoFullNameFromUrl } from "./repo-evolved.js";

const cases: [string, string | null][] = [
  ["https://github.com/example-org/example-repo", "example-org/example-repo"],
  ["https://github.com/sample-labs/toolkit/", "sample-labs/toolkit"],
  ["https://github.com/example-org/example-repo.git", "example-org/example-repo"],
  ["https://example.com/index/x", null],
  ["https://github.com/orgs/example-org", null],
];

let passed = 0;
for (const [url, expected] of cases) {
  const actual = repoFullNameFromUrl(url);
  const ok = actual === expected;
  passed += ok ? 1 : 0;
  console.log(ok ? "PASS" : "FAIL", url, "->", actual);
}
console.log(passed + "/" + cases.length);
if (passed !== cases.length) process.exitCode = 1;
