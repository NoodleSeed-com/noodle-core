import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAppPurgeReconciliationChecksum } from '@noodle-borg/control-plane';
import {
  AppPurgeReconciliationError,
  type AppPurgeReconciliationOperator,
} from '@noodle-borg/control-plane/portable';
import {
  type AppPurgeReconciliationApplyRequestV1,
  AppPurgeReconciliationApplyResponseSchema,
  AppPurgeReconciliationPreviewResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  ServerRegistry,
  type ServiceOptions,
  serveService,
} from '../src/index.js';

const RELEASE_SHA = 'a'.repeat(40);
const NOW = new Date('2026-09-02T10:00:00.000Z');
const unsignedPreview = {
  schemaVersion: 1,
  releaseSha: RELEASE_SHA,
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
  candidateCount: 0,
  truncated: false,
  candidates: [],
} as const;
const preview = {
  ...unsignedPreview,
  checksum: computeAppPurgeReconciliationChecksum(unsignedPreview),
};
const applyRequest: AppPurgeReconciliationApplyRequestV1 = {
  schemaVersion: 1,
  preview,
  releaseSha: RELEASE_SHA,
  approvalReference: 'change-123',
  recoveryCheckpoint: 'checkpoint-123',
  reason: 'remove historical stranded anchors',
  idempotencyKey: 'operation-key-123',
  confirmed: true,
};
const applyResponse = AppPurgeReconciliationApplyResponseSchema.parse({
  ok: true,
  replayed: false,
  result: {
    operationId: '11111111-1111-4111-8111-111111111111',
    previewChecksum: preview.checksum,
    releaseSha: RELEASE_SHA,
    candidateCount: 0,
    deletedCount: 0,
    appliedAt: NOW.toISOString(),
  },
});

function gate() {
  return {
    authorize: (req: { headers: Record<string, unknown> }) => {
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (token === 'admin-token') {
        return Promise.resolve({
          ok: true as const,
          identity: {
            subject: 'admin-sub',
            email: 'admin@noodleseed.test',
            superAdmin: true,
          },
        });
      }
      if (token === 'member-token') {
        return Promise.resolve({
          ok: true as const,
          identity: {
            subject: 'member-sub',
            email: 'member@noodleseed.test',
            superAdmin: false,
          },
        });
      }
      return Promise.resolve({ ok: false as const, status: 401, message: 'invalid bearer token' });
    },
  };
}

function fakeOperator(): AppPurgeReconciliationOperator {
  return {
    preview: vi.fn(() => Promise.resolve(preview)),
    apply: vi.fn(() => Promise.resolve(applyResponse)),
  };
}

async function listen(
  options: ServiceOptions,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(createServiceHandler(new ServerRegistry(), options));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

const servers: Array<() => Promise<void>> = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
  await Promise.all(tempDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe('app purge reconciliation routes', () => {
  let base: string;
  let operator: AppPurgeReconciliationOperator;

  beforeEach(async () => {
    operator = fakeOperator();
    const service = await listen({
      deployGate: gate(),
      appPurgeReconciliationOperator: operator,
      buildInfo: { version: 'test', gitSha: RELEASE_SHA, buildTime: NOW.toISOString() },
      clock: () => NOW,
    });
    base = service.base;
    servers.push(service.close);
  });

  async function post(action: 'preview' | 'apply', body: unknown, token = 'admin-token') {
    return fetch(`${base}/v1/service/app-purge-reconciliation/${action}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it.each([undefined, 'wrong-token'])('requires valid authentication (%s)', async (token) => {
    const response = await fetch(`${base}/v1/service/app-purge-reconciliation/preview`, {
      method: 'POST',
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ schemaVersion: 1 }),
    });

    expect(response.status).toBe(401);
    expect(operator.preview).not.toHaveBeenCalled();
  });

  it('requires a platform super-admin', async () => {
    const response = await post('preview', { schemaVersion: 1 }, 'member-token');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'super-admin required' });
    expect(operator.preview).not.toHaveBeenCalled();
  });

  it('rejects the wrong method, query parameters, content type, and malformed or unknown input', async () => {
    const get = await fetch(`${base}/v1/service/app-purge-reconciliation/preview`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    const query = await fetch(`${base}/v1/service/app-purge-reconciliation/preview?limit=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    const contentType = await fetch(`${base}/v1/service/app-purge-reconciliation/preview`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'text/plain' },
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    const malformed = await post('preview', '{');
    const unknown = await post('preview', { schemaVersion: 1, surprise: true });
    const unconfirmed = await post('apply', { ...applyRequest, confirmed: false });

    expect(get.status).toBe(404);
    expect(query.status).toBe(400);
    expect(contentType.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(unconfirmed.status).toBe(400);
    expect(operator.preview).not.toHaveBeenCalled();
    expect(operator.apply).not.toHaveBeenCalled();
  });

  it.each([
    'preview',
    'apply',
  ] as const)('returns the exact unavailable result for %s', async (action) => {
    await servers.pop()?.();
    const service = await listen({
      deployGate: gate(),
      buildInfo: { version: 'test', gitSha: RELEASE_SHA, buildTime: NOW.toISOString() },
    });
    servers.push(service.close);
    const response = await fetch(`${service.base}/v1/service/app-purge-reconciliation/${action}`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify(action === 'preview' ? { schemaVersion: 1 } : applyRequest),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'app_purge_reconciliation_unavailable',
      error: 'app purge reconciliation is unavailable',
    });
  });

  it('defaults preview to 100 and parses the response through the strict service contract', async () => {
    const response = await post('preview', { schemaVersion: 1 });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(AppPurgeReconciliationPreviewResponseSchema.parse(body)).toEqual(body);
    expect(operator.preview).toHaveBeenCalledWith({
      releaseSha: RELEASE_SHA,
      limit: 100,
      now: NOW,
    });
  });

  it('forwards the complete apply request, actor, release, and clock', async () => {
    const response = await post('apply', applyRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(applyResponse);
    expect(operator.apply).toHaveBeenCalledWith({
      request: applyRequest,
      actor: { subject: 'admin-sub', email: 'admin@noodleseed.test' },
      currentReleaseSha: RELEASE_SHA,
      now: NOW,
    });
  });

  it.each([
    'app_purge_preview_expired',
    'app_purge_release_mismatch',
    'app_purge_preview_mismatch',
    'app_purge_candidate_drift',
    'app_purge_idempotency_conflict',
  ] as const)('maps %s to its exact 409 code', async (code) => {
    vi.mocked(operator.apply).mockRejectedValueOnce(new AppPurgeReconciliationError(code, 'safe'));

    const response = await post('apply', applyRequest);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code });
  });

  it('bounds unknown failures and rejects invalid release metadata without invoking the operator', async () => {
    vi.mocked(operator.preview).mockRejectedValueOnce(new Error('private database detail'));
    const failed = await post('preview', { schemaVersion: 1 });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('private database detail');

    await servers.pop()?.();
    const unstamped = await listen({
      deployGate: gate(),
      appPurgeReconciliationOperator: operator,
      buildInfo: { version: 'test', gitSha: 'unknown', buildTime: NOW.toISOString() },
    });
    servers.push(unstamped.close);
    const unavailable = await fetch(
      `${unstamped.base}/v1/service/app-purge-reconciliation/preview`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1 }),
      },
    );
    expect(unavailable.status).toBe(503);
    expect(operator.preview).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an operator returns output outside the strict response schema', async () => {
    vi.mocked(operator.preview).mockResolvedValueOnce({
      ...preview,
      unexpected: true,
    } as typeof preview);

    const response = await post('preview', { schemaVersion: 1 });

    expect(response.status).toBe(503);
  });
});

describe('serveService non-Postgres composition', () => {
  it('keeps reconciliation unavailable for in-memory and file persistence', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'noodle-app-purge-route-'));
    tempDirectories.push(dataDir);
    const common = {
      port: 0,
      deployGate: gate(),
      appPurgeReconciliationOperator: fakeOperator(),
      buildInfo: { version: 'test', gitSha: RELEASE_SHA, buildTime: NOW.toISOString() },
    } as const;
    const memory = await serveService(common);
    const file = await serveService({
      ...common,
      dataDir,
      secretMasterKey: Buffer.alloc(32, 7).toString('base64'),
    });
    servers.push(memory.close, file.close);

    for (const service of [memory, file]) {
      const response = await fetch(`${service.url}/v1/service/app-purge-reconciliation/preview`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1 }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'app_purge_reconciliation_unavailable',
      });
    }
  });
});
