import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { openExternal } from "../platform.js";
import { log } from "../util.js";

export const REDIRECT_PORT = 8585;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

/** Open the provider's consent URL and wait for the one-shot redirect with ?code=. */
export function captureAuthCode(authUrl: string, options: { port?: number; open?: typeof openExternal; timeoutMs?: number } = {}): Promise<string> {
  const state = randomBytes(24).toString("hex");
  const consent = new URL(authUrl); consent.searchParams.set("state", state);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let url: URL;
      try { url = new URL(req.url ?? '/', REDIRECT_URI); } catch { res.writeHead(400).end(); return; }
      if (req.method !== 'GET' || url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) { res.writeHead(400).end("Invalid authorization state. Return to the original sign-in tab."); return; }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html", "Connection": "close" });
      res.end(`<html><body style="font-family:sans-serif"><h2>${code ? "✅ Authorized — you can close this tab." : "Authorization was not completed"}</h2></body></html>`);
      clearTimeout(timer); server.close();
      if (code) resolve(code);
      else reject(new Error(`OAuth error: ${error ?? "no code returned"}`));
    });
    server.once("error", error => { clearTimeout(timer); reject(error); });
    server.listen(options.port ?? REDIRECT_PORT, "127.0.0.1", () => {
      log(`Waiting for OAuth redirect on ${REDIRECT_URI} ...`);
      log(`Authorize URL (open manually if no tab appeared): ${consent.href}`);
      try { (options.open ?? openExternal)(consent.href, (error) => log(`OAuth browser open failed: ${error.message}`)); }
      catch (error) { clearTimeout(timer); server.close(); reject(error); }
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("OAuth timed out after 30 minutes"));
    }, options.timeoutMs ?? 1_800_000); timer.unref();
  });
}
