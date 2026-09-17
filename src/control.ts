import { releaseProfile, assertProDistribution } from './release-profile.js';
import { newsletterKeyFor } from './newsletter-key.js';
import { controlPage } from "./control-page.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, openSync, closeSync, writeFileSync, createReadStream, statSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CODE_ROOT, activeRoot, atomicJson, authenticate, authorize, contained, deskFor, listWorkspaces, read, safeId, workspaceRoot, type Actor } from "./workspaces.js";
import { controlEvents, controlState } from "./control-state.js";
import { packageFingerprint } from "./release-control.js";
import { recordClick, resolveAttribution } from "./attribution.js";
import { dispatchWebhooks } from "./webhooks.js";
import { executiveState, executivePermission, completedPreview } from './executive-actions.js';
import { connectorController } from './connector-control.js';
import { runWatchdog, WorkerInterruptedError, type WatchdogUpdate, type WatchedAttempt } from './watchdog.js';
import { registerManagedChild, stopManagedChild } from './managed-process.js';

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, mime: string, cache: string) {
  const size = statSync(file).size;
  res.setHeader('content-type', mime);
  res.setHeader('cache-control', cache);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('accept-ranges', 'bytes');
  let start = 0, end = size - 1;
  // No validators are issued: an If-Range request receives the complete current file.
  const range = req.method === 'GET' && !req.headers['if-range'] ? req.headers.range : undefined;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 });
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('content-length', Math.max(0, end - start + 1));
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

async function bodyOf(req: IncomingMessage, max = 16384): Promise<Record<string, unknown>> {
  let raw = "";
  req.setEncoding('utf8');
  for await (const chunk of req) { raw += String(chunk); if (Buffer.byteLength(raw) > max) throw new Error("Request too large"); }
  const body = JSON.parse(raw || "{}");
  if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected a JSON object");
  return body;
}
export function workerAction(root: string, token: string, input: Record<string, unknown>, update?: (value: WatchdogUpdate) => void): Promise<Record<string, unknown>> {
  if (input.action === 'journey' && ['quick-preview', 'draft', 'story-choice', 'visual-choice'].includes(String(input.operation))) {
    const actor = authenticate(root, token);
    return runWatchdog(root, actor.id, input, (request, runId) => launchWorker(root, token, request, runId), update);
  }
  const worker = launchWorker(root, token, input); update?.({ pid: worker.pid }); return worker.result;
}
function launchWorker(root: string, token: string, input: Record<string, unknown>, runId?: string): WatchedAttempt<Record<string, unknown>> {
    const env: NodeJS.ProcessEnv = { HARNESS_TOKEN: token, ...(runId ? { HARNESS_WATCHDOG_RUN: runId } : {}) };
    // USER/LOGNAME/USERNAME: the Claude CLI finds its saved login by user name (macOS Keychain); without them a worker's
    // `claude -p` answered "OAuth session expired" while the same login worked in a shell (found by the Jordan simulation).
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "USERNAME", "CODEX_HOME", "USERPROFILE", "SystemRoot", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "HARNESS_PRO_ISSUER_PUBLIC_KEY", "VOICEBOX_START_COMMAND"]) if (process.env[key]) env[key] = process.env[key]; // the Pro issuer is test-only; Voicebox start is an explicit operator opt-in
    const workspace = root === CODE_ROOT ? [] : ["--workspace", read<{ id: string }>(join(root, "workspace.json"), { id: "" }).id];
    // Remove inherited .env values, then the worker loads only its selected workspace's file.
    const detached = process.platform !== 'win32';
    const child = spawn(process.execPath, ["--import", "tsx", join(CODE_ROOT, "src/control-worker.ts"), ...workspace], { cwd: CODE_ROOT, env, detached, stdio: ["pipe", "pipe", "pipe"] });
    let stopping: Error | undefined, cleanup: Promise<void> | undefined;
    const unregister = registerManagedChild(child, { detached, terminationGraceMs: 10000, onTerminate: error => { stopping = error; } });
    const stop = () => cleanup ??= stopManagedChild(child, detached, new WorkerInterruptedError('Worker interrupted; saved stages are retained'));
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout = (stdout + d).slice(-512000); });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    child.on("error", error => { unregister(); reject(error); });
    child.on("close", async (code, signal) => {
      const interrupted = stopping;
      try { await stop(); } catch (error) { unregister(); reject(error); return; }
      unregister();
      if (interrupted || signal) return reject(new WorkerInterruptedError(interrupted?.message || `Worker exited on ${signal}`));
      if (code) {
        for (const line of stderr.trim().split("\n").reverse()) try { const row = JSON.parse(line); if (typeof row.controlError === "string") return reject(new Error(row.controlError.slice(0, 1000))); } catch { /* a warning line */ }
        return reject(new WorkerInterruptedError(stderr.trim().slice(0, 500) || `Worker exited without a result (${code})`));
      }
      for (const line of stdout.trim().split("\n").reverse()) try { const row = JSON.parse(line); if (row.controlResult) return resolve(row.controlResult); } catch { /* normal CLI log */ }
      reject(new WorkerInterruptedError("Worker returned no action receipt"));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
  return { result, stop, pid: child.pid };
}
export function createControlServer(options: { codeRoot?: string; mutate?: typeof workerAction } = {}) {
  const codeRoot = options.codeRoot ?? CODE_ROOT;
  const mutate = options.mutate ?? workerAction;
  const connectors = connectorController(codeRoot);
  const server = createServer(async (req, res) => {
    const send = (code: number, value: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value)); };
    try {
      const host = req.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return send(403, { error: "Loopback host required" });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(403, { error: "Cross-origin requests refused" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, version: 1 });
      if (req.method === "GET" && url.pathname === '/linkedin') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; object-src 'none'; frame-ancestors 'none'" });
        return res.end(readFileSync(join(codeRoot, 'src/linkedin-page.html'), 'utf8'));
      }
      if (req.method === "GET" && ["/", "/control", "/journey"].includes(url.pathname)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; media-src 'self' blob:; frame-src 'self' blob:; img-src 'self' data: https:; object-src 'none'; frame-ancestors 'none'" }); return res.end(url.pathname === '/journey' ? readFileSync(join(codeRoot, 'src/executive-page.html'), 'utf8') : controlPage);
      }
      if (req.method === 'GET' && ['/connector-ui.js', '/journey-ui.js', '/local-voice-ui.js', '/personal-profile-ui.js'].includes(url.pathname)) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(readFileSync(join(codeRoot, 'src', url.pathname.slice(1)))); }
      const journeyAsset = url.pathname.match(/^\/journey-assets\/(myownai-logo\.png|fraunces\.woff2|ibm-plex-sans\.woff2|walkthrough-v8\.mp4|walkthrough-poster\.jpg|walkthrough-v8\.vtt|walkthrough-chapters\.json|sample-(?:slides|avatar|hybrid)\.(?:mp4|jpg)|sample\.vtt|styles\/(?:newsletter|framing|background|captions)-[a-z]+\.jpg)$/);
      if (['GET', 'HEAD'].includes(req.method ?? '') && journeyAsset) {
        const file = join(codeRoot, 'docs/journey-assets', journeyAsset[1]);
        if (!existsSync(file)) return send(404, { error: 'Journey asset unavailable' });
        const ext = journeyAsset[1].split('.').pop()!;
        const mime: Record<string, string> = { woff2: 'font/woff2', mp4: 'video/mp4', jpg: 'image/jpeg', png: 'image/png', vtt: 'text/vtt; charset=utf-8', json: 'application/json; charset=utf-8' };
        return sendFile(req, res, file, mime[ext], 'no-cache');
      }
      if (req.method === 'GET' && url.pathname === '/guide') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self'; img-src 'self' data:; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' });
        return res.end(readFileSync(join(codeRoot, 'docs/personalize-and-publish.html'), 'utf8'));
      }
      const slug = url.searchParams.get("workspace") ?? undefined;
      const root = workspaceRoot(codeRoot, slug);
      const redirect = url.pathname.match(/^\/r\/([a-f0-9]{24})$/);
      if (redirect && ["GET", "HEAD"].includes(req.method ?? "")) {
        const link = resolveAttribution(root, redirect[1]);
        if (!link) return send(404, { error: "Unknown link" });
        if (req.method === "GET") recordClick(root, link);
        res.writeHead(302, { location: link.destination, "cache-control": "no-store", "referrer-policy": "no-referrer" }); return res.end();
      }
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
      const actor = authenticate(root, token);
      if (req.method === "GET" && url.pathname === "/v1/workspaces") {
        const possible = [{ id: "legacy", root: codeRoot }, ...listWorkspaces(codeRoot)];
        return send(200, possible.flatMap((w) => { try { authenticate(w.root, token); return [{ id: w.id }]; } catch { return []; } }));
      }
      authorize("read", { root, actor });
      if (req.method === 'GET' && url.pathname === '/v1/linkedin') {
        const { linkedinSaved } = await import('./linkedin-tools.js');
        return send(200, linkedinSaved(root, actor.id, url.searchParams.get('receipt') ?? undefined));
      }
      if (url.pathname.startsWith('/v1/connectors')) {
        if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) throw new Error('Content-Type application/json required');
        const data = req.method === 'POST' ? await bodyOf(req, 65536) : {};
        const human = req.headers.origin === `http://${host}` && req.headers['x-harness-human'] === 'click';
        return send(200, await connectors.handle(url.pathname, req.method || 'GET', root, token, `http://${host}`, data, human));
      }
      if (req.method === 'GET' && url.pathname === '/v1/personal-profile') {
        authorize('manage', { root, actor });
        const { personalProfileState } = await import('./personal-profile-actions.js');
        return send(200, personalProfileState(root, actor));
      }
      if (req.method === 'GET' && url.pathname === '/v1/journey') return send(200, executiveState(root, actor.role, actor.id));
      if (req.method === 'GET' && url.pathname === '/v1/engagement') return send(200, releaseProfile(codeRoot).edition === 'free' ? { items: [], total: 0, capabilities: {}, available: false, reason: 'Audience outreach is planned for Pro.' } : { ...(await import('./engagement.js')).engagementState(root), followUps: (await import('./engagement-followup.js')).followUpState(root) });
      if (req.method === 'GET' && url.pathname === '/v1/journey/dashboard') {
        assertProDistribution('Audience analytics', codeRoot);
        const file = contained(root, 'docs/analytics-dashboard.html');
        if (!existsSync(file)) return send(404, { error: 'Build the results dashboard first' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
        return res.end(readFileSync(file));
      }
      const jobPath = url.pathname.match(/^\/v1\/journey\/jobs\/([a-f0-9]{64})$/);
      if (req.method === 'GET' && jobPath) {
        const job = read<any>(contained(root, 'state/journey-jobs', jobPath[1] + '.json'), null);
        if (!job || job.actor !== actor.id) return send(404, { error: 'Unknown action' });
        if (job.status === 'running' && Number.isSafeInteger(job.pid) && job.pid > 0) {
          try { process.kill(job.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') job.status = 'interrupted'; }
        }
        return send(200, job);
      }
      const journeyAction = url.pathname.match(/^\/v1\/journey\/([a-z-]+)$/);
      if (req.method === 'POST' && journeyAction) {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: 'Use application/json' });
        const operation = journeyAction[1], permission = executivePermission(operation);
        if (['persona', 'personal-profile-share', 'personal-profile-unshare'].includes(operation) && (req.headers.origin !== `http://${host}` || req.headers['x-harness-human'] !== 'click')) return send(403, { error: 'Sharing personal context requires your explicit local browser click' });
        const body = await bodyOf(req, operation === 'linkedin-workbench' ? 256 * 1024 : ['media', 'newsletter-settings', 'voicebox-create', 'personalize', 'visual-choice'].includes(operation) ? 9 * 1024 * 1024 : 32768);
        const packageId = operation.startsWith('engagement-') ? body.videoId : body.id;
        const meta = typeof packageId === 'string' ? read<any>(contained(root, 'workdir/videos', safeId(packageId), 'meta.json'), {}) : {};
        authorize(permission, { root, actor, edition: meta.edition || (typeof body.edition === 'string' ? safeId(body.edition) : 'daily-roundup'), author: meta.createdBy, platform: typeof body.platform === 'string' ? body.platform : undefined });
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error('Idempotency-Key required');
        const id = createHash('sha256').update(actor.id + ':' + key).digest('hex');
        const path = contained(root, 'state/journey-jobs', id + '.json');
        // Store neither submitted credentials nor credential-bearing results in job receipts.
        const digest = createHash('sha256').update(JSON.stringify({ operation, body })).digest('hex');
        const previous = read<any>(path, null);
        if (previous) return send(previous.digest === digest ? 202 : 409, previous.digest === digest ? { job: id } : { error: 'Idempotency key already used' });
        mkdirSync(contained(root, 'state/journey-jobs'), { recursive: true });
        const job = { id, actor: actor.id, operation, edition: meta.edition || (typeof body.edition === 'string' ? safeId(body.edition) : 'daily-roundup'), digest, status: 'running', pid: null as number | null, startedAt: new Date().toISOString() };
        const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(job)); } finally { closeSync(fd); }
        const update = (value: WatchdogUpdate) => { Object.assign(job, value); atomicJson(path, job); };
        if (operation === 'member-add' || operation === 'watchdog') {
          try { const result = await mutate(root, token, { action: 'journey', operation, data: body }); atomicJson(path, { ...job, status: 'done' }); return send(200, result); }
          catch (error) { atomicJson(path, { ...job, status: 'failed', finishedAt: new Date().toISOString(), error: String((error as Error).message).slice(0, 500) }); throw error; }
        }
        void mutate(root, token, { action: 'journey', operation, data: body }, update).then(
          result => atomicJson(path, { ...job, status: 'done', finishedAt: new Date().toISOString(), result }),
          error => atomicJson(path, { ...job, status: 'failed', finishedAt: new Date().toISOString(), error: String(error.message).slice(0, 500) })
        ).catch(error => console.error('Cannot save action receipt:', error.message));
        return send(202, { job: id });
      }
      if (req.method === "GET" && url.pathname === "/v1/state") return send(200, controlState(root));
      if (req.method === "GET" && url.pathname === "/v1/analytics") return send(200, controlState(root).analytics);
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid event offset");
        const events = controlEvents(root); return send(200, { events: events.slice(offset, offset + 500), nextOffset: Math.min(events.length, offset + 500) });
      }
      const preview = url.pathname.match(/^\/v1\/packages\/([A-Za-z0-9_-]+)\/preview$/);
      if (req.method === 'GET' && preview) {
        const ready = completedPreview(root, preview[1]);
        return ready ? send(200, ready) : send(409, { error: 'This package does not have a completed video and matching newsletter. Return to Create and review to see its progress.' });
      }
      const artifact = url.pathname.match(/^\/v1\/packages\/([A-Za-z0-9_-]+)\/artifact\/(topic\.json|script\.json|final\.mp4|newsletter\.html|newsletter\.linkedin\.html)$/);
      if (["GET", "HEAD"].includes(req.method ?? '') && artifact) {
        const id = safeId(artifact[1]);
        const meta = read<{ id: string; edition?: string }>(contained(root, "workdir/videos", id, "meta.json"), { id });
        if (artifact[2].startsWith('newsletter.') && read<any>(contained(root, 'workdir/newsletters', newsletterKeyFor(meta) + '.json'), null)?.sourceVideoId !== id) return send(409, { error: 'The saved newsletter belongs to another package. Open its matching preview in Create and review.' });
        const path = artifact[2].startsWith("newsletter.") ? contained(root, "workdir/newsletters", newsletterKeyFor(meta) + (artifact[2] === "newsletter.html" ? ".html" : ".linkedin.html")) : contained(root, "workdir/videos", id, artifact[2]);
        if (!existsSync(path) || !statSync(path).isFile()) return send(404, { error: "Artifact missing" });
        return sendFile(req, res, path, artifact[2].endsWith('.mp4') ? 'video/mp4' : artifact[2].endsWith('.html') ? 'text/html' : 'application/json', 'no-store');
      }
      const packagePath = url.pathname.match(/^\/v1\/packages\/([A-Za-z0-9_-]+)$/);
      if (req.method === "GET" && packagePath) return send(200, { id: packagePath[1], hash: packageFingerprint(root, packagePath[1]) });
      const actionPath = url.pathname.match(/^\/v1\/packages\/([A-Za-z0-9_-]+)\/(approve|hold|retry)$/);
      if (req.method === "POST" && actionPath) {
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "Use application/json" });
        const id = safeId(actionPath[1]), action = actionPath[2];
        const body = await bodyOf(req);
        const meta = read<{ edition?: string; createdBy?: string } | null>(contained(root, "workdir/videos", id, "meta.json"), null);
        if (!meta) return send(404, { error: "Unknown package" });
        authorize(action === "retry" ? "publish" : "approve", { root, actor, edition: meta.edition ?? "daily-roundup", author: meta.createdBy, platform: typeof body.platform === "string" ? body.platform : undefined });
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error("An Idempotency-Key of 8–128 characters is required");
        const payload = { id, action, expectedHash: body.expectedHash, reason: body.reason, platform: body.platform };
        const digest = createHash("sha256").update(JSON.stringify({ actor: actor.id, payload })).digest("hex");
        const record = contained(root, "state/control-operations", createHash("sha256").update(key).digest("hex") + ".json");
        const previous = read<{ digest: string; status: string; result?: unknown } | null>(record, null);
        if (previous) {
          if (previous.digest !== digest) return send(409, { error: "Idempotency key already used for another action" });
          if (previous.status === "done") return send(200, previous.result);
          return send(409, { error: "Action already attempted; inspect package state before starting another action" });
        }
        if (action === "approve" && (typeof body.expectedHash !== "string" || body.expectedHash !== packageFingerprint(root, id))) return send(409, { error: "Package changed; review its current hash" });
        // Reserve with O_EXCL before any await, so two requests cannot trigger the same action.
        const { mkdirSync } = await import("node:fs"); mkdirSync(join(root, "state/control-operations"), { recursive: true });
        const fd = openSync(record, "wx", 0o600); writeFileSync(fd, JSON.stringify({ digest, status: "pending" })); closeSync(fd);
        try {
          const result = await mutate(root, token, payload);
          atomicJson(record, { digest, status: "done", result }); return send(200, result);
        } catch (error) { atomicJson(record, { digest, status: "failed" }); throw error; }
      }
      return send(404, { error: "Unknown endpoint" });
    } catch (error) {
      const message = (error as Error).message;
      const status = /Unauthorized/.test(message) ? 401 : /Forbidden|Independent reviewer/.test(message) ? 403 : /Busy|Conflict|EEXIST/.test(message) ? 409 : 400;
      send(status, { error: message.slice(0, 500) });
    }
  });
  server.on('close', () => connectors.close());
  return server;
}
export async function serveControl(port = 4791): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const server = createControlServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  console.log(`Content control API: http://127.0.0.1:${port}`);
  let dispatching = false;
  const timer = setInterval(async () => {
    if (dispatching) return; dispatching = true;
    try { for (const root of [CODE_ROOT, ...listWorkspaces().map((w) => w.root)]) await dispatchWebhooks(root); }
    catch (e) { console.error(`webhooks: ${(e as Error).message}`); }
    finally { dispatching = false; }
  }, 5000);
  server.on("close", () => clearInterval(timer));
}
