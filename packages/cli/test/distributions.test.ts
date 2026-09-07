import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderProductSkillBundle,
  validateRenderedProductSkillFiles,
} from '@noodle-borg/agent-kit';
import { type AppPackageSnapshotV1, createAppPackageSnapshotV1 } from '@noodle-borg/app-package';
import {
  type DistributionLifecycle,
  type DistributionPublishRequest,
  DistributionPublishRequestSchema,
  type DistributionVersion,
  DistributionVersionSchema,
} from '@noodle-borg/wire-contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { compileLocalInput } from '../src/local-compile.js';

const SERVER = join(import.meta.dirname, 'fixtures', 'restaurant-pickup', 'src', 'server.ts');

let snapshot: AppPackageSnapshotV1;
let staleSnapshot: AppPackageSnapshotV1;
let server: Server;
let base: string;
let home: string;
let directory: string;
let posted: DistributionPublishRequest | undefined;
let version: DistributionVersion | undefined;
let lifecycle: DistributionLifecycle | undefined;
let lifecycleRequests: Array<{ action: string; body: unknown }> = [];
let corruptDownload = false;
let useStaleSnapshot = false;
let deploymentAccessMode = 'public';
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const local = await compileLocalInput({ manifestPath: SERVER });
  if (!local.ok || local.compiled.appPackage === undefined) {
    throw new Error('distribution fixture did not compile an App Package');
  }
  snapshot = createAppPackageSnapshotV1(
    local.compiled.appPackage,
    renderProductSkillBundle,
    validateRenderedProductSkillFiles,
  );
  staleSnapshot = createAppPackageSnapshotV1(
    {
      ...local.compiled.appPackage,
      app: { ...local.compiled.appPackage.app, version: '1.0.1' },
    },
    renderProductSkillBundle,
    validateRenderedProductSkillFiles,
  );
});

beforeEach(async () => {
  posted = undefined;
  version = undefined;
  lifecycle = undefined;
  lifecycleRequests = [];
  corruptDownload = false;
  useStaleSnapshot = false;
  deploymentAccessMode = 'public';
  home = mkdtempSync(join(tmpdir(), 'noodle-distributions-home-'));
  directory = mkdtempSync(join(tmpdir(), 'noodle-distributions-output-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) =>
    server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
  );
  rmSync(home, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
});

afterAll(() => vi.restoreAllMocks());

describe('noodle distributions', () => {
  it.each([
    'claude',
    'openai',
  ] as const)('publishes the exact deployment-bound %s archive', async (target) => {
    const args = [
      'distributions',
      'publish',
      'dep_123',
      SERVER,
      '--target',
      target,
      ...(target === 'openai' ? ['--category', 'Food & Drink'] : []),
      ...common(),
    ];

    expect(await run(args, {}, home)).toBe(0);
    expect(posted).toMatchObject({
      schemaVersion: 1,
      target,
      variant: target === 'openai' ? 'submission' : 'plugin',
      snapshotSha256: snapshot.snapshotSha256,
      archive: {
        encoding: 'base64',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        treeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const envelope = lastJson();
    expect(envelope).toMatchObject({
      ok: true,
      data: { distribution: { id: 'dist_1', target, version: 1 }, replayed: false },
    });
    expect(error).not.toHaveBeenCalled();
  }, 30_000);

  it('fails before packaging or POST when local source differs from the deployment snapshot', async () => {
    useStaleSnapshot = true;

    expect(
      await run(
        ['distributions', 'publish', 'dep_123', SERVER, '--target', 'claude', ...common()],
        {},
        home,
      ),
    ).toBe(1);
    expect(posted).toBeUndefined();
    expect(lastJson()).toMatchObject({
      ok: false,
      error: { code: 'distribution_source_mismatch' },
    });
  });

  it('explains public-access eligibility without leaking milestone language', async () => {
    deploymentAccessMode = 'customers';

    expect(
      await run(
        ['distributions', 'publish', 'dep_123', SERVER, '--target', 'claude', ...common()],
        {},
        home,
      ),
    ).toBe(1);
    expect(posted).toBeUndefined();
    const envelope = lastJson();
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'distribution_public_access_required',
        message:
          'Hosted package storage supports only deployments with "public" (anonymous) access; this deployment uses "customers".',
        fix: expect.stringMatching(/keep this protected deployment/i),
        next: 'noodle export plugin claude --help',
      },
    });
    expect(JSON.stringify(envelope)).not.toMatch(/milestone/i);
  });

  it('requires OpenAI category and rejects target-specific flags on Claude', async () => {
    expect(
      await run(
        ['distributions', 'publish', 'dep_123', SERVER, '--target', 'openai', ...common()],
        {},
        home,
      ),
    ).toBe(2);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: 'usage_error' } });

    log.mockClear();
    expect(
      await run(
        [
          'distributions',
          'publish',
          'dep_123',
          SERVER,
          '--target',
          'claude',
          '--category',
          'Productivity',
          ...common(),
        ],
        {},
        home,
      ),
    ).toBe(2);
    expect(lastJson()).toMatchObject({ ok: false, error: { code: 'usage_error' } });
  });

  it('lists and inspects immutable metadata through tenant-scoped service routes', async () => {
    await publishClaude();
    log.mockClear();

    expect(
      await run(['distributions', 'list', 'dep_123', '--target', 'claude', ...common()], {}, home),
    ).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      data: { versions: [{ id: 'dist_1', target: 'claude' }] },
    });

    log.mockClear();
    expect(await run(['distributions', 'inspect', 'dist_1', ...common()], {}, home)).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, data: { id: 'dist_1', version: 1 } });
  });

  it('downloads exact bytes atomically and refuses corrupt service bytes without partial output', async () => {
    await publishClaude();
    log.mockClear();
    const output = join(directory, 'plugin.zip');
    expect(
      await run(['distributions', 'download', 'dist_1', '--output', output, ...common()], {}, home),
    ).toBe(0);
    expect(existsSync(output)).toBe(true);
    expect(sha256(await import('node:fs').then(({ readFileSync }) => readFileSync(output)))).toBe(
      version?.archiveSha256,
    );

    corruptDownload = true;
    log.mockClear();
    const corruptOutput = join(directory, 'corrupt.zip');
    expect(
      await run(
        ['distributions', 'download', 'dist_1', '--output', corruptOutput, ...common()],
        {},
        home,
      ),
    ).toBe(1);
    expect(existsSync(corruptOutput)).toBe(false);
    expect(lastJson()).toMatchObject({
      ok: false,
      error: { code: 'distribution_download_integrity_failed' },
    });
  });

  it('operates readiness, human review, release, grants, rollback, deprecation, and revocation', async () => {
    await publishClaude();
    log.mockClear();

    expect(
      await run(
        [
          'distributions',
          'readiness',
          'dist_1',
          '--status',
          'ready',
          '--note',
          'Archive checked locally.',
          ...common(),
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(
      await run(
        [
          'distributions',
          'review',
          'dist_1',
          '--status',
          'in-review',
          '--feedback',
          'Submitted to the host owner.',
          ...common(),
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(
      await run(
        ['distributions', 'release', 'dist_1', '--visibility', 'public', ...common()],
        {},
        home,
      ),
    ).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      data: { channelUrl: expect.stringContaining('/v1/distribution-releases/drel_1') },
    });
    expect(
      await run(['distributions', 'grant', 'dist_1', '--expires-in', '600', ...common()], {}, home),
    ).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      data: {
        grantId: 'dgrant_1',
        distributionId: 'dist_1',
        downloadUrl: expect.stringContaining(
          '/v1/distribution-download-grants/dgrant_1/archive?token=review-secret',
        ),
      },
    });
    expect(JSON.stringify(lastJson())).not.toContain('downloadPath');
    for (const action of ['rollback', 'deprecate', 'revoke'] as const) {
      expect(await run(['distributions', action, 'dist_1', ...common()], {}, home)).toBe(0);
    }

    expect(lifecycleRequests).toEqual([
      { action: 'readiness', body: { status: 'ready', note: 'Archive checked locally.' } },
      {
        action: 'review',
        body: { reportedStatus: 'in-review', feedback: 'Submitted to the host owner.' },
      },
      { action: 'release', body: { visibility: 'public' } },
      { action: 'download-grants', body: { expiresInSeconds: 600 } },
      { action: 'rollback', body: undefined },
      { action: 'deprecate', body: undefined },
      { action: 'revoke', body: undefined },
    ]);

    log.mockClear();
    expect(await run(['distributions', 'inspect', 'dist_1', ...common()], {}, home)).toBe(0);
    expect(lastJson()).toMatchObject({
      ok: true,
      data: {
        id: 'dist_1',
        lifecycle: { readiness: { status: 'ready' }, disposition: { status: 'revoked' } },
      },
    });
  });

  it('rejects invalid lifecycle status and grant expiry before contacting the service', async () => {
    expect(
      await run(
        ['distributions', 'readiness', 'dist_1', '--status', 'flying', ...common()],
        {},
        home,
      ),
    ).toBe(2);
    expect(
      await run(['distributions', 'grant', 'dist_1', '--expires-in', '10', ...common()], {}, home),
    ).toBe(2);
    expect(lifecycleRequests).toEqual([]);
  });
});

async function publishClaude(): Promise<void> {
  expect(
    await run(
      ['distributions', 'publish', 'dep_123', SERVER, '--target', 'claude', ...common()],
      {},
      home,
    ),
  ).toBe(0);
}

function common(): string[] {
  return ['--org', 'acme', '--service', base, '--auth-token', 'test-token', '--json'];
}

function lastJson(): Record<string, unknown> {
  return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

async function handle(
  req: Parameters<typeof createServer>[0] extends (...args: infer Args) => unknown
    ? Args[0]
    : never,
  res: Parameters<typeof createServer>[0] extends (...args: infer Args) => unknown
    ? Args[1]
    : never,
): Promise<void> {
  const url = new URL(req.url ?? '/', base);
  if (req.headers.authorization !== 'Bearer test-token') return json(res, 401, { error: 'denied' });
  if (url.pathname.endsWith('/package')) {
    return json(res, 200, {
      ok: true,
      data: {
        deploymentId: 'dep_123',
        appSlug: 'restaurant-pickup',
        environment: 'prod',
        serverVersion: '1',
        active: true,
        snapshot: useStaleSnapshot ? staleSnapshot : snapshot,
      },
    });
  }
  if (url.pathname.endsWith('/deployments/dep_123')) {
    return json(res, 200, {
      ok: true,
      data: {
        deploymentId: 'dep_123',
        orgSlug: 'acme',
        appSlug: 'restaurant-pickup',
        environment: 'prod',
        serverVersion: '1',
        active: true,
        serverName: 'restaurant_pickup',
        createdAt: '2026-08-18T00:00:00.000Z',
        accessMode: deploymentAccessMode,
        endpointUrl: 'https://demo.cloud.noodleseed.dev/restaurant-pickup/v1/mcp',
      },
    });
  }
  if (req.method === 'POST' && url.pathname.endsWith('/deployments/dep_123/distributions')) {
    posted = DistributionPublishRequestSchema.parse(await readJson(req));
    version = distributionVersion(posted);
    lifecycle = defaultLifecycle(version);
    return json(res, 201, { ok: true, data: version, replayed: false });
  }
  if (req.method === 'GET' && url.pathname.endsWith('/deployments/dep_123/distributions')) {
    return json(res, 200, { ok: true, data: { versions: version === undefined ? [] : [version] } });
  }
  if (req.method === 'GET' && url.pathname.endsWith('/distributions/dist_1/archive')) {
    if (posted === undefined || version === undefined)
      return json(res, 404, { error: 'not found' });
    const bytes = Buffer.from(posted.archive.content, 'base64');
    const output = corruptDownload ? Buffer.concat([bytes, Buffer.from('corrupt')]) : bytes;
    res.writeHead(200, {
      'content-type': 'application/zip',
      etag: `"${version.archiveSha256}"`,
      'content-length': String(output.byteLength),
    });
    res.end(output);
    return;
  }
  if (req.method === 'GET' && url.pathname.endsWith('/distributions/dist_1')) {
    return version === undefined
      ? json(res, 404, { error: 'not found' })
      : json(res, 200, { ok: true, data: version, lifecycle });
  }
  const lifecycleMatch = url.pathname.match(
    /\/distributions\/dist_1\/(readiness|review|release|rollback|deprecate|revoke|download-grants)$/,
  );
  if (lifecycleMatch !== null && (req.method === 'POST' || req.method === 'PUT')) {
    if (version === undefined || lifecycle === undefined)
      return json(res, 404, { error: 'not found' });
    const action = lifecycleMatch[1] as string;
    const body =
      action === 'rollback' || action === 'deprecate' || action === 'revoke'
        ? undefined
        : await readJson(req);
    lifecycleRequests.push({ action, body });
    if (action === 'download-grants') {
      return json(res, 201, {
        ok: true,
        data: {
          grantId: 'dgrant_1',
          distributionId: version.id,
          downloadPath: '/v1/distribution-download-grants/dgrant_1/archive?token=review-secret',
          expiresAt: '2026-08-18T00:10:00.000Z',
        },
      });
    }
    if (action === 'readiness') {
      const value = body as { status: DistributionLifecycle['readiness']['status']; note?: string };
      lifecycle = {
        ...lifecycle,
        readiness: {
          status: value.status,
          ...(value.note === undefined ? {} : { note: value.note }),
          updatedAt: '2026-08-18T00:01:00.000Z',
          updatedBySubject: 'member_1',
        },
      };
    } else if (action === 'review') {
      const value = body as {
        reportedStatus: NonNullable<DistributionLifecycle['review']>['reportedStatus'];
        feedback?: string;
      };
      lifecycle = {
        ...lifecycle,
        review: {
          source: 'human',
          reportedStatus: value.reportedStatus,
          ...(value.feedback === undefined ? {} : { feedback: value.feedback }),
          recordedAt: '2026-08-18T00:02:00.000Z',
          recordedBySubject: 'member_1',
        },
      };
    } else if (action === 'release') {
      lifecycle = {
        ...lifecycle,
        release: {
          id: 'drel_1',
          activeDistributionId: version.id,
          visibility: (body as { visibility: 'private' | 'public' }).visibility,
          updatedAt: '2026-08-18T00:03:00.000Z',
          updatedBySubject: 'member_1',
        },
      };
    } else if (action === 'deprecate' || action === 'revoke') {
      lifecycle = {
        ...lifecycle,
        disposition: {
          status: action === 'deprecate' ? 'deprecated' : 'revoked',
          changedAt: '2026-08-18T00:04:00.000Z',
          changedBySubject: 'member_1',
        },
      };
    }
    return json(res, 200, { ok: true, data: { version, lifecycle } });
  }
  return json(res, 404, { error: 'not found' });
}

function defaultLifecycle(value: DistributionVersion): DistributionLifecycle {
  return {
    schemaVersion: 1,
    distributionId: value.id,
    readiness: {
      status: 'draft',
      updatedAt: value.createdAt,
      updatedBySubject: value.createdBySubject,
      ...(value.createdByEmail === undefined ? {} : { updatedByEmail: value.createdByEmail }),
    },
    disposition: { status: 'available' },
  };
}

function distributionVersion(request: DistributionPublishRequest): DistributionVersion {
  return DistributionVersionSchema.parse({
    id: 'dist_1',
    schemaVersion: 1,
    orgSlug: 'acme',
    deploymentId: 'dep_123',
    appSlug: 'restaurant-pickup',
    environment: 'prod',
    serverVersion: '1',
    target: request.target,
    variant: request.variant,
    version: 1,
    snapshotSha256: request.snapshotSha256,
    sourceManifestSha256: snapshot.artifact.provenance.sourceManifestSha256,
    mcpSurfaceSha256: snapshot.artifact.provenance.mcpSurfaceSha256,
    adapterVersion: request.archive.adapterVersion,
    treeSha256: request.archive.treeSha256,
    archiveSha256: request.archive.sha256,
    byteLength: request.archive.byteLength,
    createdAt: '2026-08-18T00:00:00.000Z',
    createdBySubject: 'member_1',
    createdByEmail: 'member@acme.test',
  });
}

async function readJson(req: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(
  res: {
    writeHead(status: number, headers: Record<string, string>): unknown;
    end(body: string): unknown;
  },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
