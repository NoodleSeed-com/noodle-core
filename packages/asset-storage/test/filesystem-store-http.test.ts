import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { PreparedPackagedAsset } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { filesystemAssetPaths, filesystemAssetStateDirectory } from '../src/filesystem-layout.js';
import { FilesystemAssetStore } from '../src/filesystem-store.js';

const SCOPE = { org: 'acme', app: 'site', env: 'prod' } as const;
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function asset(): PreparedPackagedAsset {
  return {
    logicalId: 'logo',
    sourcePath: 'assets/logo.png',
    absolutePath: '/not-used/logo.png',
    contentHash: `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`,
    mimeType: 'image/png',
    byteLength: PNG_1X1.byteLength,
    width: 1,
    height: 1,
  };
}

async function fixture() {
  const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'noodle-fs-assets-http-')));
  const store = new FilesystemAssetStore({
    root: storageRoot,
    keySalt: 'filesystem-http-test-salt',
    maxFileBytes: 1024,
    maxDeployBytes: 2048,
  });
  return { storageRoot, store };
}

async function dispatch(
  store: FilesystemAssetStore,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  chunks: readonly Buffer[] = [],
): Promise<{ handled: boolean; response: CapturedResponse }> {
  const req = Object.assign(Readable.from(chunks), { method, headers }) as IncomingMessage;
  let status = 200;
  const responseHeaders: Record<string, string> = {};
  let finish!: (response: CapturedResponse) => void;
  const response = new Promise<CapturedResponse>((resolve) => {
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
      finish({
        status,
        headers: responseHeaders,
        body: body === undefined ? Buffer.alloc(0) : Buffer.from(body),
      });
    },
  } as unknown as ServerResponse;
  const handled = store.handleRequest(req, res, pathname);
  if (!handled) finish({ status, headers: responseHeaders, body: Buffer.alloc(0) });
  return { handled, response: await response };
}

async function committed(storageRoot?: string) {
  const setup =
    storageRoot === undefined
      ? await fixture()
      : {
          storageRoot,
          store: new FilesystemAssetStore({
            root: storageRoot,
            keySalt: 'filesystem-http-test-salt',
            maxFileBytes: 1024,
            maxDeployBytes: 2048,
          }),
        };
  const uploadPlan = await setup.store.planUploads({
    scope: SCOPE,
    assets: [asset()],
    uploadBaseUrl: 'https://self-host.example.test',
    publicBaseUrl: 'https://self-host.example.test',
  });
  const target = uploadPlan.uploads[0];
  const hosted = uploadPlan.assets[0];
  expect(target).toBeDefined();
  expect(hosted).toBeDefined();
  if (target === undefined || hosted === undefined) throw new Error('expected planned asset');
  const upload = await dispatch(
    setup.store,
    'PUT',
    new URL(target.uploadUrl).pathname,
    { ...target.headers },
    [PNG_1X1],
  );
  expect(upload.response.status).toBe(201);
  return { ...setup, hosted, pathname: new URL(hosted.publicUrl).pathname };
}

describe('FilesystemAssetStore HTTP delivery', () => {
  it('serves GET and HEAD with exact immutable headers and a stable strong ETag', async () => {
    const { store, pathname, hosted } = await committed();
    const expectedEtag = `"${hosted.contentHash.slice('sha256:'.length)}"`;

    const get = await dispatch(store, 'GET', pathname);
    expect(get.handled).toBe(true);
    expect(get.response).toEqual({
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(PNG_1X1.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=31536000, immutable',
        etag: expectedEtag,
      },
      body: PNG_1X1,
    });

    const head = await dispatch(store, 'HEAD', pathname);
    expect(head.response.status).toBe(200);
    expect(head.response.headers).toEqual(get.response.headers);
    expect(head.response.body).toHaveLength(0);
  });

  it('serves the same URL, bytes, and ETag from a second store after restart', async () => {
    const first = await committed();
    const second = new FilesystemAssetStore({
      root: first.storageRoot,
      keySalt: 'filesystem-http-test-salt',
      maxFileBytes: 1024,
      maxDeployBytes: 2048,
    });

    const response = await dispatch(second, 'GET', first.pathname);
    expect(response.response.status).toBe(200);
    expect(response.response.body).toEqual(PNG_1X1);
    expect(response.response.headers.etag).toBe(
      `"${first.hosted.contentHash.slice('sha256:'.length)}"`,
    );
  });

  it('claims public and upload routes while rejecting other methods and byte ranges', async () => {
    const { store, pathname } = await committed();
    const ranged = await dispatch(store, 'GET', pathname, { range: 'bytes=0-1' });
    expect(ranged.handled).toBe(true);
    expect(ranged.response.status).toBe(416);

    const posted = await dispatch(store, 'POST', pathname);
    expect(posted.handled).toBe(true);
    expect(posted.response.status).toBe(405);
    expect(posted.response.headers.allow).toBe('GET, HEAD');

    const uploadMethod = await dispatch(store, 'POST', '/__noodle/asset-uploads/not-a-token');
    expect(uploadMethod.handled).toBe(true);
    expect(uploadMethod.response.status).toBe(405);
    expect(uploadMethod.response.headers.allow).toBe('PUT');

    expect((await dispatch(store, 'GET', '/unrelated')).handled).toBe(false);
  });

  it('rejects an unknown valid-format upload token without acquiring coordination', async () => {
    const { storageRoot, store } = await fixture();
    await store.planUploads({
      scope: SCOPE,
      assets: [],
      uploadBaseUrl: 'https://self-host.example.test',
      publicBaseUrl: 'https://self-host.example.test',
    });
    const stateDirectory = filesystemAssetStateDirectory(storageRoot);
    const reservationsPath = join(stateDirectory, 'reservations.json');
    const reservationsBefore = await readFile(reservationsPath);
    const lockPath = join(stateDirectory, 'coordination.lock');
    await writeFile(lockPath, '{}\n', { mode: 0o600 });

    const unknown = await dispatch(store, 'PUT', `/__noodle/asset-uploads/${'A'.repeat(24)}`);

    expect(unknown.response.status).toBe(404);
    expect(await readFile(reservationsPath)).toEqual(reservationsBefore);
    expect(await readFile(lockPath, 'utf8')).toBe('{}\n');
  });

  it.each([
    '/__noodle/hosted-assets/../secret',
    '/__noodle/hosted-assets/%2e%2e/secret',
    '/__noodle/hosted-assets/%2Fetc%2Fpasswd',
    String.raw`/__noodle/hosted-assets/abc\def`,
    '/__noodle/hosted-assets//absolute',
  ])('rejects traversal-shaped public paths without filesystem access: %s', async (pathname) => {
    const { store } = await fixture();
    const result = await dispatch(store, 'GET', pathname);
    expect(result.handled).toBe(true);
    expect(result.response.status).toBe(400);
  });

  it('does not serve orphaned bytes, malformed metadata, or tampered bytes', async () => {
    const setup = await fixture();
    const uploadPlan = await setup.store.planUploads({
      scope: SCOPE,
      assets: [asset()],
      uploadBaseUrl: 'https://self-host.example.test',
      publicBaseUrl: 'https://self-host.example.test',
    });
    const hosted = uploadPlan.assets[0];
    if (hosted === undefined) return;
    const paths = filesystemAssetPaths(setup.storageRoot, hosted.objectKey);
    const pathname = new URL(hosted.publicUrl).pathname;

    await writeFile(paths.bytes, PNG_1X1, { mode: 0o600 });
    expect((await dispatch(setup.store, 'GET', pathname)).response.status).toBe(404);

    await writeFile(paths.metadata, '{"version":1', { mode: 0o600 });
    expect((await dispatch(setup.store, 'GET', pathname)).response.status).toBe(404);

    const target = uploadPlan.uploads[0];
    if (target === undefined) return;
    await unlink(paths.metadata);
    await unlink(paths.bytes);
    expect(
      (
        await dispatch(
          setup.store,
          'PUT',
          new URL(target.uploadUrl).pathname,
          { ...target.headers },
          [PNG_1X1],
        )
      ).response.status,
    ).toBe(201);
    const tampered = Buffer.from(PNG_1X1);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    await writeFile(paths.bytes, tampered, { mode: 0o600 });
    expect((await dispatch(setup.store, 'GET', pathname)).response.status).toBe(404);
    expect((await lstat(paths.metadata)).isFile()).toBe(true);
    expect(await readFile(paths.bytes)).toEqual(tampered);
  });
});
