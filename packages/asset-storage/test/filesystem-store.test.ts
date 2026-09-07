import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import type { HostedPackagedAsset, PreparedPackagedAsset } from '@noodle-borg/compiler';
import { AssetPlanError } from '@noodle-borg/module';
import { describe, expect, it } from 'vitest';
import { filesystemAssetPaths } from '../src/filesystem-layout.js';
import { FilesystemAssetStore, type FilesystemAssetStoreConfig } from '../src/filesystem-store.js';

const SCOPE = { org: 'acme-private', app: 'site-private', env: 'prod-private' } as const;
const OTHER_SCOPE = { org: 'globex-private', app: 'site-private', env: 'prod-private' } as const;
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function prepared(
  logicalId = 'logo',
  bytes = PNG_1X1,
  overrides: Partial<PreparedPackagedAsset> = {},
): PreparedPackagedAsset {
  return {
    logicalId,
    sourcePath: 'assets/logo.png',
    absolutePath: '/not-used/assets/logo.png',
    contentHash: `sha256:${hash(bytes)}`,
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    width: 1,
    height: 1,
    ...overrides,
  };
}

async function root(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'noodle-fs-assets-')));
}

function store(storageRoot: string, overrides: Partial<FilesystemAssetStoreConfig> = {}) {
  return new FilesystemAssetStore({
    root: storageRoot,
    keySalt: 'filesystem-test-salt',
    uploadExpirySeconds: 60,
    maxFileBytes: 1024,
    maxDeployBytes: 2048,
    maxPendingUploads: 4,
    quotas: [],
    ...overrides,
  });
}

async function plan(
  assetStore: FilesystemAssetStore,
  assets: readonly PreparedPackagedAsset[] = [prepared()],
  scope = SCOPE,
  now?: Date,
) {
  return assetStore.planUploads({
    scope,
    assets,
    uploadBaseUrl: 'https://self-host.example.test',
    publicBaseUrl: 'https://self-host.example.test',
    ...(now === undefined ? {} : { now }),
  });
}

async function request(
  assetStore: FilesystemAssetStore,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  chunks: Iterable<Buffer> | AsyncIterable<Buffer> = [],
): Promise<{ handled: boolean; response: CapturedResponse }> {
  const req = Object.assign(Readable.from(chunks), { method, headers }) as IncomingMessage;
  let status = 200;
  const responseHeaders: Record<string, string> = {};
  let resolveResponse!: (value: CapturedResponse) => void;
  const completed = new Promise<CapturedResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const res = {
    set statusCode(value: number) {
      status = value;
    },
    get statusCode() {
      return status;
    },
    setHeader(name: string, value: string | number) {
      responseHeaders[name.toLowerCase()] = String(value);
    },
    writeHead(code: number, values?: Record<string, string | number>) {
      status = code;
      for (const [name, value] of Object.entries(values ?? {})) {
        responseHeaders[name.toLowerCase()] = String(value);
      }
      return this;
    },
    end(body?: Buffer | string) {
      resolveResponse({
        status,
        headers: responseHeaders,
        body: body === undefined ? Buffer.alloc(0) : Buffer.from(body),
      });
    },
  } as unknown as ServerResponse;
  const handled = assetStore.handleRequest(req, res, pathname);
  if (!handled) resolveResponse({ status, headers: responseHeaders, body: Buffer.alloc(0) });
  return { handled, response: await completed };
}

async function upload(
  assetStore: FilesystemAssetStore,
  target: { readonly uploadUrl: string; readonly headers: Readonly<Record<string, string>> },
  bytes: Buffer,
  headers: Record<string, string> = { ...target.headers },
): Promise<CapturedResponse> {
  const result = await request(assetStore, 'PUT', new URL(target.uploadUrl).pathname, headers, [
    bytes,
  ]);
  expect(result.handled).toBe(true);
  return result.response;
}

async function land(assetStore: FilesystemAssetStore, asset = prepared()) {
  const uploadPlan = await plan(assetStore, [asset]);
  const target = uploadPlan.uploads[0];
  expect(target).toBeDefined();
  if (target === undefined) throw new Error('expected upload target');
  expect((await upload(assetStore, target, PNG_1X1)).status).toBe(201);
  return uploadPlan.assets[0] as HostedPackagedAsset;
}

describe('FilesystemAssetStore planning', () => {
  it('derives deterministic blinded identities while keeping tenant scopes distinct', async () => {
    const assetStore = store(await root());
    const first = await plan(assetStore);
    const repeated = await plan(assetStore);
    const other = await plan(assetStore, [prepared()], OTHER_SCOPE);

    expect(repeated.assets[0]).toEqual(first.assets[0]);
    expect(repeated.uploads[0]?.uploadUrl).toBe(first.uploads[0]?.uploadUrl);
    expect(other.assets[0]?.objectKey).not.toBe(first.assets[0]?.objectKey);
    expect(JSON.stringify([first.assets, other.assets])).not.toMatch(
      /acme-private|globex-private|site-private|prod-private/,
    );
  });

  it('deduplicates a committed object on the next plan and after restart', async () => {
    const storageRoot = await root();
    const firstStore = store(storageRoot);
    await land(firstStore);

    expect((await plan(firstStore)).uploads).toHaveLength(0);
    expect((await plan(store(storageRoot))).uploads).toHaveLength(0);
  });

  it('rejects pending-count, per-file, and per-deploy limits before returning targets', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot, {
      maxPendingUploads: 1,
      maxFileBytes: PNG_1X1.byteLength,
      maxDeployBytes: PNG_1X1.byteLength,
    });
    await expect(plan(assetStore, [prepared('a'), prepared('b')])).rejects.toBeInstanceOf(
      AssetPlanError,
    );
    await expect(
      plan(assetStore, [prepared('large', PNG_1X1, { byteLength: PNG_1X1.byteLength + 1 })]),
    ).rejects.toThrow(/per-file/i);
    await expect(
      plan(
        store(storageRoot, {
          maxPendingUploads: 2,
          maxFileBytes: PNG_1X1.byteLength,
          maxDeployBytes: PNG_1X1.byteLength,
        }),
        [prepared('a'), prepared('b')],
      ),
    ).rejects.toThrow(/per-deploy/i);
  });

  it('rejects a stored-byte quota before issuing any usable upload capability', async () => {
    const storageRoot = await root();
    const firstStore = store(storageRoot);
    await land(firstStore);

    const quotaStore = store(storageRoot, {
      quotas: [{ scope: SCOPE.org, maxStoredBytes: PNG_1X1.byteLength }],
    });
    const secondBytes = Buffer.from(PNG_1X1);
    secondBytes[secondBytes.length - 1] = (secondBytes[secondBytes.length - 1] ?? 0) ^ 1;
    await expect(plan(quotaStore, [prepared('other', secondBytes)])).rejects.toThrow(/quota/i);
  });

  it.each([
    '../escape',
    'nested/id',
    String.raw`nested\id`,
    '%2e%2e',
  ])('rejects unsafe logical ID %s before deriving filesystem or URL paths', async (logicalId) => {
    await expect(plan(store(await root()), [prepared(logicalId)])).rejects.toBeInstanceOf(
      AssetPlanError,
    );
  });
});

describe('FilesystemAssetStore upload and verification', () => {
  it('expires upload capabilities and binds every required header', async () => {
    const assetStore = store(await root(), { uploadExpirySeconds: 1 });
    const uploadPlan = await plan(assetStore, [prepared()], SCOPE, new Date(0));
    const target = uploadPlan.uploads[0];
    expect(target).toBeDefined();
    if (target === undefined) return;

    expect((await upload(assetStore, target, PNG_1X1)).status).toBe(410);

    const fresh = (await plan(assetStore)).uploads[0];
    expect(fresh).toBeDefined();
    if (fresh === undefined) return;
    const wrong = { ...fresh.headers, 'content-type': 'image/jpeg' };
    expect((await upload(assetStore, fresh, PNG_1X1, wrong)).status).toBe(400);
  });

  it('rejects an upload overrun while streaming and leaves no committed object', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const uploadPlan = await plan(assetStore);
    const target = uploadPlan.uploads[0];
    const hosted = uploadPlan.assets[0];
    expect(target).toBeDefined();
    expect(hosted).toBeDefined();
    if (target === undefined || hosted === undefined) return;

    const response = await upload(assetStore, target, Buffer.concat([PNG_1X1, Buffer.from('x')]));
    expect(response.status).toBe(413);
    const paths = filesystemAssetPaths(storageRoot, hosted.objectKey);
    await expect(lstat(paths.metadata)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a same-length checksum mismatch without committing metadata', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const uploadPlan = await plan(assetStore);
    const target = uploadPlan.uploads[0];
    const hosted = uploadPlan.assets[0];
    if (target === undefined || hosted === undefined) return;
    const tampered = Buffer.from(PNG_1X1);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;

    expect((await upload(assetStore, target, tampered)).status).toBe(400);
    await expect(
      lstat(filesystemAssetPaths(storageRoot, hosted.objectKey).metadata),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-hashes and re-sniffs committed bytes before activation', async () => {
    const assetStore = store(await root());
    const unsupported = Buffer.alloc(PNG_1X1.byteLength, 0x61);
    const unsupportedPlan = await plan(assetStore, [prepared('plain', unsupported)]);
    const target = unsupportedPlan.uploads[0];
    if (target === undefined) return;
    expect((await upload(assetStore, target, unsupported)).status).toBe(201);
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: unsupportedPlan.assets }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/supported image/i) });

    const wrongMime = await plan(assetStore, [
      prepared('mime', PNG_1X1, { mimeType: 'image/jpeg' }),
    ]);
    const mimeTarget = wrongMime.uploads[0];
    if (mimeTarget === undefined) return;
    expect((await upload(assetStore, mimeTarget, PNG_1X1)).status).toBe(201);
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: wrongMime.assets }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/content type/i) });

    const wrongDims = await plan(assetStore, [prepared('dims', PNG_1X1, { width: 2 })]);
    const dimsTarget = wrongDims.uploads[0];
    if (dimsTarget === undefined) return;
    expect((await upload(assetStore, dimsTarget, PNG_1X1)).status).toBe(201);
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: wrongDims.assets }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/dimensions/i) });
  });

  it('ignores client-supplied object keys and URLs during activation verification', async () => {
    const assetStore = store(await root());
    const hosted = await land(assetStore);
    const result = await assetStore.verifyUploadedAssets({
      scope: SCOPE,
      assets: [{ ...hosted, objectKey: '../attacker', publicUrl: 'https://attacker.example/file' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assets).toEqual([hosted]);
  });

  it('atomically accepts concurrent identical uploads and retains one valid object', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const siblingStore = store(storageRoot);
    const first = await plan(assetStore);
    const second = await plan(siblingStore);
    const firstTarget = first.uploads[0];
    const secondTarget = second.uploads[0];
    if (firstTarget === undefined || secondTarget === undefined) return;

    let releaseBodies!: () => void;
    const bodiesReleased = new Promise<void>((resolve) => {
      releaseBodies = resolve;
    });
    let markBothReading!: () => void;
    const bothReading = new Promise<void>((resolve) => {
      markBothReading = resolve;
    });
    let readingBodies = 0;
    const body = async function* (): AsyncGenerator<Buffer> {
      readingBodies += 1;
      if (readingBodies === 2) markBothReading();
      await bodiesReleased;
      yield PNG_1X1;
    };
    const requests = [
      request(
        assetStore,
        'PUT',
        new URL(firstTarget.uploadUrl).pathname,
        { ...firstTarget.headers },
        body(),
      ),
      request(
        siblingStore,
        'PUT',
        new URL(secondTarget.uploadUrl).pathname,
        { ...secondTarget.headers },
        body(),
      ),
    ];
    await bothReading;
    releaseBodies();
    const results = await Promise.all(requests);
    expect(results.every((result) => result.handled)).toBe(true);
    const responses = results.map((result) => result.response);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: first.assets }),
    ).resolves.toMatchObject({ ok: true });

    const entries = await readdir(join(storageRoot, 'objects'));
    expect(entries.filter((entry) => entry.endsWith('.bin'))).toHaveLength(1);
    expect(entries.filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
    expect(entries.some((entry) => entry.includes('.tmp-'))).toBe(false);
  });

  it('stores deduplicated reachability records durably', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const hosted = await land(assetStore);
    const reachability = {
      scope: SCOPE,
      deploymentId: 'dep-1',
      deploymentVersion: 3,
      assets: [hosted],
    } as const;
    await assetStore.recordReachability(reachability);
    await assetStore.recordReachability(reachability);

    const metadata = JSON.parse(
      await readFile(filesystemAssetPaths(storageRoot, hosted.objectKey).metadata, 'utf8'),
    ) as { reachableBy: unknown[] };
    expect(metadata.reachableBy).toEqual([{ deploymentId: 'dep-1', deploymentVersion: 3 }]);
  });

  it('accepts legacy metadata without a retention flag and normalizes it on update', async () => {
    const storageRoot = await root();
    const hosted = await land(store(storageRoot));
    const metadataPath = filesystemAssetPaths(storageRoot, hosted.objectKey).metadata;
    const legacy = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    delete legacy.retainIndefinitely;
    await writeFile(metadataPath, `${JSON.stringify(legacy)}\n`);

    const restarted = store(storageRoot);
    await expect(
      restarted.verifyUploadedAssets({ scope: SCOPE, assets: [hosted] }),
    ).resolves.toMatchObject({ ok: true });
    await restarted.recordReachability({
      scope: SCOPE,
      deploymentId: 'dep-legacy',
      deploymentVersion: 1,
      assets: [hosted],
    });

    const normalized = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      reachableBy: unknown[];
      retainIndefinitely?: unknown;
    };
    expect(normalized.reachableBy).toEqual([{ deploymentId: 'dep-legacy', deploymentVersion: 1 }]);
    expect(normalized.retainIndefinitely).toBe(false);
  });

  it('rejects a non-boolean conservative-retention marker', async () => {
    const storageRoot = await root();
    const hosted = await land(store(storageRoot));
    const metadataPath = filesystemAssetPaths(storageRoot, hosted.objectKey).metadata;
    const malformed = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    malformed.retainIndefinitely = 'true';
    await writeFile(metadataPath, `${JSON.stringify(malformed)}\n`);

    await expect(
      store(storageRoot).verifyUploadedAssets({ scope: SCOPE, assets: [hosted] }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/metadata/i) });
  });
});

describe('FilesystemAssetStore filesystem boundary', () => {
  it('uses digest-only 0600 files inside 0700 directories without tenant names in paths', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const hosted = await land(assetStore);
    const paths = filesystemAssetPaths(storageRoot, hosted.objectKey);

    expect(basename(paths.bytes)).toMatch(/^[a-f0-9]{64}\.bin$/);
    expect(basename(paths.metadata)).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(JSON.stringify(paths)).not.toMatch(/acme-private|site-private|prod-private|logo/);
    expect((await lstat(storageRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(storageRoot, 'objects'))).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.bytes)).mode & 0o777).toBe(0o600);
    expect((await lstat(paths.metadata)).mode & 0o777).toBe(0o600);
  });

  it('rejects symlink roots and object directories', async () => {
    const target = await root();
    const parent = await root();
    const linkedRoot = join(parent, 'linked-root');
    await symlink(target, linkedRoot);
    await expect(plan(store(linkedRoot))).rejects.toThrow(/symlink/i);

    const storageRoot = await root();
    const elsewhere = await root();
    await symlink(elsewhere, join(storageRoot, 'objects'));
    await expect(plan(store(storageRoot))).rejects.toThrow(/symlink/i);
  });

  it.each(['bytes', 'metadata'] as const)('rejects a symlink %s destination', async (kind) => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const uploadPlan = await plan(assetStore);
    const hosted = uploadPlan.assets[0];
    const target = uploadPlan.uploads[0];
    if (hosted === undefined || target === undefined) return;
    const paths = filesystemAssetPaths(storageRoot, hosted.objectKey);
    await writeFile(join(storageRoot, 'outside'), 'outside');
    await symlink(join(storageRoot, 'outside'), paths[kind]);

    expect((await upload(assetStore, target, PNG_1X1)).status).toBe(500);
    expect(await readFile(join(storageRoot, 'outside'), 'utf8')).toBe('outside');
  });

  it('rejects a metadata symlink during quota enumeration instead of following it', async () => {
    const storageRoot = await root();
    const initial = store(storageRoot);
    const hosted = await land(initial);
    const paths = filesystemAssetPaths(storageRoot, hosted.objectKey);
    const external = join(storageRoot, 'external-metadata');
    await writeFile(external, await readFile(paths.metadata));
    await unlink(paths.metadata);
    await symlink(external, paths.metadata);
    const nextBytes = Buffer.from(PNG_1X1);
    nextBytes[nextBytes.length - 1] = (nextBytes[nextBytes.length - 1] ?? 0) ^ 1;

    await expect(
      plan(store(storageRoot, { quotas: [{ scope: SCOPE.org, maxStoredBytes: 4096 }] }), [
        prepared('other', nextBytes),
      ]),
    ).rejects.toThrow(/symlink/i);
  });

  it('rejects recognized symlink temp paths and cleans only stale regular temp files', async () => {
    const storageRoot = await root();
    const initial = store(storageRoot);
    const uploadPlan = await plan(initial);
    const hosted = uploadPlan.assets[0];
    if (hosted === undefined) return;
    const paths = filesystemAssetPaths(storageRoot, hosted.objectKey);
    const physicalId = basename(paths.bytes, '.bin');
    const temp = join(storageRoot, 'objects', `.${physicalId}.bin.tmp-${'a'.repeat(32)}`);
    await symlink(join(storageRoot, 'outside'), temp);
    await expect(plan(store(storageRoot))).rejects.toThrow(/symlink/i);

    await unlink(temp);
    await writeFile(temp, 'interrupted', { mode: 0o600 });
    await utimes(temp, new Date(0), new Date(0));
    const unrelated = join(storageRoot, 'objects', 'keep-me.tmp');
    await writeFile(unrelated, 'keep');
    await plan(store(storageRoot));
    await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelated, 'utf8')).toBe('keep');
  });

  it('never accepts orphaned bytes or malformed/truncated metadata as committed', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const uploadPlan = await plan(assetStore);
    const hosted = uploadPlan.assets[0];
    if (hosted === undefined) return;
    const paths = filesystemAssetPaths(storageRoot, hosted.objectKey);
    await writeFile(paths.bytes, PNG_1X1, { mode: 0o600 });
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: uploadPlan.assets }),
    ).resolves.toMatchObject({ ok: false });

    await writeFile(paths.metadata, '{"version":1', { mode: 0o600 });
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: uploadPlan.assets }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/metadata/i) });
  });
});
