import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { HostedPackagedAsset, PreparedPackagedAsset } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { filesystemAssetPaths } from '../src/filesystem-layout.js';
import { FilesystemAssetStore, type FilesystemAssetStoreConfig } from '../src/filesystem-store.js';

const SCOPE = { org: 'acme', app: 'site', env: 'prod' } as const;
const OTHER_SCOPE = { org: 'globex', app: 'site', env: 'prod' } as const;
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

function prepared(logicalId: string, bytes = PNG_1X1): PreparedPackagedAsset {
  return {
    logicalId,
    sourcePath: `assets/${logicalId}.png`,
    absolutePath: `/not-used/${logicalId}.png`,
    contentHash: `sha256:${hash(bytes)}`,
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    width: 1,
    height: 1,
  };
}

async function root(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'noodle-fs-assets-coordination-')));
}

function store(storageRoot: string, overrides: Partial<FilesystemAssetStoreConfig> = {}) {
  return new FilesystemAssetStore({
    root: storageRoot,
    keySalt: 'filesystem-coordination-test-salt',
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
  assets: readonly PreparedPackagedAsset[],
  now?: Date,
  scope = SCOPE,
) {
  return assetStore.planUploads({
    scope,
    assets,
    uploadBaseUrl: 'https://self-host.example.test',
    publicBaseUrl: 'https://self-host.example.test',
    ...(now === undefined ? {} : { now }),
  });
}

function responseCapture(): {
  readonly res: ServerResponse;
  readonly completed: Promise<CapturedResponse>;
} {
  let status = 200;
  const headers: Record<string, string> = {};
  let finish!: (value: CapturedResponse) => void;
  const completed = new Promise<CapturedResponse>((resolve) => {
    finish = resolve;
  });
  const res = {
    set statusCode(value: number) {
      status = value;
    },
    get statusCode() {
      return status;
    },
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value);
    },
    writeHead(code: number, values?: Record<string, string | number>) {
      status = code;
      for (const [name, value] of Object.entries(values ?? {})) {
        headers[name.toLowerCase()] = String(value);
      }
      return this;
    },
    end(body?: Buffer | string) {
      finish({
        status,
        headers,
        body: body === undefined ? Buffer.alloc(0) : Buffer.from(body),
      });
    },
  } as unknown as ServerResponse;
  return { res, completed };
}

async function dispatch(
  assetStore: FilesystemAssetStore,
  method: string,
  pathname: string,
  headers: Record<string, string>,
  body: Readable,
): Promise<CapturedResponse> {
  const req = Object.assign(body, { method, headers }) as IncomingMessage;
  const captured = responseCapture();
  expect(assetStore.handleRequest(req, captured.res, pathname)).toBe(true);
  return captured.completed;
}

async function upload(
  assetStore: FilesystemAssetStore,
  target: { readonly uploadUrl: string; readonly headers: Readonly<Record<string, string>> },
  bytes = PNG_1X1,
  headers: Record<string, string> = { ...target.headers },
): Promise<CapturedResponse> {
  return dispatch(
    assetStore,
    'PUT',
    new URL(target.uploadUrl).pathname,
    headers,
    Readable.from([bytes]),
  );
}

async function land(
  assetStore: FilesystemAssetStore,
  value: PreparedPackagedAsset,
  bytes = PNG_1X1,
) {
  const uploadPlan = await plan(assetStore, [value]);
  const target = uploadPlan.uploads[0];
  if (target === undefined) throw new Error('expected upload target');
  expect((await upload(assetStore, target, bytes)).status).toBe(201);
  return uploadPlan.assets[0] as HostedPackagedAsset;
}

describe('FilesystemAssetStore shared reservations and capabilities', () => {
  it('counts outstanding reserved bytes against quotas across store instances', async () => {
    const storageRoot = await root();
    const config = {
      quotas: [{ scope: SCOPE.org, maxStoredBytes: PNG_1X1.byteLength }],
    } as const;
    const first = store(storageRoot, config);
    const second = store(storageRoot, config);
    expect((await plan(first, [prepared('first')])).uploads).toHaveLength(1);

    const other = Buffer.from(PNG_1X1);
    other[other.length - 1] = (other[other.length - 1] ?? 0) ^ 1;
    await expect(plan(second, [prepared('second', other)])).rejects.toThrow(/quota/i);
  });

  it('enforces the outstanding capability cap store-wide and reuses a local capability', async () => {
    const storageRoot = await root();
    const first = store(storageRoot, { maxPendingUploads: 1 });
    const second = store(storageRoot, { maxPendingUploads: 1 });
    const initial = await plan(first, [prepared('first')]);
    const repeated = await plan(first, [prepared('first')]);
    expect(repeated.uploads[0]?.uploadUrl).toBe(initial.uploads[0]?.uploadUrl);
    await expect(plan(second, [prepared('second')])).rejects.toThrow(/outstanding|pending/i);
  });

  it('enforces a store-wide reserved-byte bound across store configurations', async () => {
    const storageRoot = await root();
    const large = Buffer.alloc(1024, 0x61);
    expect((await plan(store(storageRoot), [prepared('large', large)])).uploads).toHaveLength(1);

    const constrained = store(storageRoot, {
      maxFileBytes: 100,
      maxDeployBytes: 400,
      maxPendingUploads: 4,
    });
    await expect(plan(constrained, [prepared('small')])).rejects.toThrow(/reserved bytes/i);
  });

  it('sweeps expiry and releases a failed capability before the next plan', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot, { maxPendingUploads: 1, uploadExpirySeconds: 1 });
    await plan(assetStore, [prepared('expired')], new Date(0));
    expect((await plan(assetStore, [prepared('after-expiry')])).uploads).toHaveLength(1);

    const freshRoot = await root();
    const failedStore = store(freshRoot, { maxPendingUploads: 1 });
    const failed = await plan(failedStore, [prepared('failed')]);
    const target = failed.uploads[0];
    if (target === undefined) return;
    expect(
      (
        await upload(failedStore, target, PNG_1X1, {
          ...target.headers,
          'content-type': 'image/gif',
        })
      ).status,
    ).toBe(400);
    expect((await plan(failedStore, [prepared('after-failure')])).uploads).toHaveLength(1);
  });

  it('rechecks quota under shared commit serialization', async () => {
    const storageRoot = await root();
    const reserved = store(storageRoot, {
      quotas: [{ scope: SCOPE.org, maxStoredBytes: PNG_1X1.byteLength }],
    });
    const reservedPlan = await plan(reserved, [prepared('reserved')]);
    const target = reservedPlan.uploads[0];
    if (target === undefined) return;

    const other = Buffer.from(PNG_1X1);
    other[other.length - 1] = (other[other.length - 1] ?? 0) ^ 1;
    await land(store(storageRoot), prepared('committed-elsewhere', other), other);

    expect((await upload(reserved, target)).status).toBe(409);
    await expect(
      reserved.verifyUploadedAssets({ scope: SCOPE, assets: reservedPlan.assets }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('reconciles local tokens through repeated sibling commits without exhausting the cap', async () => {
    const storageRoot = await root();
    const first = store(storageRoot, { maxPendingUploads: 2 });
    const sibling = store(storageRoot, { maxPendingUploads: 2 });
    const staleTargets: Array<{
      readonly uploadUrl: string;
      readonly headers: Readonly<Record<string, string>>;
    }> = [];
    let current:
      | { readonly uploadUrl: string; readonly headers: Readonly<Record<string, string>> }
      | undefined;
    for (let index = 0; index < 5; index += 1) {
      const asset = prepared(`cycle-${index}`);
      const firstPlan = await plan(first, [asset]);
      const siblingPlan = await plan(sibling, [asset]);
      const firstTarget = firstPlan.uploads[0];
      const siblingTarget = siblingPlan.uploads[0];
      if (firstTarget === undefined || siblingTarget === undefined) return;
      staleTargets.push(firstTarget);
      expect((await upload(sibling, siblingTarget)).status).toBe(201);
      current = (await plan(first, [prepared(`next-${index}`)])).uploads[0];
      expect(current).toBeDefined();
      if (current === undefined) return;
      expect((await upload(first, current)).status).toBe(201);
    }

    expect((await upload(first, staleTargets[0] as (typeof staleTargets)[number])).status).toBe(
      404,
    );
  });

  it('never reuses or revokes an upload capability across tenant scopes', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const value = prepared('tenant-logo');
    const first = await plan(assetStore, [value], undefined, SCOPE);
    const other = await plan(assetStore, [value], undefined, OTHER_SCOPE);
    const firstTarget = first.uploads[0];
    const otherTarget = other.uploads[0];
    if (firstTarget === undefined || otherTarget === undefined) return;

    expect(otherTarget.objectKey).toBe(other.assets[0]?.objectKey);
    expect(otherTarget.objectKey).not.toBe(firstTarget.objectKey);
    expect(otherTarget.uploadUrl).not.toBe(firstTarget.uploadUrl);
    expect((await upload(assetStore, otherTarget)).status).toBe(201);
    expect((await upload(assetStore, firstTarget)).status).toBe(201);
    await expect(
      assetStore.verifyUploadedAssets({ scope: OTHER_SCOPE, assets: other.assets }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: first.assets }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('counts corrupt committed metadata and its repair reservation once by object key', async () => {
    const storageRoot = await root();
    const hosted = await land(store(storageRoot), prepared('repair'));
    await writeFile(
      filesystemAssetPaths(storageRoot, hosted.objectKey).bytes,
      Buffer.alloc(PNG_1X1.length),
    );
    const repairStore = store(storageRoot, {
      quotas: [{ scope: SCOPE.org, maxStoredBytes: PNG_1X1.byteLength }],
    });

    const repairPlan = await plan(repairStore, [prepared('repair')]);
    const repairTarget = repairPlan.uploads[0];
    expect(repairTarget).toBeDefined();
    if (repairTarget === undefined) return;
    expect((await upload(repairStore, repairTarget)).status).toBe(201);
    await expect(
      repairStore.verifyUploadedAssets({ scope: SCOPE, assets: repairPlan.assets }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('FilesystemAssetStore cross-instance object serialization', () => {
  it('invalidates stale sibling capabilities without erasing reachability', async () => {
    const storageRoot = await root();
    const first = store(storageRoot);
    const sibling = store(storageRoot);
    const firstPlan = await plan(first, [prepared('shared')]);
    const siblingPlan = await plan(sibling, [prepared('shared')]);
    const firstTarget = firstPlan.uploads[0];
    const siblingTarget = siblingPlan.uploads[0];
    if (firstTarget === undefined || siblingTarget === undefined) return;
    expect((await upload(first, firstTarget)).status).toBe(201);
    const hosted = firstPlan.assets[0] as HostedPackagedAsset;
    await first.recordReachability({
      scope: SCOPE,
      deploymentId: 'dep-preserved',
      deploymentVersion: 7,
      assets: [hosted],
    });

    expect((await upload(sibling, siblingTarget)).status).toBe(404);
    const metadata = JSON.parse(
      await readFile(filesystemAssetPaths(storageRoot, hosted.objectKey).metadata, 'utf8'),
    ) as { reachableBy: unknown[] };
    expect(metadata.reachableBy).toEqual([{ deploymentId: 'dep-preserved', deploymentVersion: 7 }]);
  });

  it('merges concurrent reachability updates from separate store instances', async () => {
    const storageRoot = await root();
    const first = store(storageRoot);
    const second = store(storageRoot);
    const hosted = await land(first, prepared('shared'));
    await Promise.all([
      first.recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-a',
        deploymentVersion: 1,
        assets: [hosted],
      }),
      second.recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-b',
        deploymentVersion: 2,
        assets: [hosted],
      }),
    ]);

    const metadata = JSON.parse(
      await readFile(filesystemAssetPaths(storageRoot, hosted.objectKey).metadata, 'utf8'),
    ) as { reachableBy: Array<{ deploymentId: string }> };
    expect(metadata.reachableBy.map((item) => item.deploymentId).sort()).toEqual([
      'dep-a',
      'dep-b',
    ]);
  });
});

describe('FilesystemAssetStore containment and persisted bounds', () => {
  it('rejects an ancestor symlink before creating the storage layout', async () => {
    const parent = await root();
    const realParent = join(parent, 'real-parent');
    const linkedParent = join(parent, 'linked-parent');
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, linkedParent);

    await expect(plan(store(join(linkedParent, 'assets')), [prepared('asset')])).rejects.toThrow(
      /ancestor|symlink/i,
    );
  });

  it('fails closed when the object directory identity changes during an upload', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const uploadPlan = await plan(assetStore, [prepared('swap')]);
    const target = uploadPlan.uploads[0];
    if (target === undefined) return;
    const objects = join(storageRoot, 'objects');
    const displaced = join(storageRoot, 'objects-displaced');
    let yielded!: () => void;
    const firstYielded = new Promise<void>((resolve) => {
      yielded = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const body = Readable.from(
      (async function* () {
        yield PNG_1X1.subarray(0, 16);
        yielded();
        await resumed;
        yield PNG_1X1.subarray(16);
      })(),
    );
    const response = dispatch(
      assetStore,
      'PUT',
      new URL(target.uploadUrl).pathname,
      { ...target.headers },
      body,
    );
    await firstYielded;
    let tempName: string | undefined;
    for (let attempt = 0; attempt < 100 && tempName === undefined; attempt += 1) {
      tempName = (await readdir(objects)).find((entry) => entry.includes('.bin.tmp-'));
      if (tempName === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(tempName).toBeDefined();
    if (tempName === undefined) return;
    await rename(objects, displaced);
    await mkdir(objects, { mode: 0o700 });
    await chmod(objects, 0o700);
    await writeFile(join(objects, tempName), Buffer.alloc(PNG_1X1.byteLength, 0x61), {
      mode: 0o600,
    });
    resume();

    expect((await response).status).toBe(500);
    expect((await readdir(objects)).some((entry) => entry.endsWith('.json'))).toBe(false);
  });

  it('rejects reachability growth before replacing readable metadata', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const hosted = await land(assetStore, prepared('bounded'));
    let rejected = false;
    for (let index = 0; index < 400; index += 1) {
      try {
        await assetStore.recordReachability({
          scope: SCOPE,
          deploymentId: `dep-${String(index).padStart(3, '0')}-${'x'.repeat(240)}`,
          deploymentVersion: index,
          assets: [hosted],
        });
      } catch {
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    const metadataPath = filesystemAssetPaths(storageRoot, hosted.objectKey).metadata;
    expect((await stat(metadataPath)).size).toBeLessThanOrEqual(64 * 1024);
    await expect(
      assetStore.verifyUploadedAssets({ scope: SCOPE, assets: [hosted] }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('marks a 257th distinct reachability record for conservative retention without growing the list', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot);
    const hosted = await land(assetStore, prepared('record-count'));
    for (let index = 0; index < 256; index += 1) {
      await assetStore.recordReachability({
        scope: SCOPE,
        deploymentId: `dep-${index}`,
        deploymentVersion: index,
        assets: [hosted],
      });
    }
    await expect(
      store(storageRoot).recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-overflow',
        deploymentVersion: 256,
        assets: [hosted],
      }),
    ).resolves.toBeUndefined();
    const metadataPath = filesystemAssetPaths(storageRoot, hosted.objectKey).metadata;
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      reachableBy: Array<{ deploymentId: string; deploymentVersion: number }>;
      retainIndefinitely?: unknown;
    };
    expect(metadata.reachableBy).toHaveLength(256);
    expect(metadata.reachableBy[0]).toEqual({ deploymentId: 'dep-0', deploymentVersion: 0 });
    expect(metadata.reachableBy[255]).toEqual({
      deploymentId: 'dep-255',
      deploymentVersion: 255,
    });
    expect(metadata.reachableBy).not.toContainEqual(
      expect.objectContaining({ deploymentId: 'dep-overflow' }),
    );
    expect(metadata.retainIndefinitely).toBe(true);

    await expect(
      store(storageRoot).recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-after-restart',
        deploymentVersion: 257,
        assets: [hosted],
      }),
    ).resolves.toBeUndefined();
    const afterRestart = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      reachableBy: unknown[];
      retainIndefinitely?: unknown;
    };
    expect(afterRestart.reachableBy).toHaveLength(256);
    expect(afterRestart.retainIndefinitely).toBe(true);
    await expect(
      store(storageRoot).verifyUploadedAssets({ scope: SCOPE, assets: [hosted] }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('never clears conservative retention during concurrent sibling updates', async () => {
    const storageRoot = await root();
    const first = store(storageRoot);
    const second = store(storageRoot);
    const hosted = await land(first, prepared('concurrent-overflow'));
    for (let index = 0; index < 255; index += 1) {
      await first.recordReachability({
        scope: SCOPE,
        deploymentId: `dep-${index}`,
        deploymentVersion: index,
        assets: [hosted],
      });
    }
    await Promise.all([
      first.recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-concurrent-a',
        deploymentVersion: 255,
        assets: [hosted],
      }),
      second.recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-concurrent-b',
        deploymentVersion: 256,
        assets: [hosted],
      }),
    ]);
    const metadataPath = filesystemAssetPaths(storageRoot, hosted.objectKey).metadata;
    const overflowed = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      reachableBy: Array<{ deploymentId: string }>;
      retainIndefinitely?: unknown;
    };
    expect(overflowed.reachableBy).toHaveLength(256);
    expect(
      overflowed.reachableBy.filter((item) => item.deploymentId.startsWith('dep-concurrent-')),
    ).toHaveLength(1);
    expect(overflowed.retainIndefinitely).toBe(true);

    await Promise.all([
      first.recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-after-overflow-a',
        deploymentVersion: 257,
        assets: [hosted],
      }),
      second.recordReachability({
        scope: SCOPE,
        deploymentId: 'dep-after-overflow-b',
        deploymentVersion: 258,
        assets: [hosted],
      }),
    ]);
    const retained = JSON.parse(
      await readFile(filesystemAssetPaths(storageRoot, hosted.objectKey).metadata, 'utf8'),
    ) as { reachableBy: unknown[]; retainIndefinitely?: unknown };
    expect(retained.reachableBy).toEqual(overflowed.reachableBy);
    expect(retained.retainIndefinitely).toBe(true);
  });

  it('rejects over-limit declared dimensions before capability creation', async () => {
    const storageRoot = await root();
    const assetStore = store(storageRoot, { maxPendingUploads: 1 });
    await expect(plan(assetStore, [{ ...prepared('huge'), width: 4097 }])).rejects.toThrow(
      /dimension/i,
    );
    expect((await plan(assetStore, [prepared('valid')])).uploads).toHaveLength(1);
  });
});
