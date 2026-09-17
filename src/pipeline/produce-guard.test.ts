import { isShipped } from "./produce.js";

const cases: [string, boolean][] = [
  // shipped → guard SKIPS (true)
  ["posted", true],
  ["approved", true],
  ["pending_review", true],
  // half-produced → guard must NOT skip; it recovers and re-produces (false)
  ["selected", false],
  ["scripted", false],
  ["voiced", false],
  ["rendered", false],
];

let ok = 0;
for (const [status, expected] of cases) {
  const got = isShipped(status as never);
  const pass = got === expected;
  ok += pass ? 1 : 0;
  console.log(pass ? "PASS" : "FAIL", `isShipped(${status}) ->`, got, "(expected", expected + ")");
}
console.log(`${ok}/${cases.length}`);
if (ok !== cases.length) process.exit(1);
