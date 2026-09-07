import { createHmac } from 'node:crypto';
import type { HostedPackagedAsset } from '@noodle-borg/compiler';
import type { AssetScope } from '@noodle-borg/module';

/**
 * Shared object-key + public-URL derivation for the hosted asset adapters (GCS and R2). Object keys
 * blind their tenant/app/env path segments with a keyed HMAC so a leaked key or provider error body
 * never reveals org/app/env slugs; the public URL is the blinded object-key path under the isolated
 * asset origin (ADR 0075/0076), so a pure-CDN edge maps it 1:1 to the stored object with no token→key
 * lookup. Both are deterministic from (scope, content hash), so dedupe, rollback recovery, and
 * re-verification reproduce the same identity across adapters.
 */

/** The asset fields needed to derive a canonical identity — shared by Prepared + Hosted shapes. */
export type AssetIdentity = Pick<
  HostedPackagedAsset,
  'logicalId' | 'sourcePath' | 'contentHash' | 'mimeType' | 'byteLength' | 'width' | 'height'
>;

export const DEFAULT_KEY_SALT = 'noodle-asset-key-v1';

/** Strip the `sha256:` prefix from a content hash, leaving the raw hex digest. */
export function sha256Hex(contentHash: string): string {
  return contentHash.startsWith('sha256:') ? contentHash.slice('sha256:'.length) : contentHash;
}

/** HMAC-blind a single path segment (org/app/env) to a stable 16-hex token under the key salt. */
export function blindSegment(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16);
}

/** The blinded `<org>/<app>/<env>/` object-key prefix for a tenant scope. */
export function scopePrefix(salt: string, scope: AssetScope): string {
  return `${blindSegment(salt, scope.org)}/${blindSegment(salt, scope.app)}/${blindSegment(salt, scope.env)}/`;
}

/**
 * Derive the canonical {@link HostedPackagedAsset} for an asset under a scope: the blinded, content-hash
 * addressed object key and the public URL (the blinded key path under `publicBase`). The client-supplied
 * object key is never used — recomputing from (scope, content hash) is what stops a caller pointing a
 * deploy at another tenant's object.
 */
export function deriveHostedAsset(
  salt: string,
  scope: AssetScope,
  asset: AssetIdentity,
  publicBase: string,
): HostedPackagedAsset {
  const hash = sha256Hex(asset.contentHash);
  const objectKey = `${scopePrefix(salt, scope)}${hash}/${asset.logicalId}`;
  return {
    logicalId: asset.logicalId,
    sourcePath: asset.sourcePath,
    contentHash: asset.contentHash,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    width: asset.width,
    height: asset.height,
    objectKey,
    publicUrl: `${publicBase.replace(/\/+$/, '')}/${objectKey}`,
  };
}
