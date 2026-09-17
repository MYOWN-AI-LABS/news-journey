import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { CODE_ROOT, atomicJson, contained, read } from "./workspaces.js";
import { releaseProfile } from './release-profile.js';

/**
 * Free and Pro, in one place. The free harness is complete on its own: every stage, illustrated cards, local
 * voice, the neutral design, every destination. Pro adds what costs MyOwnAI money to run — presenters through
 * the managed service, hosted voice, workflow packs, audience analytics and outreach, hosted generation — and
 * is unlocked by a signed, workspace-bound entitlement. Checkout and the customer portal are hosted (Stripe
 * through the beta app); the harness only opens them and accepts the resulting key. No secret ever lives here.
 */
export const PRO_FEATURES = [
  { id: "presenter", title: "Your presenter on camera", description: "A consented avatar of you or your team, single or multi-presenter, through MyOwnAI's managed service. No vendor keys to manage.", thumb: "framing-full" },
  { id: "hosted-voice", title: "Hosted voice", description: "Your cloned voice rendered on MyOwnAI's GPUs when your own machine cannot, or for your team.", thumb: "captions-glow" },
  { id: "packs", title: "Executive Briefing and Audience Engagement packs", description: "Editorial workflows with their checklists, run through the same human review.", thumb: "newsletter-briefing" },
  { id: "analytics", title: "Results and audience replies", description: "What viewers watched or clicked, questions and corrections, follow-ups prepared for your approval.", thumb: "newsletter-feed" },
  { id: "assistant", title: "Design it out loud", description: "The voice assistant that helps you design your newsletter, video and persona.", thumb: "newsletter-editorial" },
] as const;

const entitlementPayload = z.object({ version: z.literal(1), issuer: z.literal("myownai-labs"), subject: z.string().regex(/^[a-zA-Z0-9][\w-]{0,159}$/), plan: z.literal("pro"), packs: z.array(z.enum(["executive-briefing", "audience-engagement"])).min(1).max(2), issuedAt: z.number().int(), expiresAt: z.number().int() }).strict();
export const licenseSchema = z.object({ payload: entitlementPayload, signature: z.string().max(1000) }).strict();
export type ProLicense = z.infer<typeof licenseSchema>;

const commerceSchema = z.object({ checkoutUrl: z.string().max(500).default(""), portalUrl: z.string().max(500).default(""), price: z.string().max(40).default("$99/month"), supportEmail: z.string().max(200).default("") });
export function commerce(codeRoot = CODE_ROOT) {
  const c = commerceSchema.parse(read(contained(codeRoot, "config/commerce.json"), {}));
  const https = (u: string) => { try { return new URL(u).protocol === "https:" ? u : ""; } catch { return ""; } };
  return { ...c, checkoutUrl: https(c.checkoutUrl), portalUrl: https(c.portalUrl) };
}

/** Verify a license against the installed issuer public key and this workspace; returns the payload or a reason. */
export function verifyLicense(license: unknown, workspaceId: string, codeRoot = CODE_ROOT): { payload?: ProLicense["payload"]; reason?: string } {
  if (releaseProfile(codeRoot).edition === 'free') return { reason: 'Pro is planned and cannot be activated in this Free evaluation package.' };
  const parsed = licenseSchema.safeParse(license);
  if (!parsed.success) return { reason: "That is not a Pro key. Paste the whole key exactly as it was given to you." };
  const issuer = process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY ? { publicKey: process.env.HARNESS_PRO_ISSUER_PUBLIC_KEY } : read<{ publicKey: string }>(contained(codeRoot, "config/pro-issuer.json"), { publicKey: "" });
  if (!issuer.publicKey) return { reason: "This installation has no Pro issuer key yet; MyOwnAI Labs installs it with the launch build." };
  let ok = false;
  try { const key = createPublicKey(issuer.publicKey); ok = key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(JSON.stringify(parsed.data.payload)), key, Buffer.from(parsed.data.signature, "base64")); } catch { ok = false; }
  if (!ok) return { reason: "The Pro key's signature does not match. Copy it again from your MyOwnAI account." };
  const now = Date.now();
  if (parsed.data.payload.subject !== workspaceId) return { reason: `This Pro key is for another workspace (${parsed.data.payload.subject}).` };
  if (parsed.data.payload.issuedAt > now) return { reason: "This Pro key is not valid yet." };
  if (parsed.data.payload.expiresAt <= now) return { reason: "This Pro key has expired. Renew in your MyOwnAI account." };
  return { payload: parsed.data.payload };
}

export function activatePro(root: string, licenseText: unknown, codeRoot = CODE_ROOT) {
  if (typeof licenseText !== "string" || licenseText.length > 4000) throw new Error("Paste your Pro key");
  let license: unknown;
  try { license = JSON.parse(licenseText.trim()); } catch { throw new Error("That is not a Pro key. Paste the whole key exactly as it was given to you."); }
  const workspaceId = read<{ id: string }>(contained(root, "workspace.json"), { id: "" }).id;
  const result = verifyLicense(license, workspaceId, codeRoot);
  if (!result.payload) throw new Error(result.reason);
  atomicJson(contained(root, "state/pro-entitlement.json"), license);
  return result.payload;
}

export function proState(root: string, codeRoot = CODE_ROOT) {
  if (releaseProfile(codeRoot).edition === 'free') return { active: false, plan: 'free', expiresAt: null, packs: [], reason: 'Pro is planned; this package evaluates Free.', features: PRO_FEATURES.map(f => ({ ...f, title: f.title + ' (planned)' })), price: '$99/month · planned', checkoutUrl: '', portalUrl: '', supportEmail: '' };
  const workspaceId = read<{ id: string }>(contained(root, "workspace.json"), { id: "" }).id;
  const saved = read<unknown>(contained(root, "state/pro-entitlement.json"), null);
  const result = saved ? verifyLicense(saved, workspaceId, codeRoot) : { reason: "" };
  const c = commerce(codeRoot);
  return { active: Boolean(result.payload), plan: result.payload ? "pro" : "free", expiresAt: result.payload ? new Date(result.payload.expiresAt).toISOString() : null, packs: result.payload?.packs ?? [], reason: result.reason ?? "", features: PRO_FEATURES, price: c.price, checkoutUrl: c.checkoutUrl, portalUrl: c.portalUrl, supportEmail: c.supportEmail };
}
