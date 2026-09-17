import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const requestedPlatform = process.argv.find((arg) => arg.startsWith("--platform="))?.split("=", 2)[1];
const targetPlatform = requestedPlatform || process.platform;
const escapeXml = (value) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const template = targetPlatform === "win32"
  ? join(root, "ops", "windows", "com.example.content-harness.xml.template")
  : targetPlatform === "darwin"
    ? join(root, "ops", "launchd", "com.example.content-harness.plist.template")
    : null;

if (!template) throw new Error(`No schedule template for ${targetPlatform}; supported platforms are macOS and Windows`);
process.stdout.write(readFileSync(template, "utf8").replaceAll("__PROJECT_ROOT__", escapeXml(root)));
