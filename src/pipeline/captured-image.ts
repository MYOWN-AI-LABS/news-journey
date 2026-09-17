import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { contained } from "../workspaces.js";
import type { VisualPlan } from "./visual-plan.js";

/**
 * A captured image as evidence: real bytes of a real format, inside the package, hashed. Kept free of
 * pipeline/model imports so callers that load early (the journey state, connector workers) do not
 * drag `util.js`'s workspace resolution in at import time.
 */
export function capturedImage(dir: string, file: string | undefined, sourceUrl: string, kind: "repo-screenshot" | "source-image"): VisualPlan["image"] {
  if (!file || !/\.(png|jpe?g|webp)$/i.test(file)) return undefined;
  let path: string;
  try { path = contained(dir, file); } catch { return undefined; }
  if (!existsSync(path)) return undefined;
  const data = readFileSync(path);
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data[0] === 255 && data[1] === 216;
  const webp = data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpeg && !webp) return undefined;
  return { file, sha256: createHash("sha256").update(data).digest("hex"), sourceUrl, kind };
}
