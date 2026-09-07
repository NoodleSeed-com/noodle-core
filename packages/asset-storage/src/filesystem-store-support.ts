import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { lstat, unlink } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import type { HostedPackagedAsset, PreparedPackagedAsset } from '@noodle-borg/compiler';
import { AssetPlanError, type AssetUploadTarget } from '@noodle-borg/module';
import { sha256Hex } from './asset-key.js';
import type {
  FilesystemAssetReservation,
  FilesystemAssetReservationState,
} from './filesystem-coordination.js';
import {
  FilesystemAssetSecurityError,
  isMissing,
  isPositiveSafeInteger,
  MAX_FILESYSTEM_ASSET_IMAGE_DIMENSION,
  SAFE_FILESYSTEM_ASSET_LOGICAL_ID,
  type StoredFilesystemAssetMetadata,
} from './filesystem-layout.js';
import type { PendingUpload } from './filesystem-upload-registry.js';

export const MAX_IMAGE_DIMENSION = MAX_FILESYSTEM_ASSET_IMAGE_DIMENSION;

export interface StagedUpload {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

export function validatePreparedAsset(asset: PreparedPackagedAsset): void {
  if (
    typeof asset.logicalId !== 'string' ||
    !SAFE_FILESYSTEM_ASSET_LOGICAL_ID.test(asset.logicalId)
  ) {
    throw new AssetPlanError(`asset logical ID "${asset.logicalId}" is not filesystem-safe`);
  }
  if (
    typeof asset.sourcePath !== 'string' ||
    asset.sourcePath.length === 0 ||
    asset.sourcePath.length > 4096
  ) {
    throw new AssetPlanError(`asset "${asset.logicalId}" has an invalid source path`);
  }
  if (typeof asset.contentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.contentHash)) {
    throw new AssetPlanError(`asset "${asset.logicalId}" must use a canonical sha256 content hash`);
  }
  if (!isPositiveSafeInteger(asset.byteLength)) {
    throw new AssetPlanError(`asset "${asset.logicalId}" must have a positive byte length`);
  }
  if (!isPositiveSafeInteger(asset.width) || !isPositiveSafeInteger(asset.height)) {
    throw new AssetPlanError(`asset "${asset.logicalId}" must have positive dimensions`);
  }
  if (asset.width > MAX_IMAGE_DIMENSION || asset.height > MAX_IMAGE_DIMENSION) {
    throw new AssetPlanError(`asset "${asset.logicalId}" dimensions exceed the limit`);
  }
  if (
    typeof asset.mimeType !== 'string' ||
    asset.mimeType.length === 0 ||
    asset.mimeType.length > 128
  ) {
    throw new AssetPlanError(`asset "${asset.logicalId}" has an invalid content type`);
  }
}

export function validateHostedIdentity(asset: HostedPackagedAsset): void {
  validatePreparedAsset({ ...asset, absolutePath: '' });
}

export function validateQuota<
  T extends { readonly scope: string; readonly maxStoredBytes: number },
>(quota: T): T {
  const segments = quota.scope.split('/');
  if (
    segments.length < 1 ||
    segments.length > 3 ||
    segments.some((segment) => segment.length === 0) ||
    !isPositiveSafeInteger(quota.maxStoredBytes)
  ) {
    throw new TypeError('filesystem asset quota must be scope=positive-safe-integer-bytes');
  }
  return quota;
}

export function normalizeHttpBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AssetPlanError('asset base URL must be an absolute HTTP URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new AssetPlanError('asset base URL must be a bare HTTP origin');
  }
  return url.origin;
}

export function sameAssetIdentity(left: HostedPackagedAsset, right: HostedPackagedAsset): boolean {
  return (
    left.logicalId === right.logicalId &&
    left.sourcePath === right.sourcePath &&
    left.contentHash === right.contentHash &&
    left.mimeType === right.mimeType &&
    left.byteLength === right.byteLength &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function assetIdentityHash(asset: HostedPackagedAsset): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        asset.objectKey,
        asset.logicalId,
        asset.sourcePath,
        asset.contentHash,
        asset.mimeType,
        asset.byteLength,
        asset.width,
        asset.height,
      ]),
    )
    .digest('hex');
}

export function isPendingReservation(
  reservation: FilesystemAssetReservation,
  pending: PendingUpload,
): boolean {
  return (
    reservation.id === pending.reservationId &&
    reservation.objectKey === pending.asset.objectKey &&
    reservation.identityHash === assetIdentityHash(pending.asset) &&
    reservation.byteLength === pending.asset.byteLength &&
    reservation.expiresAt === pending.expiresAt
  );
}

export function uploadHeaders(asset: HostedPackagedAsset): Readonly<Record<string, string>> {
  return {
    'content-type': asset.mimeType,
    'x-noodle-content-length': String(asset.byteLength),
    'x-noodle-content-sha256': sha256Hex(asset.contentHash),
  };
}

export function uploadTarget(
  uploadBase: string,
  uploadPathPrefix: string,
  token: string,
  pending: PendingUpload,
): AssetUploadTarget {
  return {
    logicalId: pending.asset.logicalId,
    objectKey: pending.asset.objectKey,
    uploadUrl: `${uploadBase}${uploadPathPrefix}/${token}`,
    method: 'PUT',
    headers: pending.headers,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

export function withoutReservation(
  state: FilesystemAssetReservationState,
  reservationId: string,
): FilesystemAssetReservationState {
  return {
    version: 1,
    capabilities: state.capabilities.filter((item) => item.id !== reservationId),
  };
}

export function withoutObjectReservations(
  state: FilesystemAssetReservationState,
  objectKey: string,
): FilesystemAssetReservationState {
  return {
    version: 1,
    capabilities: state.capabilities.filter((item) => item.objectKey !== objectKey),
  };
}

export function uniqueReservedBytes(
  state: FilesystemAssetReservationState,
  prefix?: string,
): bigint {
  const objects = new Map<string, number>();
  for (const item of state.capabilities) {
    if (prefix !== undefined && !item.objectKey.startsWith(`${prefix}/`)) continue;
    objects.set(item.objectKey, Math.max(objects.get(item.objectKey) ?? 0, item.byteLength));
  }
  return [...objects.values()].reduce((sum, value) => sum + BigInt(value), 0n);
}

export function storedAndReservedBytes(
  committed: readonly StoredFilesystemAssetMetadata[],
  state: FilesystemAssetReservationState,
  prefix: string,
): bigint {
  const objects = new Map<string, number>();
  for (const metadata of committed) {
    if (metadata.objectKey.startsWith(`${prefix}/`)) {
      objects.set(metadata.objectKey, metadata.asset.byteLength);
    }
  }
  for (const reservation of state.capabilities) {
    if (!reservation.objectKey.startsWith(`${prefix}/`)) continue;
    objects.set(
      reservation.objectKey,
      Math.max(objects.get(reservation.objectKey) ?? 0, reservation.byteLength),
    );
  }
  return [...objects.values()].reduce((sum, value) => sum + BigInt(value), 0n);
}

export async function assertStagedIdentity(staged: StagedUpload): Promise<void> {
  const stats = await lstat(staged.path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.dev !== staged.device ||
    stats.ino !== staged.inode
  ) {
    throw new FilesystemAssetSecurityError('asset temporary path identity changed');
  }
}

export async function safeUnlinkStaged(staged: StagedUpload): Promise<void> {
  try {
    await assertStagedIdentity(staged);
    await unlink(staged.path);
  } catch (error) {
    if (!isMissing(error) && !(error instanceof FilesystemAssetSecurityError)) throw error;
  }
}

export function positiveInteger(value: number, label: string): number {
  if (!isPositiveSafeInteger(value) || value >= bufferConstants.MAX_LENGTH)
    throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

export async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    offset += result.bytesWritten;
  }
}

export async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function fail(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = Buffer.from(`${JSON.stringify({ error })}\n`);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    ...headers,
  });
  res.end(body);
}
