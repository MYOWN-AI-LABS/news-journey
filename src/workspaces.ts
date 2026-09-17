import { assertEvaluationAction } from './local-evaluation.js';
/** Local workspaces use separate files and credentials. Filesystem access remains the trust boundary. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, cpSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";

export const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROLES = ["owner", "admin", "editor", "reviewer", "viewer"] as const;
export type Role = typeof ROLES[number];
export type Action = "read" | "produce" | "approve" | "publish" | "manage" | "delete";
export interface Actor { id: string; role: Role }
export interface Member extends Actor { tokenHash: string; disabled?: boolean; desks?: string[] }
export interface Desk { editions: string[]; channels: string[]; twoPersonRule?: boolean }
export type Desks = Record<string, Desk>;
const ROLES_FOR: Record<Action, readonly Role[]> = {
  read: ROLES, produce: ["owner", "admin", "editor"], approve: ["owner", "admin", "reviewer"],
  publish: ["owner", "admin"], manage: ["owner", "admin"], delete: ["owner"],
};
export function safeId(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)) throw new Error("Invalid identifier");
  return value;
}
export function contained(root: string, ...parts: string[]): string {
  const path = resolve(root, ...parts);
  const rel = relative(resolve(root), path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path leaves workspace");
  // Check every existing ancestor: a symlink must not turn a scoped path into another tenant.
  let cursor = path;
  while (!existsSync(cursor) && cursor !== dirname(cursor)) cursor = dirname(cursor);
  if (existsSync(cursor)) {
    const actualRoot = existsSync(root) ? realpathSync(root) : resolve(root);
    const actual = realpathSync(cursor);
    const r = relative(actualRoot, actual);
    if (r.startsWith("..") || isAbsolute(r)) throw new Error("Symlink leaves workspace");
  }
  return path;
}
export function workspaceRoot(codeRoot = CODE_ROOT, slug?: string): string {
  if (!slug) return existsSync(join(codeRoot, "workspaces/default/workspace.json")) ? workspaceRoot(codeRoot, "default") : codeRoot;
  const root = contained(codeRoot, "workspaces", safeId(slug));
  if (!existsSync(join(root, "workspace.json"))) throw new Error(`Unknown workspace: ${slug}`);
  if (lstatSync(root).isSymbolicLink()) throw new Error("Workspace cannot be a symlink");
  return root;
}
function argument(name: string): string | undefined {
  const equal = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("-")) throw new Error(`--${name} requires a value`);
  return value;
}
export function activeRoot(): string { return workspaceRoot(CODE_ROOT, argument("workspace") ?? process.env.HARNESS_WORKSPACE); }
export function isWorkspace(root = activeRoot()): boolean { return existsSync(join(root, "workspace.json")); }
export function read<T>(path: string, fallback: T): T { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : fallback; }
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const memberPath = (root: string) => contained(root, isWorkspace(root) ? "members.json" : "state/control-members.json");
export function members(root = activeRoot()): Member[] { return read<Member[]>(memberPath(root), []); }
export function authenticate(root: string, token: string): Member {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Unauthorized");
  const digest = Buffer.from(hash(token), "hex");
  const member = members(root).find((m) => !m.disabled && /^[a-f0-9]{64}$/.test(m.tokenHash) && timingSafeEqual(Buffer.from(m.tokenHash, "hex"), digest));
  if (!member || !ROLES.includes(member.role)) throw new Error("Unauthorized");
  return member;
}
function identityPath(): string { return process.env.HARNESS_IDENTITY_FILE || join(homedir(), ".content-harness", "identity.json"); }
export function localToken(root: string): string { return process.env.HARNESS_TOKEN ?? read<Record<string, string>>(identityPath(), {})[hash(resolve(root))] ?? ""; }
export function currentActor(root = activeRoot()): Actor {
  if (process.env.HARNESS_TOKEN || isWorkspace(root)) { const { id, role } = authenticate(root, localToken(root)); return { id, role }; }
  return { id: userInfo().username, role: "owner" }; // Legacy CLI remains owned by the OS account.
}
export function desks(root = activeRoot()): Desks { return read<Desks>(contained(root, "desks.json"), {}); }
export function deskFor(edition: string, root = activeRoot()): string | undefined {
  return Object.entries(desks(root)).find(([, d]) => d.editions.includes(edition))?.[0];
}
export function authorize(action: Action, opts: { root?: string; actor?: Actor; edition?: string; author?: string; platform?: string } = {}): Actor {
  const root = opts.root ?? activeRoot();
  assertEvaluationAction(root, action);
  const actor = opts.actor ?? currentActor(root);
  if (!ROLES_FOR[action].includes(actor.role)) throw new Error(`Forbidden: ${actor.role} cannot ${action}`);
  const deskName = opts.edition ? deskFor(opts.edition, root) : undefined;
  const desk = deskName ? desks(root)[deskName] : undefined;
  const member = members(root).find((m) => m.id === actor.id);
  if (isWorkspace(root) && ["produce", "approve"].includes(action) && !["owner", "admin"].includes(actor.role)) {
    if (!opts.edition || !deskName || !member?.desks?.includes(deskName)) throw new Error("Forbidden: edition is outside your assigned desks");
  }
  if (action === "approve" && desk?.twoPersonRule && (!opts.author || opts.author === actor.id)) throw new Error("Independent reviewer required; author cannot approve this package");
  if (opts.platform && desk && !desk.channels.includes(opts.platform)) throw new Error("Destination is outside this desk");
  return actor;
}
export function profilePath(name: string, legacy: string, envName?: string): string {
  const root = activeRoot();
  if (isWorkspace(root)) return contained(root, "state", "browser-profiles", safeId(name));
  return (envName && process.env[envName]?.trim()) || legacy;
}
export function createWorkspace(slug: string, migrate = false, codeRoot = CODE_ROOT): string {
  safeId(slug);
  if (process.env.HARNESS_TOKEN || process.env.HARNESS_WORKSPACE) authorize("manage");
  if (migrate && (process.env.HARNESS_TOKEN || process.env.HARNESS_WORKSPACE)) throw new Error("Legacy migration requires the local OS owner without a member token");
  const target = join(codeRoot, "workspaces", slug);
  if (existsSync(target)) throw new Error("Workspace already exists");
  if (migrate && slug !== "default") throw new Error("Migration uses the default workspace");
  // Configure from the installed template; no provider state is copied for a new workspace.
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    cpSync(join(codeRoot, "config"), join(target, "config"), { recursive: true, dereference: false });
    if (migrate) for (const name of ["workdir", "state", ".env"]) {
      if (existsSync(join(codeRoot, name))) cpSync(join(codeRoot, name), join(target, name), { recursive: true, dereference: false });
    }
    if (migrate) {
      const copyReferences = (value: unknown): void => {
        if (typeof value === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_./ -]*\.(png|jpe?g|webp|svg|mp4|mov|wav|mp3)$/i.test(value) && !isAbsolute(value)) {
          const source = contained(codeRoot, value);
          if (existsSync(source) && lstatSync(source).isFile() && !value.startsWith("examples/")) {
            const destination = contained(target, value); mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination);
          }
        } else if (Array.isArray(value)) value.forEach(copyReferences);
        else if (value && typeof value === "object") Object.values(value).forEach(copyReferences);
      };
      for (const name of ["pipeline.json", "avatar.json"]) copyReferences(read(join(codeRoot, "config", name), {}));
      const editions = join(codeRoot, "config/editions");
      if (existsSync(editions)) for (const name of readdirSync(editions).filter((n) => n.endsWith(".json"))) copyReferences(read(join(editions, name), {}));
    } else {
      const platforms = read<Record<string, { enabled: boolean }>>(join(target, "config/platforms.json"), {});
      for (const p of Object.values(platforms)) p.enabled = false;
      atomicJson(join(target, "config/platforms.json"), platforms);
      const cfg = read<Record<string, unknown>>(join(target, "config/pipeline.json"), {});
      cfg.autonomy = "review"; delete cfg.siteUrl;
      atomicJson(join(target, "config/pipeline.json"), cfg);
    }
    for (const d of ["state", "workdir", "workdir/videos", "workdir/newsletters", "workdir/harvest", "docs"]) mkdirSync(join(target, d), { recursive: true, mode: 0o700 });
    atomicJson(join(target, "desks.json"), {});
    const token = randomBytes(32).toString("hex");
    atomicJson(join(target, "members.json"), [{ id: "local-owner", role: "owner", tokenHash: hash(token) }]);
    const identities = read<Record<string, string>>(identityPath(), {});
    identities[hash(resolve(target))] = token;
    atomicJson(identityPath(), identities);
    // Marker last: a failed copy cannot become the active default workspace.
    atomicJson(join(target, "workspace.json"), { id: slug, name: slug, createdAt: new Date().toISOString() });
    return target;
  } catch (e) { throw new Error(`Workspace creation incomplete at ${target}; original files are unchanged: ${(e as Error).message}`); }
}
export function issueMember(root: string, id: string, role: Role, assignedDesks: string[] = []): string {
  const actor = authorize("manage", { root });
  safeId(id);
  if (!ROLES.includes(role) || role === "owner") throw new Error("Use admin/editor/reviewer/viewer; ownership cannot be granted by an invite");
  if (assignedDesks.some((d) => !desks(root)[d])) throw new Error("Unknown desk");
  const rows = members(root);
  if (rows.some((m) => m.id === id)) throw new Error("Member already exists");
  const token = randomBytes(32).toString("hex");
  rows.push({ id, role, tokenHash: hash(token), desks: assignedDesks });
  atomicJson(memberPath(root), rows);
  return token;
}
export function updateMember(root: string, id: string, patch: { role?: Role; disabled?: boolean; desks?: string[] }): void {
  authorize("manage", { root });
  const rows = members(root); const member = rows.find((m) => m.id === id);
  if (!member || member.role === "owner" || patch.role === "owner") throw new Error("Owner membership is protected");
  if (patch.role && !ROLES.includes(patch.role)) throw new Error("Unknown role");
  if (patch.desks?.some((d) => !desks(root)[d])) throw new Error("Unknown desk");
  Object.assign(member, patch); atomicJson(memberPath(root), rows);
}
export function saveDesk(root: string, id: string, desk: Desk): void {
  authorize("manage", { root }); safeId(id);
  const all = desks(root);
  if (!desk.editions.length || !desk.channels.length) throw new Error("A desk needs editions and channels");
  for (const edition of desk.editions) {
    safeId(edition);
    if (!existsSync(contained(root, "config/editions", edition + ".json"))) throw new Error(`Unknown edition: ${edition}`);
    if (Object.entries(all).some(([name, d]) => name !== id && d.editions.includes(edition))) throw new Error("Edition already belongs to a desk");
  }
  const platforms = read<Record<string, unknown>>(contained(root, "config/platforms.json"), {});
  if (desk.channels.some((p) => !Object.hasOwn(platforms, p))) throw new Error("Unknown channel");
  all[id] = desk; atomicJson(contained(root, "desks.json"), all);
}
export function initControlToken(root = activeRoot()): string {
  authorize("manage", { root });
  const rows = members(root);
  const token = randomBytes(32).toString("hex");
  const id = `control-${Date.now()}`;
  rows.push({ id, role: "admin", tokenHash: hash(token) });
  atomicJson(memberPath(root), rows);
  return token;
}
export function listWorkspaces(codeRoot = CODE_ROOT): { id: string; root: string }[] {
  const dir = join(codeRoot, "workspaces");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((s) => /^[a-zA-Z0-9][\w-]*$/.test(s) && existsSync(join(dir, s, "workspace.json")))
    .map((id) => ({ id, root: workspaceRoot(codeRoot, id) }));
}

export function validDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error("Invalid date; expected a real YYYY-MM-DD day");
  return day;
}
export function assetPath(value: string, root = activeRoot()): string {
  if (!isWorkspace(root)) return contained(root, value);
  // Only committed example assets are shared. Private assets stay in the selected workspace.
  if (value.startsWith("examples/")) return contained(join(CODE_ROOT, "examples"), value.slice(9));
  return contained(root, value);
}
const loadedWorkspaceEnvKeys = new Set<string>();
const protectedEnvKey = (key: string) => key.startsWith("HARNESS_") || ["PATH", "HOME", "USERPROFILE", "SystemRoot"].includes(key);
export function loadWorkspaceEnv(root = activeRoot()): void {
  const file = contained(root, ".env");
  if (isWorkspace(root)) {
    // A saved writer change can remove overrides from .env while this worker is alive.
    // Replace the previously loaded workspace values; never leave its old writer/key active.
    for (const key of loadedWorkspaceEnvKeys) if (!protectedEnvKey(key)) delete process.env[key];
    loadedWorkspaceEnvKeys.clear();
    const legacy = join(CODE_ROOT, ".env");
    if (existsSync(legacy)) for (const key of Object.keys(parseEnv(readFileSync(legacy, "utf8")))) {
      if (!protectedEnvKey(key)) delete process.env[key];
    }
    if (existsSync(file)) {
      const values = parseEnv(readFileSync(file, "utf8"));
      Object.assign(process.env, values);
      for (const key of Object.keys(values)) loadedWorkspaceEnvKeys.add(key);
    }
  } else if (existsSync(file)) process.loadEnvFile(file);
}
