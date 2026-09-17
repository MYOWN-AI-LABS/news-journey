import { releaseLock } from "./release-lock.js";
import type { Command } from "commander";
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CODE_ROOT, activeRoot, authorize, contained, loadWorkspaceEnv, createWorkspace, currentActor, desks, initControlToken, isWorkspace, issueMember, listWorkspaces, members, read, safeId, saveDesk, updateMember, type Action, type Role } from "./workspaces.js";

function tokenFile(path: string, issue: () => string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, issue() + "\n"); } catch (error) { unlinkSync(path); throw error; } finally { closeSync(fd); }
}
export function registerControlCommands(program: Command, includeWorkspaces = true): void {
  if (includeWorkspaces) {
  program.option("--workspace <slug>", "isolate configuration, credentials and artifacts in this workspace");
  const workspace = program.command("workspace").description("Manage isolated projects");
  workspace.command("list").action(() => console.log(JSON.stringify(listWorkspaces(), null, 2)));
  workspace.command("create <slug>").action((slug: string) => console.log(createWorkspace(slug)));
  workspace.command("migrate").description("Copy the legacy install into default; retain original files").action(() => console.log(createWorkspace("default", true)));
  }
  const member = program.command("members").description("Workspace members and API credentials");
  member.command("list").action(() => { authorize("manage"); console.log(JSON.stringify(members().map(({ tokenHash, ...m }) => m), null, 2)); });
  member.command("add <id>").requiredOption("--role <role>").option("--desks <ids>", "comma-separated desk ids").requiredOption("--token-file <path>", "private output file for the new member's credential")
    .action((id, opts) => { tokenFile(opts.tokenFile, () => issueMember(activeRoot(), id, opts.role as Role, opts.desks?.split(",") ?? [])); console.log("Member added; credential written to the requested file."); });
  member.command("set-role <id> <role>").action((id, role) => updateMember(activeRoot(), id, { role }));
  member.command("assign <id> <desks>").action((id, value) => updateMember(activeRoot(), id, { desks: value.split(",") }));
  member.command("remove <id>").action((id) => updateMember(activeRoot(), id, { disabled: true }));
  const desk = program.command("desk").description("Assign editorial work and permitted channels");
  desk.command("list").action(() => { authorize("read"); console.log(JSON.stringify(desks(), null, 2)); });
  desk.command("set <id>").requiredOption("--editions <ids>").requiredOption("--channels <ids>").option("--two-person", "require a reviewer other than the author", false)
    .action((id, opts) => saveDesk(activeRoot(), id, { editions: opts.editions.split(","), channels: opts.channels.split(","), twoPersonRule: opts.twoPerson }));
  program.command("api:token").description("Create an admin credential for the local control API").requiredOption("--output <path>")
    .action((opts) => { tokenFile(opts.output, () => initControlToken()); console.log("Control credential written to the requested private file."); });
  program.command("api:serve").description("Serve the authenticated local API and signed event webhooks").option("--port <port>", "loopback port", "4791")
    .action(async (opts) => { const { serveControl } = await import("./control.js"); await serveControl(Number(opts.port)); });
  program.command("verify:posts").option("--id <id>").action(async (opts) => { const { verifyPosts } = await import("./post/verify.js"); console.log(JSON.stringify(await verifyPosts(opts.id), null, 2)); });
  program.command("analytics").argument("<action>", "collect|weekly|report|dashboard|due").option("--days <days>", "lookback", "30")
    .action(async (action, opts) => { const { runAnalytics } = await import("./analytics/cli.js"); await runAnalytics(action, Number(opts.days)); });
  program.command("delivery:clear-attempt").description("Clear a stopped attempt only after independently confirming that no post exists")
    .requiredOption("--id <id>").requiredOption("--platform <platform>").requiredOption("--reason <reason>").option("--confirmed-absent")
    .action(async (opts) => {
      if (!opts.confirmedAbsent || !opts.reason.trim()) throw new Error("Independently confirm no post exists, then supply --confirmed-absent and a reason");
      const { ADAPTERS } = await import("./post/adapter.js"); if (!Object.hasOwn(ADAPTERS, opts.platform)) throw new Error("Unknown destination");
      const { videoDir, readJson } = await import("./util.js"); const dir = videoDir(opts.id);
      const meta = readJson<{ edition?: string; posts?: Record<string, unknown> }>(join(dir, "meta.json"));
      authorize("publish", { edition: meta.edition ?? "daily-roundup", platform: opts.platform });
      if (meta.posts?.[opts.platform]) throw new Error("A receipt already exists; never clear it to make a duplicate");
      const { finishAttempt, pendingAttempt } = await import("./post/attempt.js"); finishAttempt(dir, opts.platform);
      if (pendingAttempt(dir, opts.platform)) throw new Error("Attempt hold could not be cleared; inspect file permissions");
      const { appendDeliveryEvent } = await import("./post/delivery.js"); appendDeliveryEvent(dir, { type: "release.withheld", videoId: opts.id, reason: "operator-confirmed-absent", detail: { platform: opts.platform, note: opts.reason } });
      console.log("Attempt hold cleared; a separate retry still enforces approval and publication gates.");
    });
  program.command("attribution:create").requiredOption("--id <id>").requiredOption("--platform <platform>").requiredOption("--url <url>")
    .action(async (opts) => { authorize("manage"); const { createAttribution } = await import("./attribution.js"); console.log(JSON.stringify(createAttribution(activeRoot(), opts.id, opts.platform, opts.url), null, 2)); });
  let unlock: (() => void) | undefined;
  program.hook("postAction", () => { unlock?.(); unlock = undefined; });
  program.hook("preAction", async (_root, command) => {
    const global = command.optsWithGlobals();
    if (global.workspace) process.env.HARNESS_WORKSPACE = global.workspace;
    const parent = command.parent?.name(); const name = command.name();
    if (["workspace", "members", "desk"].includes(parent ?? "")) { if (name !== "list") unlock = parent === "workspace" ? releaseLock(CODE_ROOT, "workspaces") : releaseLock(); return; }
    if (["api:serve", "api:token"].includes(name)) return;
    const root = activeRoot();
    // Load the selected workspace's environment only. No production .env is imported into a tenant.
    loadWorkspaceEnv(root);
    const opts = command.opts();
    const id = opts.id ?? (["approve", "reject", "preview"].includes(name) ? command.args[0] : undefined);
    const meta = id ? read<{ edition?: string; createdBy?: string }>(contained(root, "workdir/videos", safeId(id), "meta.json"), {}) : {};
    let action: Action = "read";
    if (["produce", "harvest", "rank", "script", "assets", "voice", "avatar", "render", "newsletter"].includes(name)) action = "produce";
    if (["approve", "reject"].includes(name)) action = "approve";
    if (["post", "delivery:clear-attempt", "newsletter:publish", "newsletter:linkvideo", "newsletter:linkedin"].includes(name)) action = "publish";
    if (name === "auth" || name.endsWith("-login") || ["models:ollama-profile", "attribution:create"].includes(name)) action = "manage";
    if (action !== "read") unlock = releaseLock(root);
    authorize(action, { root, edition: meta.edition ?? opts.edition ?? "daily-roundup", author: meta.createdBy, platform: opts.only });
  });
}
