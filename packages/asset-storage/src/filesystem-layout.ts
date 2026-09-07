import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import type { HostedPackagedAsset } from '@noodle-borg/compiler';

const DIRECTORY_MODE = 0o700;
const STALE_TEMP_AGE_MS = 30 * 60 * 1000;
const TEMP_FILE_PATTERN = /^\.[a-f0-9]{64}\.(?:bin|json)\.tmp-[a-f0-9]{32}$/;
const STATE_TEMP_FILE_PATTERN =
  /^\.(?:reservations\.tmp|coordination\.(?:pending|recovery-pending|released))-[a-f0-9]{32}$/;
export const MAX_FILESYSTEM_ASSET_METADATA_BYTES = 64 * 1024;
export const MAX_FILESYSTEM_ASSET_REACHABILITY_RECORDS = 256;
export const MAX_FILESYSTEM_ASSET_IMAGE_DIMENSION = 4096;
export const FILESYSTEM_ASSET_PUBLIC_PATH_PREFIX = '/__noodle/hosted-assets';
export const SAFE_FILESYSTEM_ASSET_LOGICAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const SAFE_FILESYSTEM_ASSET_OBJECT_KEY =
  /^[a-f0-9]{16}\/[a-f0-9]{16}\/[a-f0-9]{16}\/[a-f0-9]{64}\/[A-Za-z0-9_-]{1,128}$/;

export interface FilesystemAssetPaths {
  readonly bytes: string;
  readonly metadata: string;
}

interface FilesystemAssetReachability {
  readonly deploymentId: string;
  readonly deploymentVersion: number;
}

export interface StoredFilesystemAssetMetadata {
  readonly version: 1;
  readonly objectKey: string;
  readonly asset: HostedPackagedAsset;
  readonly etag: string;
  readonly reachableBy: readonly FilesystemAssetReachability[];
  /** Once exact reachability saturates, every current or future collector must retain this asset. */
  readonly retainIndefinitely: boolean;
}

interface FilesystemDirectoryIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly realPath: string;
}

/** Stable identities used to detect configured-root or fixed-directory replacement. */
export interface FilesystemAssetLayoutAnchor {
  readonly root: FilesystemDirectoryIdentity;
  readonly objects: FilesystemDirectoryIdentity;
  readonly state: FilesystemDirectoryIdentity;
}

/** A filesystem boundary failure that must never be treated as an ordinary cache miss. */
export class FilesystemAssetSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilesystemAssetSecurityError';
  }
}

export class StoredFilesystemAssetMetadataError extends Error {
  constructor() {
    super('stored asset metadata is invalid');
    this.name = 'StoredFilesystemAssetMetadataError';
  }
}

/** Validate the complete versioned JSON commit marker before any field is trusted. */
export function parseStoredFilesystemAssetMetadata(
  value: unknown,
  expectedObjectKey: string | undefined,
  maxFileBytes: number,
): StoredFilesystemAssetMetadata {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.objectKey !== 'string' ||
    (expectedObjectKey !== undefined && value.objectKey !== expectedObjectKey)
  ) {
    throw new StoredFilesystemAssetMetadataError();
  }
  const objectKey = value.objectKey;
  if (
    !isRecord(value.asset) ||
    !Array.isArray(value.reachableBy) ||
    value.reachableBy.length > MAX_FILESYSTEM_ASSET_REACHABILITY_RECORDS ||
    (value.retainIndefinitely !== undefined && typeof value.retainIndefinitely !== 'boolean')
  ) {
    throw new StoredFilesystemAssetMetadataError();
  }
  const asset = value.asset;
  if (
    !SAFE_FILESYSTEM_ASSET_OBJECT_KEY.test(objectKey) ||
    typeof asset.logicalId !== 'string' ||
    !SAFE_FILESYSTEM_ASSET_LOGICAL_ID.test(asset.logicalId) ||
    typeof asset.sourcePath !== 'string' ||
    asset.sourcePath.length === 0 ||
    asset.sourcePath.length > 4096 ||
    typeof asset.contentHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.contentHash) ||
    typeof asset.mimeType !== 'string' ||
    asset.mimeType.length === 0 ||
    asset.mimeType.length > 128 ||
    !isPositiveSafeInteger(asset.byteLength) ||
    asset.byteLength > maxFileBytes ||
    !isPositiveSafeInteger(asset.width) ||
    !isPositiveSafeInteger(asset.height) ||
    asset.width > MAX_FILESYSTEM_ASSET_IMAGE_DIMENSION ||
    asset.height > MAX_FILESYSTEM_ASSET_IMAGE_DIMENSION ||
    typeof asset.publicUrl !== 'string' ||
    asset.objectKey !== objectKey ||
    value.etag !== filesystemAssetEtag(asset.contentHash)
  ) {
    throw new StoredFilesystemAssetMetadataError();
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(asset.publicUrl);
  } catch {
    throw new StoredFilesystemAssetMetadataError();
  }
  if (
    (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') ||
    publicUrl.username !== '' ||
    publicUrl.password !== '' ||
    publicUrl.search !== '' ||
    publicUrl.hash !== '' ||
    publicUrl.pathname !== `${FILESYSTEM_ASSET_PUBLIC_PATH_PREFIX}/${objectKey}`
  ) {
    throw new StoredFilesystemAssetMetadataError();
  }
  const reachableBy: FilesystemAssetReachability[] = value.reachableBy.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.deploymentId !== 'string' ||
      item.deploymentId.length === 0 ||
      item.deploymentId.length > 256 ||
      !Number.isSafeInteger(item.deploymentVersion) ||
      (item.deploymentVersion as number) < 0
    ) {
      throw new StoredFilesystemAssetMetadataError();
    }
    return {
      deploymentId: item.deploymentId,
      deploymentVersion: item.deploymentVersion as number,
    };
  });
  return {
    version: 1,
    objectKey,
    asset: asset as unknown as HostedPackagedAsset,
    etag: value.etag as string,
    reachableBy,
    retainIndefinitely: value.retainIndefinitely ?? false,
  };
}

export function filesystemAssetEtag(contentHash: string): string {
  return `"${contentHash.slice('sha256:'.length)}"`;
}

/** Validate and normalize the operator-owned durable asset root. */
export function validateFilesystemAssetRoot(root: string): string {
  if (root.trim() === '' || !isAbsolute(root)) {
    throw new TypeError('filesystem asset root must be a non-empty absolute path');
  }
  const normalized = normalize(root);
  if (normalized === parse(normalized).root) {
    throw new TypeError('filesystem asset root must not be a filesystem root');
  }
  return normalized;
}

/**
 * Map the canonical opaque object key to a fixed digest-only physical layout. No caller-controlled
 * key, logical ID, source path, URL, or tenant segment is ever joined onto the storage root.
 */
export function filesystemAssetPaths(root: string, objectKey: string): FilesystemAssetPaths {
  const validatedRoot = validateFilesystemAssetRoot(root);
  if (objectKey.length === 0) throw new TypeError('filesystem asset object key must be non-empty');
  const physicalId = createHash('sha256').update(objectKey, 'utf8').digest('hex');
  const objects = join(validatedRoot, 'objects');
  return {
    bytes: join(objects, `${physicalId}.bin`),
    metadata: join(objects, `${physicalId}.json`),
  };
}

export function filesystemAssetObjectsDirectory(root: string): string {
  return join(validateFilesystemAssetRoot(root), 'objects');
}

export function filesystemAssetStateDirectory(root: string): string {
  return join(validateFilesystemAssetRoot(root), 'state');
}

/** Create the fixed layout, tighten directory permissions, and clean only old recognized temps. */
export async function prepareFilesystemAssetLayout(
  root: string,
): Promise<FilesystemAssetLayoutAnchor> {
  const validatedRoot = validateFilesystemAssetRoot(root);
  await assertNoSymlinkAncestors(validatedRoot);
  await createOrValidateDirectory(validatedRoot, 'asset root');
  const objects = filesystemAssetObjectsDirectory(validatedRoot);
  const state = filesystemAssetStateDirectory(validatedRoot);
  await createOrValidateDirectory(objects, 'asset object directory');
  await createOrValidateDirectory(state, 'asset state directory');
  await assertNoSymlinkAncestors(validatedRoot);
  await cleanStaleTemps(objects);
  await cleanStaleStateTemps(state);
  return {
    root: await directoryIdentity(validatedRoot, 'asset root'),
    objects: await directoryIdentity(objects, 'asset object directory'),
    state: await directoryIdentity(state, 'asset state directory'),
  };
}

/** Re-check directories on each operation so a post-construction symlink replacement fails closed. */
export async function assertFilesystemAssetLayout(
  root: string,
  expected?: FilesystemAssetLayoutAnchor,
): Promise<FilesystemAssetLayoutAnchor> {
  const validatedRoot = validateFilesystemAssetRoot(root);
  await assertNoSymlinkAncestors(validatedRoot);
  const actual = {
    root: await directoryIdentity(validatedRoot, 'asset root'),
    objects: await directoryIdentity(
      filesystemAssetObjectsDirectory(validatedRoot),
      'asset object directory',
    ),
    state: await directoryIdentity(
      filesystemAssetStateDirectory(validatedRoot),
      'asset state directory',
    ),
  };
  if (expected !== undefined) {
    assertSameDirectory(expected.root, actual.root, 'asset root');
    assertSameDirectory(expected.objects, actual.objects, 'asset object directory');
    assertSameDirectory(expected.state, actual.state, 'asset state directory');
  }
  return actual;
}

export async function assertRegularFileOrAbsent(path: string, label: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new FilesystemAssetSecurityError(`${label} must not be a symlink`);
    }
    if (!stats.isFile()) {
      throw new FilesystemAssetSecurityError(`${label} must be a regular file`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function openRegularFileNoFollow(path: string, label: string) {
  await assertRegularFileOrAbsent(path, label);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      throw new FilesystemAssetSecurityError(`${label} must be a regular file`);
    }
    return handle;
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw new FilesystemAssetSecurityError(`${label} must not be a symlink`);
    }
    throw error;
  }
}

export async function syncFilesystemAssetDirectory(root: string): Promise<void> {
  await syncDirectory(filesystemAssetObjectsDirectory(root));
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createOrValidateDirectory(path: string, label: string): Promise<void> {
  try {
    await assertDirectory(path, label);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    await assertDirectory(path, label);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory())
      throw new FilesystemAssetSecurityError(`${label} must be a directory`);
    await handle.chmod(DIRECTORY_MODE);
  } finally {
    await handle.close();
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new FilesystemAssetSecurityError(`${label} must not be a symlink`);
  }
  if (!stats.isDirectory()) {
    throw new FilesystemAssetSecurityError(`${label} must be a directory`);
  }
}

async function directoryIdentity(
  path: string,
  label: string,
): Promise<FilesystemDirectoryIdentity> {
  await assertDirectory(path, label);
  const stats = await lstat(path);
  return {
    path,
    device: stats.dev,
    inode: stats.ino,
    realPath: await realpath(path),
  };
}

function assertSameDirectory(
  expected: FilesystemDirectoryIdentity,
  actual: FilesystemDirectoryIdentity,
  label: string,
): void {
  if (
    expected.path !== actual.path ||
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.realPath !== actual.realPath
  ) {
    throw new FilesystemAssetSecurityError(`${label} identity changed`);
  }
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new FilesystemAssetSecurityError(
          'filesystem asset root ancestor must not be a symlink',
        );
      }
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
}

async function cleanStaleTemps(objects: string): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(objects)) {
    if (!TEMP_FILE_PATTERN.test(entry)) continue;
    const path = join(objects, entry);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new FilesystemAssetSecurityError('asset temporary path must not be a symlink');
    }
    if (!stats.isFile()) {
      throw new FilesystemAssetSecurityError('asset temporary path must be a regular file');
    }
    if (now - stats.mtimeMs >= STALE_TEMP_AGE_MS) await unlink(path);
  }
}

async function cleanStaleStateTemps(state: string): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(state)) {
    if (!STATE_TEMP_FILE_PATTERN.test(entry)) continue;
    const path = join(state, entry);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new FilesystemAssetSecurityError('asset state temporary path must not be a symlink');
    }
    if (!stats.isFile()) {
      throw new FilesystemAssetSecurityError('asset state temporary path must be a regular file');
    }
    if (now - stats.mtimeMs >= STALE_TEMP_AGE_MS) await unlink(path);
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function isSymlinkOpenError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ELOOP' || code === 'EMLINK';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
