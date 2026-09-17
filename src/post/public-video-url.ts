import type { VideoMeta } from "../types.js";
import { isIP } from "node:net";
import { linkedInVideoUrl } from "./linkedin-video-url.js";

function isPrivateHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!hostname.includes(".") && isIP(hostname) === 0) return true;
  if (["local", "lan", "internal"].includes(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".lan") || hostname.endsWith(".internal")) return true;
  if (isIP(hostname) === 6) {
    if (hostname === "::" || hostname === "::1" || hostname.startsWith("::ffff:")) return true;
    if (/^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname) || /^ff/.test(hostname) || hostname.startsWith("2001:db8:")) return true;
    const first = Number.parseInt(hostname.split(":")[0], 16);
    return !Number.isFinite(first) || first < 0x2000 || first > 0x3fff;
  }
  if (isIP(hostname) !== 4) return false;
  const [a, b, c] = hostname.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

/** Customer-facing links must be public HTTPS even when read from an older cached artifact. */
export function isPublicVideoUrl(raw: string | undefined): boolean {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

export async function publicVideoUrl(meta: VideoMeta, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (meta.posts.linkedin) return linkedInVideoUrl(meta.posts.linkedin.id);

  const template = env.PUBLIC_VIDEO_URL_TEMPLATE;
  if (!template || (template.match(/\{id\}/g) ?? []).length !== 1) {
    throw new Error("Instagram and Threads require a LinkedIn video receipt or PUBLIC_VIDEO_URL_TEMPLATE containing one {id}");
  }
  const templateUrl = new URL(template);
  const decodedPath = decodeURIComponent(templateUrl.pathname);
  if ((decodedPath.match(/\{id\}/g) ?? []).length !== 1) throw new Error("PUBLIC_VIDEO_URL_TEMPLATE must place exactly one {id} in the URL path");
  const resolved = template.replace("{id}", encodeURIComponent(meta.id));
  const url = new URL(resolved);
  if (!isPublicVideoUrl(url.toString())) throw new Error("PUBLIC_VIDEO_URL_TEMPLATE must use a public https host");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_VIDEO_URL_TEMPLATE must not contain userinfo, query parameters, or fragments");
  }
  return url.toString();
}
