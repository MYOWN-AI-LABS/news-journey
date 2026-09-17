export const DRY_RUN_ENV = "AI_CONTENT_DRY_RUN";

export function enableDryRun(): void {
  process.env[DRY_RUN_ENV] = "1";
}

export function isDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DRY_RUN_ENV] === "1" || env[DRY_RUN_ENV]?.toLowerCase() === "true";
}

export function assertDryRunTopicFile(topicFile: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (isDryRun(env) && !topicFile) {
    throw new Error("--dry-run requires --topic-file so harvesting, ranking models, and web research remain offline");
  }
}

export function shouldStopAfterSelection(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDryRun(env);
}
