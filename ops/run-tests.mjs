import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function findTests(directory) {
  const tests = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...await findTests(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      tests.push(relative(root, path).split(sep).join("/"));
    }
  }
  return tests;
}

const tests = await findTests(join(root, "src"));
tests.push('scripts/engagement-followup.test.mjs', 'scripts/engagement-ui.test.mjs');
if (tests.length === 0) throw new Error("No src/**/*.test.ts files found");

// Integration files share the checkout's workspace-creation lock; run them serially.
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...tests], {
  cwd: root,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
