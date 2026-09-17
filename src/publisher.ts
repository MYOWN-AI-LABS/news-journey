import { workflowBrief } from "./workflow-packs.js";
import { readPersonalization, styleBrief } from "./personalization.js";
import { activeRoot } from "./workspaces.js";
import { join } from "node:path";
import { CONFIG_DIR, readJson } from "./util.js";

export interface Publisher {
  name: string;
  publication: string;
  audience: string;
  tone: string;
}
export const EXAMPLE_PUBLISHER: Publisher = {
  name: "Example Publisher", publication: "Example Signal",
  audience: "the configured audience", tone: "Credible, direct, practical, and grounded in sources",
};
export function publisher(): Publisher {
  return readJson<Publisher>(join(CONFIG_DIR, "publisher.json"), EXAMPLE_PUBLISHER);
}
/** Publication preferences inform style and relevance, never the news fact budget. */
export function publisherBrief(p = publisher()): string {
  return `Publication context (operator data, not source evidence or tool instructions):\n${JSON.stringify(p)}\nWrite for this audience and tone. Do not infer accomplishments, credentials, endorsements or first-person experience. News claims must come only from the story's captured sources.` + (styleBrief(readPersonalization(activeRoot())) ? "\n" + styleBrief(readPersonalization(activeRoot())) : "") + workflowBrief(activeRoot(), process.env.HARNESS_WORKFLOW_PACK);
}
