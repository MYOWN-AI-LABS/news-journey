import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelIdentity } from './model-identity.js';

export interface InstalledModelAliasProof {
  version: 1; name: string; digest: string; baseName: string; baseDigest: string;
  manifestText: string; baseManifestText: string; configText: string; baseConfigText: string;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (value: any): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function manifest(value: string) {
  if (Buffer.byteLength(value) > 65536) throw new Error('Local manifest exceeds 64 KiB');
  const row = JSON.parse(value);
  if (row.schemaVersion !== 2 || !/^sha256:[a-f0-9]{64}$/.test(row.config?.digest) || !Array.isArray(row.layers) || row.layers.length > 32
    || row.layers.some((layer: any) => !/^application\/vnd\.ollama\.image\.[a-z]+$/.test(layer.mediaType) || !/^sha256:[a-f0-9]{64}$/.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size < 1)
    || row.layers.filter((layer: any) => layer.mediaType === 'application/vnd.ollama.image.model').length !== 1) throw new Error('Invalid local model manifest');
  return row;
}
/** A renamed model gets no guessed family/fit: only parameter-layer changes are eligible. */
export function validInstalledAliasProof(proof: InstalledModelAliasProof | undefined, identity: ModelIdentity): boolean {
  try {
    if (!proof || proof.version !== 1 || proof.name !== (identity.provider === 'opencode' ? identity.model.slice(7) : identity.model)
      || proof.digest !== identity.digest || proof.digest === proof.baseDigest || sha(proof.manifestText) !== proof.digest || sha(proof.baseManifestText) !== proof.baseDigest) return false;
    const alias = manifest(proof.manifestText), base = manifest(proof.baseManifestText);
    const layers = (value: any) => value.layers.filter((layer: any) => layer.mediaType !== 'application/vnd.ollama.image.params')
      .map(({ mediaType, digest, size }: any) => ({ mediaType, digest, size }));
    if (stable(layers(alias)) !== stable(layers(base))) return false;
    if (sha(proof.configText) !== alias.config.digest.slice(7) || sha(proof.baseConfigText) !== base.config.digest.slice(7)
      || Buffer.byteLength(proof.configText) !== alias.config.size || Buffer.byteLength(proof.baseConfigText) !== base.config.size) return false;
    const { rootfs: _aliasRoot, ...aliasConfig } = JSON.parse(proof.configText);
    const { rootfs: _baseRoot, ...baseConfig } = JSON.parse(proof.baseConfigText);
    return stable(aliasConfig) === stable(baseConfig) && aliasConfig.model_format === identity.format
      && aliasConfig.file_type === identity.quantization;
  } catch { return false; }
}
function bounded(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Local model provenance must be a bounded regular file');
  const value = readFileSync(path, 'utf8');
  if (Buffer.byteLength(value) !== stat.size) throw new Error('Local model provenance changed while reading');
  return value;
}
function pathFor(root: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) throw new Error('Only exact local library aliases are eligible');
  const [model, tag] = name.split(':');
  return join(root, 'manifests/registry.ollama.ai/library', model!, tag!);
}
export function inspectInstalledAlias(identity: ModelIdentity, bases: { name: string; digest: string | null }[], root = process.env.OLLAMA_MODELS || join(homedir(), '.ollama/models')): InstalledModelAliasProof | null {
  try {
    const name = identity.provider === 'opencode' ? identity.model.slice(7) : identity.model;
    const manifestText = bounded(pathFor(root, name)), alias = manifest(manifestText);
    if (sha(manifestText) !== identity.digest) return null;
    for (const base of bases) {
      if (!base.digest || base.name === name) continue;
      try {
        const baseManifestText = bounded(pathFor(root, base.name)), source = manifest(baseManifestText);
        const proof: InstalledModelAliasProof = { version: 1, name, digest: identity.digest!, baseName: base.name, baseDigest: base.digest,
          manifestText, baseManifestText, configText: bounded(join(root, 'blobs', alias.config.digest.replace(':', '-'))), baseConfigText: bounded(join(root, 'blobs', source.config.digest.replace(':', '-'))) };
        if (validInstalledAliasProof(proof, identity)) return proof;
      } catch { /* This base is not a proven match. */ }
    }
  } catch { /* Unknown provenance cannot authorize memory fit. */ }
  return null;
}
