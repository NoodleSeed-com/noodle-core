import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  HostedPackagedAsset,
  PackagedAsset,
  PreparedPackagedAsset,
} from '@noodle-borg/compiler';
import type {
  AssetScope,
  AssetStore,
  AssetUploadPlan,
  AssetUploadTarget,
} from '@noodle-borg/module';
import { sendJson } from '@noodle-borg/transport-http';

export {
  AssetPlanError,
  type AssetScope,
  type AssetStore,
  type AssetUploadPlan,
  type AssetUploadTarget,
} from '@noodle-borg/module';

interface StoredObject {
  readonly asset: HostedPackagedAsset;
  readonly bytes: Buffer;
  readonly etag: string;
  readonly reachableBy: Array<{ deploymentId: string; deploymentVersion: number }>;
}

interface PendingUpload {
  readonly scopeKey: string;
  readonly asset: HostedPackagedAsset;
  readonly expiresAt: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** Construction options for the deterministic in-memory fake (local dev / self-hosted / tests). */
export interface InMemoryAssetStoreOptions {
  /** Signed-upload validity window in seconds. Default 600 (10 minutes). */
  readonly uploadExpirySeconds?: number;
}

export class InMemoryAssetStore implements AssetStore {
  readonly #objects = new Map<string, StoredObject>();
  readonly #uploads = new Map<string, PendingUpload>();
  readonly #uploadExpiryMs: number;

  constructor(options: InMemoryAssetStoreOptions = {}) {
    this.#uploadExpiryMs = (options.uploadExpirySeconds ?? 600) * 1000;
  }

  async planUploads(input: {
    readonly scope: AssetScope;
    readonly assets: readonly PreparedPackagedAsset[];
    readonly uploadBaseUrl: string;
    readonly publicBaseUrl: string;
    readonly now?: Date;
  }): Promise<AssetUploadPlan> {
    const scopeKey = assetScopeKey(input.scope);
    const publicBase = input.publicBaseUrl.replace(/\/+$/, '');
    const uploadBase = input.uploadBaseUrl.replace(/\/+$/, '');
    const expiresAt = new Date((input.now ?? new Date()).getTime() + this.#uploadExpiryMs);
    const assets = input.assets.map((asset) => hostedAssetFor(input.scope, asset, publicBase));
    const uploads: AssetUploadTarget[] = [];
    for (const asset of assets) {
      const existing = this.#objects.get(asset.objectKey);
      if (existing?.asset.contentHash === asset.contentHash) continue;
      const token = randomBytes(18).toString('base64url');
      const headers = {
        'content-type': asset.mimeType,
        'x-noodle-content-length': String(asset.byteLength),
        'x-noodle-content-sha256': asset.contentHash.slice('sha256:'.length),
      };
      this.#uploads.set(token, {
        scopeKey,
        asset,
        expiresAt: expiresAt.getTime(),
        headers,
      });
      uploads.push({
        logicalId: asset.logicalId,
        objectKey: asset.objectKey,
        uploadUrl: `${uploadBase}/__noodle/asset-uploads/${token}`,
        method: 'PUT',
        headers,
        expiresAt: expiresAt.toISOString(),
      });
    }
    return { assetOrigin: new URL(publicBase).origin, assets, uploads };
  }

  verifyUploadedAssets(input: {
    readonly scope: AssetScope;
    readonly assets: readonly HostedPackagedAsset[];
  }): Promise<
    | { readonly ok: true; readonly assets: readonly HostedPackagedAsset[] }
    | { readonly ok: false; readonly error: string }
  > {
    const scopeKey = assetScopeKey(input.scope);
    for (const asset of input.assets) {
      if (!asset.objectKey.startsWith(`${scopeKey}/`)) {
        return Promise.resolve({
          ok: false,
          error: `asset "${asset.logicalId}" is outside the target scope`,
        });
      }
      const stored = this.#objects.get(asset.objectKey);
      if (stored === undefined) {
        return Promise.resolve({ ok: false, error: `asset "${asset.logicalId}" was not uploaded` });
      }
      if (
        stored.asset.contentHash !== asset.contentHash ||
        stored.asset.mimeType !== asset.mimeType ||
        stored.asset.byteLength !== asset.byteLength
      ) {
        return Promise.resolve({
          ok: false,
          error: `asset "${asset.logicalId}" upload metadata mismatch`,
        });
      }
    }
    return Promise.resolve({ ok: true, assets: input.assets });
  }

  recordReachability(input: {
    readonly scope: AssetScope;
    readonly deploymentId: string;
    readonly deploymentVersion: number;
    readonly assets: readonly HostedPackagedAsset[];
  }): Promise<void> {
    for (const asset of input.assets) {
      const stored = this.#objects.get(asset.objectKey);
      if (stored === undefined) continue;
      stored.reachableBy.push({
        deploymentId: input.deploymentId,
        deploymentVersion: input.deploymentVersion,
      });
    }
    return Promise.resolve();
  }

  handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    const upload = /^\/__noodle\/asset-uploads\/([^/]+)$/.exec(pathname);
    if (upload !== null && req.method === 'PUT') {
      void this.#handleUpload(upload[1] as string, req, res);
      return true;
    }
    const served = /^\/__noodle\/hosted-assets\/([^/]+)$/.exec(pathname);
    if (served !== null && (req.method === 'GET' || req.method === 'HEAD')) {
      this.#handleServe(served[1] as string, req, res);
      return true;
    }
    return false;
  }

  async #handleUpload(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pending = this.#uploads.get(token);
    if (pending === undefined) return sendJson(res, 404, { error: 'not found' });
    if (pending.expiresAt <= Date.now()) {
      this.#uploads.delete(token);
      return sendJson(res, 410, { error: 'upload target expired' });
    }
    for (const [name, expected] of Object.entries(pending.headers)) {
      const actual = req.headers[name];
      if (String(actual ?? '') !== expected) {
        return sendJson(res, 400, { error: `upload header ${name} mismatch` });
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > pending.asset.byteLength)
        return sendJson(res, 413, { error: 'asset upload too large' });
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (
      bytes.byteLength !== pending.asset.byteLength ||
      contentHash !== pending.asset.contentHash
    ) {
      return sendJson(res, 400, { error: 'asset upload checksum mismatch' });
    }
    const etag = `"${pending.asset.contentHash.slice('sha256:'.length)}"`;
    this.#objects.set(pending.asset.objectKey, {
      asset: pending.asset,
      bytes,
      etag,
      reachableBy: [],
    });
    this.#uploads.delete(token);
    res.writeHead(201, { etag });
    res.end();
  }

  #handleServe(opaqueId: string, req: IncomingMessage, res: ServerResponse): void {
    const stored = [...this.#objects.values()].find((object) =>
      object.asset.publicUrl.endsWith(`/__noodle/hosted-assets/${opaqueId}`),
    );
    if (stored === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', stored.asset.mimeType);
    res.setHeader('Content-Length', String(stored.asset.byteLength));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', stored.etag);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(stored.bytes);
  }
}

/** Serve one compiler-owned local asset without growing the main service route dispatcher. */
export function serveLocalAsset(
  req: IncomingMessage,
  res: ServerResponse,
  asset: PackagedAsset,
): void {
  if (req.method === 'HEAD') {
    writeLocalAssetHeaders(res, asset, asset.byteLength);
    res.end();
    return;
  }
  void readFile(asset.absolutePath)
    .then((bytes) => {
      writeLocalAssetHeaders(res, asset, bytes.byteLength);
      res.end(bytes);
    })
    .catch(() => sendJson(res, 404, { error: 'not found' }));
}

function writeLocalAssetHeaders(
  res: ServerResponse,
  asset: PackagedAsset,
  byteLength: number,
): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Content-Length', String(byteLength));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
}

function hostedAssetFor(
  scope: AssetScope,
  asset: PreparedPackagedAsset,
  publicBase: string,
): HostedPackagedAsset {
  const scopeKey = assetScopeKey(scope);
  const hash = asset.contentHash.slice('sha256:'.length);
  const objectKey = `${scopeKey}/${hash}/${asset.logicalId}`;
  const opaque = createHash('sha256')
    .update(`${objectKey}:${hash}`)
    .digest('base64url')
    .slice(0, 32);
  return {
    logicalId: asset.logicalId,
    sourcePath: asset.sourcePath,
    contentHash: asset.contentHash,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    width: asset.width,
    height: asset.height,
    objectKey,
    publicUrl: `${publicBase}/__noodle/hosted-assets/${opaque}`,
  };
}

function assetScopeKey(scope: AssetScope): string {
  return `${scope.org}/${scope.app}/${scope.env}`;
}
