import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, readdir, rename } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import {
  type HostedPackagedAsset,
  type PreparedPackagedAsset,
  sniffImageBytes,
} from '@noodle-borg/compiler';
import {
  AssetPlanError,
  type AssetScope,
  type AssetStore,
  type AssetUploadPlan,
} from '@noodle-borg/module';
import { DEFAULT_KEY_SALT, deriveHostedAsset, scopePrefix, sha256Hex } from './asset-key.js';
import {
  type FilesystemAssetLockGuard,
  type FilesystemAssetReservationState,
  readFilesystemAssetReservations,
  sweepFilesystemAssetReservations,
  withFilesystemAssetLock,
  writeFilesystemAssetReservations,
} from './filesystem-coordination.js';
import {
  assertFilesystemAssetLayout,
  assertRegularFileOrAbsent,
  FILESYSTEM_ASSET_PUBLIC_PATH_PREFIX,
  type FilesystemAssetLayoutAnchor,
  FilesystemAssetSecurityError,
  filesystemAssetEtag,
  filesystemAssetObjectsDirectory,
  filesystemAssetPaths,
  isMissing,
  MAX_FILESYSTEM_ASSET_METADATA_BYTES,
  MAX_FILESYSTEM_ASSET_REACHABILITY_RECORDS,
  openRegularFileNoFollow,
  parseStoredFilesystemAssetMetadata,
  prepareFilesystemAssetLayout,
  SAFE_FILESYSTEM_ASSET_OBJECT_KEY,
  type StoredFilesystemAssetMetadata,
  StoredFilesystemAssetMetadataError,
  syncFilesystemAssetDirectory,
  validateFilesystemAssetRoot,
} from './filesystem-layout.js';
import {
  assertStagedIdentity,
  assetIdentityHash,
  fail,
  isPendingReservation,
  MAX_IMAGE_DIMENSION,
  normalizeHttpBase,
  positiveInteger,
  readBounded,
  type StagedUpload,
  safeUnlinkStaged,
  sameAssetIdentity,
  sendError,
  storedAndReservedBytes,
  uniqueReservedBytes,
  uploadHeaders,
  uploadTarget,
  validateHostedIdentity,
  validatePreparedAsset,
  validateQuota,
  withoutObjectReservations,
  withoutReservation,
  writeAll,
} from './filesystem-store-support.js';
import { FilesystemUploadRegistry, type PendingUpload } from './filesystem-upload-registry.js';

const UPLOAD_PATH_PREFIX = '/__noodle/asset-uploads';
const DEFAULT_UPLOAD_EXPIRY_SECONDS = 600;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_DEPLOY_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_PENDING_UPLOADS = 100;

export interface FilesystemAssetQuota {
  readonly scope: string;
  readonly maxStoredBytes: number;
}

export interface FilesystemAssetStoreConfig {
  readonly root: string;
  readonly keySalt?: string;
  readonly uploadExpirySeconds?: number;
  readonly maxFileBytes?: number;
  readonly maxDeployBytes?: number;
  readonly maxPendingUploads?: number;
  readonly quotas?: readonly FilesystemAssetQuota[];
}

class AssetHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AssetHttpError';
  }
}

/** Durable, provider-free implementation of the canonical {@link AssetStore} port. */
export class FilesystemAssetStore implements AssetStore {
  readonly #root: string;
  readonly #salt: string;
  readonly #uploadExpiryMs: number;
  readonly #maxFileBytes: number;
  readonly #maxDeployBytes: number;
  readonly #maxPendingUploads: number;
  readonly #quotas: readonly FilesystemAssetQuota[];
  readonly #uploads: FilesystemUploadRegistry;
  readonly #activeUploads = new Set<string>();
  #ready: Promise<FilesystemAssetLayoutAnchor> | undefined;

  constructor(config: FilesystemAssetStoreConfig) {
    this.#root = validateFilesystemAssetRoot(config.root);
    this.#salt = config.keySalt ?? DEFAULT_KEY_SALT;
    this.#uploadExpiryMs =
      positiveInteger(
        config.uploadExpirySeconds ?? DEFAULT_UPLOAD_EXPIRY_SECONDS,
        'upload expiry',
      ) * 1000;
    this.#maxFileBytes = positiveInteger(
      config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      'per-file byte limit',
    );
    this.#maxDeployBytes = positiveInteger(
      config.maxDeployBytes ?? DEFAULT_MAX_DEPLOY_BYTES,
      'per-deploy byte limit',
    );
    if (this.#maxDeployBytes < this.#maxFileBytes) {
      throw new TypeError('filesystem asset per-deploy limit must be at least the per-file limit');
    }
    this.#maxPendingUploads = positiveInteger(
      config.maxPendingUploads ?? DEFAULT_MAX_PENDING_UPLOADS,
      'pending upload limit',
    );
    this.#uploads = new FilesystemUploadRegistry(this.#maxPendingUploads);
    this.#quotas = (config.quotas ?? []).map(validateQuota);
  }

  async planUploads(input: {
    readonly scope: AssetScope;
    readonly assets: readonly PreparedPackagedAsset[];
    readonly uploadBaseUrl: string;
    readonly publicBaseUrl: string;
    readonly now?: Date;
  }): Promise<AssetUploadPlan> {
    if (input.assets.length > this.#maxPendingUploads) {
      throw new AssetPlanError(
        `a single deploy may upload at most ${this.#maxPendingUploads} assets (got ${input.assets.length})`,
      );
    }
    let deployTotal = 0;
    for (const asset of input.assets) {
      validatePreparedAsset(asset);
      if (asset.byteLength > this.#maxFileBytes) {
        throw new AssetPlanError(
          `asset "${asset.logicalId}" is ${asset.byteLength} bytes; the per-file limit is ${this.#maxFileBytes} bytes`,
        );
      }
      deployTotal += asset.byteLength;
    }
    if (deployTotal > this.#maxDeployBytes) {
      throw new AssetPlanError(
        `deploy assets total ${deployTotal} bytes; the per-deploy limit is ${this.#maxDeployBytes} bytes`,
      );
    }

    const anchor = await this.#ensureLayout();
    const uploadBase = normalizeHttpBase(input.uploadBaseUrl);
    const publicBase = `${normalizeHttpBase(input.publicBaseUrl)}${FILESYSTEM_ASSET_PUBLIC_PATH_PREFIX}`;
    const assets = input.assets.map((asset) =>
      deriveHostedAsset(this.#salt, input.scope, asset, publicBase),
    );
    const now = (input.now ?? new Date()).getTime();
    const uploads = await withFilesystemAssetLock(this.#root, anchor, async (guard) => {
      let state = sweepFilesystemAssetReservations(
        await readFilesystemAssetReservations(this.#root, anchor),
        now,
      );
      this.#uploads.reconcile(state, now);
      const toUpload: HostedPackagedAsset[] = [];
      const committed = new Set<string>();
      for (const asset of assets) {
        const existing = await this.#metadataForPlan(asset.objectKey);
        if (
          existing !== undefined &&
          sameAssetIdentity(existing.asset, asset) &&
          (await this.#verifyStoredBytes(existing)).ok
        ) {
          committed.add(asset.objectKey);
        } else {
          toUpload.push(asset);
        }
      }
      if (committed.size > 0) {
        state = {
          version: 1,
          capabilities: state.capabilities.filter((item) => !committed.has(item.objectKey)),
        };
        for (const objectKey of committed) this.#uploads.deleteObject(objectKey);
      }
      this.#uploads.reconcile(state, now);
      await writeFilesystemAssetReservations(this.#root, anchor, state, guard);

      const newPending: Array<{ readonly token: string; readonly pending: PendingUpload }> = [];
      for (const asset of toUpload) {
        const reusable = this.#uploads.find(asset);
        if (
          (reusable !== undefined &&
            state.capabilities.some((item) => isPendingReservation(item, reusable.pending))) ||
          newPending.some((item) => sameAssetIdentity(item.pending.asset, asset))
        ) {
          continue;
        }
        const expiresAt = now + this.#uploadExpiryMs;
        const reservationId = randomBytes(16).toString('hex');
        const token = randomBytes(18).toString('base64url');
        const headers = uploadHeaders(asset);
        const pending = { asset, reservationId, scope: input.scope, expiresAt, headers };
        newPending.push({ token, pending });
        state.capabilities.push({
          id: reservationId,
          objectKey: asset.objectKey,
          identityHash: assetIdentityHash(asset),
          byteLength: asset.byteLength,
          expiresAt,
        });
      }
      this.#enforcePendingBounds(state);
      await this.#enforceStoredQuotas(input.scope, state);
      await writeFilesystemAssetReservations(this.#root, anchor, state, guard);
      for (const item of newPending) this.#uploads.add(item.token, item.pending);
      return toUpload.map((asset) => {
        const local = this.#uploads.find(asset);
        if (local === undefined)
          throw new FilesystemAssetSecurityError('upload reservation was lost');
        return uploadTarget(uploadBase, UPLOAD_PATH_PREFIX, local.token, local.pending);
      });
    });
    return { assetOrigin: new URL(publicBase).origin, assets, uploads };
  }

  async verifyUploadedAssets(input: {
    readonly scope: AssetScope;
    readonly assets: readonly HostedPackagedAsset[];
  }): Promise<
    | { readonly ok: true; readonly assets: readonly HostedPackagedAsset[] }
    | { readonly ok: false; readonly error: string }
  > {
    await this.#ensureLayout();
    let deployTotal = 0;
    for (const asset of input.assets) {
      try {
        validateHostedIdentity(asset);
      } catch (error) {
        return fail((error as Error).message);
      }
      deployTotal += asset.byteLength;
    }
    if (deployTotal > this.#maxDeployBytes) {
      return fail('deploy assets exceed the per-deploy byte limit');
    }
    const verified: HostedPackagedAsset[] = [];
    for (const claimed of input.assets) {
      try {
        validateHostedIdentity(claimed);
        const canonical = deriveHostedAsset(
          this.#salt,
          input.scope,
          claimed,
          'https://filesystem.invalid',
        );
        const metadata = await this.#loadMetadata(canonical.objectKey);
        if (metadata === undefined) return fail(`asset "${claimed.logicalId}" was not uploaded`);
        if (!sameAssetIdentity(metadata.asset, claimed)) {
          return fail(`asset "${claimed.logicalId}" upload metadata mismatch`);
        }
        const checked = await this.#verifyStoredBytes(metadata);
        if (!checked.ok) return fail(`asset "${claimed.logicalId}" ${checked.error}`);
        verified.push(metadata.asset);
      } catch (error) {
        if (error instanceof StoredFilesystemAssetMetadataError) {
          return fail(`asset "${claimed.logicalId}" stored metadata is invalid`);
        }
        if (error instanceof FilesystemAssetSecurityError) {
          return fail(`asset "${claimed.logicalId}" storage path is invalid`);
        }
        if (error instanceof AssetPlanError) return fail(error.message);
        throw error;
      }
    }
    return { ok: true, assets: verified };
  }

  async recordReachability(input: {
    readonly scope: AssetScope;
    readonly deploymentId: string;
    readonly deploymentVersion: number;
    readonly assets: readonly HostedPackagedAsset[];
  }): Promise<void> {
    const anchor = await this.#ensureLayout();
    const { deploymentId, deploymentVersion } = input;
    if (deploymentId.length === 0 || deploymentId.length > 256) {
      throw new TypeError('deployment ID must contain 1 to 256 characters');
    }
    if (!Number.isSafeInteger(deploymentVersion) || deploymentVersion < 0) {
      throw new TypeError('deployment version must be a non-negative safe integer');
    }
    for (const claimed of input.assets) {
      validateHostedIdentity(claimed);
      const canonical = deriveHostedAsset(
        this.#salt,
        input.scope,
        claimed,
        'https://filesystem.invalid',
      );
      await withFilesystemAssetLock(this.#root, anchor, async (guard) => {
        const metadata = await this.#loadMetadata(canonical.objectKey);
        if (metadata === undefined || !sameAssetIdentity(metadata.asset, claimed)) return;
        const next = { deploymentId, deploymentVersion };
        const alreadyRecorded = metadata.reachableBy.some(
          (item) =>
            item.deploymentId === next.deploymentId &&
            item.deploymentVersion === next.deploymentVersion,
        );
        if (alreadyRecorded || metadata.retainIndefinitely) return;
        if (metadata.reachableBy.length === MAX_FILESYSTEM_ASSET_REACHABILITY_RECORDS) {
          await this.#writeMetadata({ ...metadata, retainIndefinitely: true }, guard);
          return;
        }
        await this.#writeMetadata(
          { ...metadata, reachableBy: [...metadata.reachableBy, next] },
          guard,
        );
      });
    }
  }

  handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (pathname === UPLOAD_PATH_PREFIX || pathname.startsWith(`${UPLOAD_PATH_PREFIX}/`)) {
      if (req.method !== 'PUT') {
        sendError(res, 405, 'method not allowed', { allow: 'PUT' });
        return true;
      }
      const token = pathname.slice(UPLOAD_PATH_PREFIX.length + 1);
      if (!/^[A-Za-z0-9_-]{24}$/.test(token)) {
        sendError(res, 404, 'not found');
        return true;
      }
      void this.#handleUpload(token, req, res);
      return true;
    }
    if (
      pathname === FILESYSTEM_ASSET_PUBLIC_PATH_PREFIX ||
      pathname.startsWith(`${FILESYSTEM_ASSET_PUBLIC_PATH_PREFIX}/`)
    ) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return true;
      }
      if (req.headers.range !== undefined) {
        sendError(res, 416, 'range requests are not supported');
        return true;
      }
      const objectKey = pathname.slice(FILESYSTEM_ASSET_PUBLIC_PATH_PREFIX.length + 1);
      if (!SAFE_FILESYSTEM_ASSET_OBJECT_KEY.test(objectKey)) {
        sendError(res, 400, 'invalid asset path');
        return true;
      }
      void this.#handleServe(objectKey, req, res);
      return true;
    }
    return false;
  }

  async #handleUpload(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pending = this.#uploads.get(token);
    if (pending === undefined) return sendError(res, 404, 'not found');
    try {
      await this.#reconcileLocalUploads(Date.now());
    } catch {
      return sendError(res, 500, 'asset upload failed');
    }
    if (pending.expiresAt <= Date.now()) {
      this.#uploads.deleteToken(token);
      try {
        await this.#revokeCapability(pending);
        return sendError(res, 410, 'upload target expired');
      } catch {
        return sendError(res, 500, 'asset upload failed');
      }
    }
    if (this.#uploads.get(token) === undefined) return sendError(res, 404, 'not found');
    if (this.#activeUploads.has(token)) return sendError(res, 409, 'upload already in progress');
    for (const [name, expected] of Object.entries(pending.headers)) {
      if (String(req.headers[name] ?? '') !== expected) {
        this.#uploads.deleteToken(token);
        try {
          await this.#revokeCapability(pending);
          return sendError(res, 400, `upload header ${name} mismatch`);
        } catch {
          return sendError(res, 500, 'asset upload failed');
        }
      }
    }
    this.#activeUploads.add(token);
    let staged: StagedUpload | undefined;
    try {
      if (!(await this.#reservationExists(pending))) {
        this.#uploads.deleteToken(token);
        return sendError(res, 404, 'not found');
      }
      staged = await this.#stageUploadedObject(pending, req);
      await this.#commitStagedUpload(pending, staged);
      this.#uploads.deleteObject(pending.asset.objectKey);
      res.writeHead(201, { etag: filesystemAssetEtag(pending.asset.contentHash) });
      res.end();
    } catch (error) {
      this.#uploads.deleteToken(token);
      await this.#revokeCapability(pending).catch(() => undefined);
      if (error instanceof AssetHttpError) sendError(res, error.status, error.message);
      else sendError(res, 500, 'asset upload failed');
    } finally {
      this.#activeUploads.delete(token);
      if (staged !== undefined) await safeUnlinkStaged(staged);
    }
  }

  async #stageUploadedObject(pending: PendingUpload, req: IncomingMessage): Promise<StagedUpload> {
    const anchor = await this.#ensureLayout();
    const paths = filesystemAssetPaths(this.#root, pending.asset.objectKey);
    await assertRegularFileOrAbsent(paths.bytes, 'asset object path');
    await assertRegularFileOrAbsent(paths.metadata, 'asset metadata path');
    const temp = await this.#createTemp(paths.bytes, 'bin');
    const digest = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength;
        if (size > pending.asset.byteLength || size > this.#maxFileBytes) {
          throw new AssetHttpError(413, 'asset upload too large');
        }
        digest.update(bytes);
        await writeAll(temp.handle, bytes);
      }
      if (
        size !== pending.asset.byteLength ||
        digest.digest('hex') !== sha256Hex(pending.asset.contentHash)
      ) {
        throw new AssetHttpError(400, 'asset upload checksum mismatch');
      }
      await temp.handle.sync();
      await temp.handle.close();
      temp.closed = true;
      await assertFilesystemAssetLayout(this.#root, anchor);
      return { path: temp.path, device: temp.device, inode: temp.inode };
    } finally {
      if (!temp.closed) await temp.handle.close().catch(() => undefined);
      if (!temp.closed) await safeUnlinkStaged(temp);
    }
  }

  async #commitStagedUpload(pending: PendingUpload, staged: StagedUpload): Promise<void> {
    const anchor = await this.#ensureLayout();
    await withFilesystemAssetLock(this.#root, anchor, async (guard) => {
      let state = sweepFilesystemAssetReservations(
        await readFilesystemAssetReservations(this.#root, anchor),
        Date.now(),
      );
      const existing = await this.#metadataForPlan(pending.asset.objectKey);
      if (
        existing !== undefined &&
        sameAssetIdentity(existing.asset, pending.asset) &&
        (await this.#verifyStoredBytes(existing)).ok
      ) {
        state = withoutObjectReservations(state, pending.asset.objectKey);
        await writeFilesystemAssetReservations(this.#root, anchor, state, guard);
        return;
      }
      if (!state.capabilities.some((item) => isPendingReservation(item, pending))) {
        await writeFilesystemAssetReservations(this.#root, anchor, state, guard);
        throw new AssetHttpError(404, 'not found');
      }
      try {
        this.#enforcePendingBounds(state);
        await this.#enforceStoredQuotas(pending.scope, state);
      } catch (error) {
        state = withoutReservation(state, pending.reservationId);
        await writeFilesystemAssetReservations(this.#root, anchor, state, guard);
        throw new AssetHttpError(409, (error as Error).message);
      }
      const paths = filesystemAssetPaths(this.#root, pending.asset.objectKey);
      await assertFilesystemAssetLayout(this.#root, anchor);
      await assertStagedIdentity(staged);
      await assertRegularFileOrAbsent(paths.bytes, 'asset object path');
      await guard.assertOwned();
      await rename(staged.path, paths.bytes);
      await assertFilesystemAssetLayout(this.#root, anchor);
      await syncFilesystemAssetDirectory(this.#root);
      await this.#writeMetadata(
        {
          version: 1,
          objectKey: pending.asset.objectKey,
          asset: pending.asset,
          etag: filesystemAssetEtag(pending.asset.contentHash),
          reachableBy: [],
          retainIndefinitely: false,
        },
        guard,
      );
      state = withoutObjectReservations(state, pending.asset.objectKey);
      await writeFilesystemAssetReservations(this.#root, anchor, state, guard);
    });
  }

  async #handleServe(objectKey: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.#ensureLayout();
      const metadata = await this.#loadMetadata(objectKey);
      if (metadata === undefined) return sendError(res, 404, 'not found');
      const checked = await this.#verifyStoredBytes(metadata);
      if (!checked.ok) return sendError(res, 404, 'not found');
      res.statusCode = 200;
      res.setHeader('Content-Type', metadata.asset.mimeType);
      res.setHeader('Content-Length', String(metadata.asset.byteLength));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('ETag', metadata.etag);
      res.end(req.method === 'HEAD' ? undefined : checked.bytes);
    } catch {
      sendError(res, 404, 'not found');
    }
  }

  async #metadataForPlan(objectKey: string): Promise<StoredFilesystemAssetMetadata | undefined> {
    try {
      return await this.#loadMetadata(objectKey);
    } catch (error) {
      if (error instanceof StoredFilesystemAssetMetadataError) return undefined;
      throw error;
    }
  }

  async #loadMetadata(objectKey: string): Promise<StoredFilesystemAssetMetadata | undefined> {
    const anchor = await this.#ensureLayout();
    const path = filesystemAssetPaths(this.#root, objectKey).metadata;
    let handle: FileHandle;
    try {
      handle = await openRegularFileNoFollow(path, 'asset metadata path');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (stats.size <= 0 || stats.size > MAX_FILESYSTEM_ASSET_METADATA_BYTES)
        throw new StoredFilesystemAssetMetadataError();
      const raw = (await readBounded(handle, MAX_FILESYSTEM_ASSET_METADATA_BYTES)).toString('utf8');
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new StoredFilesystemAssetMetadataError();
      }
      const metadata = parseStoredFilesystemAssetMetadata(value, objectKey, this.#maxFileBytes);
      await assertFilesystemAssetLayout(this.#root, anchor);
      return metadata;
    } finally {
      await handle.close();
    }
  }

  async #verifyStoredBytes(
    metadata: StoredFilesystemAssetMetadata,
  ): Promise<
    { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly error: string }
  > {
    const anchor = await this.#ensureLayout();
    const path = filesystemAssetPaths(this.#root, metadata.objectKey).bytes;
    let handle: FileHandle;
    try {
      handle = await openRegularFileNoFollow(path, 'asset object path');
    } catch (error) {
      if (isMissing(error)) return { ok: false, error: 'bytes are missing' };
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (stats.size !== metadata.asset.byteLength)
        return { ok: false, error: 'upload size mismatch' };
      if (stats.size > this.#maxFileBytes)
        return { ok: false, error: 'exceeds the per-file byte limit' };
      const bytes = await readBounded(handle, metadata.asset.byteLength);
      if (bytes.byteLength !== metadata.asset.byteLength) {
        return { ok: false, error: 'upload size mismatch' };
      }
      if (
        createHash('sha256').update(bytes).digest('hex') !== sha256Hex(metadata.asset.contentHash)
      ) {
        return { ok: false, error: 'content hash mismatch (checksum verification failed)' };
      }
      const sniffed = sniffImageBytes(bytes);
      if (sniffed === undefined) return { ok: false, error: 'is not a supported image' };
      if (sniffed.mimeType !== metadata.asset.mimeType) {
        return { ok: false, error: 'content type mismatch' };
      }
      if (sniffed.width > MAX_IMAGE_DIMENSION || sniffed.height > MAX_IMAGE_DIMENSION) {
        return { ok: false, error: 'dimensions exceed the limit' };
      }
      if (sniffed.width !== metadata.asset.width || sniffed.height !== metadata.asset.height) {
        return { ok: false, error: 'dimensions do not match the declared metadata' };
      }
      await assertFilesystemAssetLayout(this.#root, anchor);
      return { ok: true, bytes };
    } finally {
      await handle.close();
    }
  }

  async #writeMetadata(
    metadata: StoredFilesystemAssetMetadata,
    guard: FilesystemAssetLockGuard,
  ): Promise<void> {
    parseStoredFilesystemAssetMetadata(metadata, metadata.objectKey, this.#maxFileBytes);
    const serialized = `${JSON.stringify(metadata)}\n`;
    if (Buffer.byteLength(serialized) > MAX_FILESYSTEM_ASSET_METADATA_BYTES) {
      throw new StoredFilesystemAssetMetadataError();
    }
    const anchor = await this.#ensureLayout();
    const path = filesystemAssetPaths(this.#root, metadata.objectKey).metadata;
    await assertRegularFileOrAbsent(path, 'asset metadata path');
    const temp = await this.#createTemp(path, 'json');
    try {
      await temp.handle.writeFile(serialized, 'utf8');
      await temp.handle.sync();
      await temp.handle.close();
      temp.closed = true;
      await assertFilesystemAssetLayout(this.#root, anchor);
      await assertRegularFileOrAbsent(path, 'asset metadata path');
      await guard.assertOwned();
      await rename(temp.path, path);
      await assertFilesystemAssetLayout(this.#root, anchor);
      await syncFilesystemAssetDirectory(this.#root);
    } finally {
      if (!temp.closed) await temp.handle.close().catch(() => undefined);
      await safeUnlinkStaged(temp);
    }
  }

  async #createTemp(destination: string, kind: 'bin' | 'json') {
    const anchor = await this.#ensureLayout();
    const objects = filesystemAssetObjectsDirectory(this.#root);
    const physicalId = basename(destination, kind === 'bin' ? '.bin' : '.json');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const path = join(objects, `.${physicalId}.${kind}.tmp-${randomBytes(16).toString('hex')}`);
      try {
        const handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.chmod(0o600);
        const stats = await handle.stat();
        await assertFilesystemAssetLayout(this.#root, anchor);
        return { path, handle, closed: false, device: stats.dev, inode: stats.ino };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new FilesystemAssetSecurityError('could not create a unique asset temporary file');
  }

  async #enforceStoredQuotas(
    scope: AssetScope,
    state: FilesystemAssetReservationState,
  ): Promise<void> {
    if (this.#quotas.length === 0) return;
    const deploySegments = [scope.org, scope.app, scope.env];
    const metadata = await this.#allMetadata();
    for (const quota of this.#quotas) {
      const quotaSegments = quota.scope.split('/');
      if (!quotaSegments.every((segment, index) => segment === deploySegments[index])) continue;
      const prefix = scopePrefix(this.#salt, {
        org: quotaSegments[0] as string,
        app: quotaSegments[1] ?? '',
        env: quotaSegments[2] ?? '',
      })
        .split('/')
        .slice(0, quotaSegments.length)
        .join('/');
      const total = storedAndReservedBytes(metadata, state, prefix);
      if (total > BigInt(quota.maxStoredBytes)) {
        throw new AssetPlanError(
          `asset storage quota for "${quota.scope}" exceeded: ${total.toString()} bytes would exceed the ${quota.maxStoredBytes}-byte cap`,
        );
      }
    }
  }

  #enforcePendingBounds(state: FilesystemAssetReservationState): void {
    if (state.capabilities.length > this.#maxPendingUploads) {
      throw new AssetPlanError(
        `filesystem asset store has too many outstanding upload capabilities (limit ${this.#maxPendingUploads})`,
      );
    }
    const bytes = uniqueReservedBytes(state);
    const cap = BigInt(this.#maxPendingUploads) * BigInt(this.#maxFileBytes);
    if (bytes > cap) {
      throw new AssetPlanError(
        `filesystem asset store outstanding reserved bytes exceed its ${cap.toString()}-byte cap`,
      );
    }
  }

  async #allMetadata(): Promise<readonly StoredFilesystemAssetMetadata[]> {
    const anchor = await this.#ensureLayout();
    const values: StoredFilesystemAssetMetadata[] = [];
    for (const entry of await readdir(filesystemAssetObjectsDirectory(this.#root))) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
      const path = join(filesystemAssetObjectsDirectory(this.#root), entry);
      const handle = await openRegularFileNoFollow(path, 'asset metadata path');
      let raw: string;
      try {
        const stats = await handle.stat();
        if (stats.size <= 0 || stats.size > MAX_FILESYSTEM_ASSET_METADATA_BYTES)
          throw new StoredFilesystemAssetMetadataError();
        raw = (await readBounded(handle, MAX_FILESYSTEM_ASSET_METADATA_BYTES)).toString('utf8');
      } finally {
        await handle.close();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new StoredFilesystemAssetMetadataError();
      }
      const metadata = parseStoredFilesystemAssetMetadata(parsed, undefined, this.#maxFileBytes);
      const expectedPath = filesystemAssetPaths(this.#root, metadata.objectKey).metadata;
      if (expectedPath !== path) throw new StoredFilesystemAssetMetadataError();
      values.push(metadata);
    }
    await assertFilesystemAssetLayout(this.#root, anchor);
    return values;
  }

  async #reconcileLocalUploads(now: number): Promise<void> {
    const anchor = await this.#ensureLayout();
    await withFilesystemAssetLock(this.#root, anchor, async (guard) => {
      const state = sweepFilesystemAssetReservations(
        await readFilesystemAssetReservations(this.#root, anchor),
        now,
      );
      this.#uploads.reconcile(state, now);
      await writeFilesystemAssetReservations(this.#root, anchor, state, guard);
    });
  }

  async #reservationExists(pending: PendingUpload): Promise<boolean> {
    const anchor = await this.#ensureLayout();
    return withFilesystemAssetLock(this.#root, anchor, async (guard) => {
      const state = sweepFilesystemAssetReservations(
        await readFilesystemAssetReservations(this.#root, anchor),
        Date.now(),
      );
      await writeFilesystemAssetReservations(this.#root, anchor, state, guard);
      return state.capabilities.some((item) => isPendingReservation(item, pending));
    });
  }

  async #revokeCapability(pending: PendingUpload): Promise<void> {
    const anchor = await this.#ensureLayout();
    await withFilesystemAssetLock(this.#root, anchor, async (guard) => {
      const state = sweepFilesystemAssetReservations(
        await readFilesystemAssetReservations(this.#root, anchor),
        Date.now(),
      );
      await writeFilesystemAssetReservations(
        this.#root,
        anchor,
        withoutReservation(state, pending.reservationId),
        guard,
      );
    });
  }

  async #ensureLayout(): Promise<FilesystemAssetLayoutAnchor> {
    this.#ready ??= prepareFilesystemAssetLayout(this.#root);
    const anchor = await this.#ready;
    await assertFilesystemAssetLayout(this.#root, anchor);
    return anchor;
  }
}
