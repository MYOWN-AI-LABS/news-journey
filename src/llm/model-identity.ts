import { createHash } from 'node:crypto';

/** A measurement belongs to this exact runtime, not a model family or a similar computer. */
export interface ModelIdentity {
  provider: string;
  model: string;
  baseUrl: string;
  digest: string | null;
  format?: string | null;
  quantization?: string | null;
  context: { mode: 'requested' | 'installed-model-default'; tokens: number | null; proof: 'request' | 'model-parameter' | 'observed' | 'unknown' };
  reasoningEffort?: string;
  runtimeVersion: string | null;
  protocolVersion: number;
  hardwareFingerprint: string;
}

export const MODEL_IDENTITY_VERSION = 1;
export function modelIdentityKey(identity: ModelIdentity): string {
  return createHash('sha256').update(JSON.stringify({
    provider: identity.provider, model: identity.model, baseUrl: identity.baseUrl,
    digest: identity.digest, format: identity.format ?? null, quantization: identity.quantization ?? null, context: { mode: identity.context.mode, tokens: identity.context.tokens, proof: identity.context.proof },
    reasoningEffort: identity.reasoningEffort ?? 'default', runtimeVersion: identity.runtimeVersion,
    protocolVersion: identity.protocolVersion, hardwareFingerprint: identity.hardwareFingerprint,
  })).digest('hex');
}

export function hasMeasuredModelIdentity(identity: ModelIdentity | null | undefined): identity is ModelIdentity {
  return !!identity && identity.protocolVersion === MODEL_IDENTITY_VERSION && !!identity.provider && !!identity.model
    && /^(?:sha256:)?[a-f0-9]{64}$/.test(identity.digest ?? '')
    && /^[a-f0-9]{64}$/.test(identity.hardwareFingerprint)
    && typeof identity.runtimeVersion === 'string' && !!identity.runtimeVersion.trim()
    && !!identity.context && ['requested', 'installed-model-default'].includes(identity.context.mode)
    && ['request', 'model-parameter', 'observed'].includes(identity.context.proof)
    && Number.isSafeInteger(identity.context.tokens) && identity.context.tokens! > 0;
}

export function sameModelIdentity(a: ModelIdentity | null | undefined, b: ModelIdentity | null | undefined): boolean {
  return hasMeasuredModelIdentity(a) && hasMeasuredModelIdentity(b) && modelIdentityKey(a) === modelIdentityKey(b);
}
