import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { noopLogger, sendJson } from '@noodle-borg/transport-http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationActivity } from '../src/application-activity.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { InMemoryOperationCoordinationStore } from '../src/operation-coordination.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';
import { dispatchBusinessInformationRoutes } from '../src/routes/business-information-dispatch.js';

const scope = { org: 'acme', app: 'custom', env: 'prod', installationId: 'custom-prod' };
const otherScope = { ...scope, app: 'other', installationId: 'other-prod' };
const now = Date.parse('2026-09-10T00:00:00Z');
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resource = 'a'.repeat(64);
let server: Server;
let base: string;
let records: InMemoryBusinessInformationStore;
let coordination: InMemoryOperationCoordinationStore;
let activity: ApplicationActivity;
let available: boolean;

beforeEach(async () => {
  available = true;
  records = new InMemoryBusinessInformationStore();
  coordination = new InMemoryOperationCoordinationStore(() => now);
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@example.test' },
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'org-owner-only',
    email: 'org-owner@example.test',
    role: 'owner',
  });
  for (const target of [scope, otherScope]) {
    await records.createInstallation({
      scope: target,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
      actorEmail: 'owner@example.test',
    });
    for (const role of ['administrator', 'manager', 'operator', 'viewer'] as const)
      await records.setGrant({
        scope: target,
        subject: role,
        email: `${role}@example.test`,
        role,
        expectedRevision: 0,
        actorSubject: 'owner',
      });
  }
  activity = new ApplicationActivity({
    store: new InMemoryOperationEvidenceStore(),
    coordination,
    epoch: 'coordination-test-epoch',
    identityKey: 'test-key-with-at-least-thirty-two-characters',
    now: () => now,
    allowance: async () => ({ maximumDays: 30, defaultDays: 30, revision: 'free' }),
  });
  server = createServer((req, res) => {
    if (
      !dispatchBusinessInformationRoutes(req, res, new URL(req.url ?? '/', 'http://localhost'), {
        store: records,
        ...(available ? { activity } : {}),
        controlPlane,
        publicCounters: new InMemoryDailyCounterStore(),
        maxBody: 32768,
        trustProxy: false,
        logger: noopLogger,
        tls: {},
        applySecurityHeaders: () => {},
        enforceHttps: () => false,
        gate: {
          authorize: async (request) => {
            const subject =
              /^Bearer (owner|org-owner-only|administrator|manager|operator|viewer)$/.exec(
                String(request.headers.authorization ?? ''),
              )?.[1];
            return subject
              ? {
                  ok: true,
                  identity: { subject, email: `${subject}@example.test`, superAdmin: false },
                }
              : { ok: false, status: 401, message: 'Authentication required' };
          },
        },
      })
    )
      sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orgs/acme/solution-installations`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
function request(
  path = '',
  subject = 'owner',
  body?: unknown,
  installation = scope.installationId,
) {
  return fetch(`${base}/${installation}/operations/coordination${path}`, {
    headers: { authorization: `Bearer ${subject}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
}
async function seed(
  key = resource,
  target = scope,
  state: 'executing' | 'unknown' = 'unknown',
  deadline = now - 1,
) {
  await coordination.claim({
    scope: target,
    resource: key,
    token,
    epoch: 'private-epoch',
    generation: 'private-generation',
    reference: 'provider-item-reference',
    operationDigest: 'b'.repeat(64),
    startedAt: now - 2000,
    deadline,
    state,
  });
}

describe('administrator operation coordination recovery', () => {
  it('denies anonymous, viewer, operator, manager and organization-only owners before coordination IO', async () => {
    const list = vi.spyOn(coordination, 'list');
    const resolve = vi.spyOn(coordination, 'resolve');
    for (const subject of ['anonymous', 'viewer', 'operator', 'manager', 'org-owner-only']) {
      const expected = subject === 'anonymous' ? 401 : 403;
      expect((await request('', subject)).status).toBe(expected);
      expect(
        (await request('/resolve', subject, { resource, token, reason: 'Reviewed provider state' }))
          .status,
      ).toBe(expected);
    }
    expect(list).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  it('lists only the exact installation scope with private responses and bounded pagination', async () => {
    await seed();
    await seed('c'.repeat(64));
    await seed('d'.repeat(64), otherScope);
    const result = await request('?limit=1', 'administrator');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    const body = await result.json();
    expect(body.data.records.map((entry: { resource: string }) => entry.resource)).toEqual([
      resource,
    ]);
    expect(body.data.records[0]).toMatchObject({
      token,
      reference: 'provider-item-reference',
      state: 'unknown',
    });
    expect(JSON.stringify(body)).not.toMatch(/private-|installationId|generation|"scope"/);
    const next = await (
      await request(`?limit=1&beforeResource=${body.data.nextBeforeResource}`)
    ).json();
    expect(next.data.records.map((entry: { resource: string }) => entry.resource)).toEqual([
      'c'.repeat(64),
    ]);
  });
  it('requires exact resource/token and verified reviewer; stale, cross-installation and active claims cannot resolve', async () => {
    await seed();
    const review = {
      resource,
      token,
      reason: 'Verified external outcome before releasing custody',
    };
    expect(
      (
        await request('/resolve', 'owner', {
          ...review,
          token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        })
      ).status,
    ).toBe(409);
    expect((await request('/resolve', 'owner', review, otherScope.installationId)).status).toBe(
      409,
    );
    expect((await request('/resolve', 'owner', { ...review, reviewer: 'forged' })).status).toBe(
      400,
    );
    const result = await request('/resolve', 'administrator', review);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, data: { resolved: true } });
    expect(coordination.receipts).toMatchObject([
      { reviewer: 'administrator', reason: review.reason, resolution: 'reviewed' },
    ]);
    expect((await request('/resolve', 'owner', review)).status).toBe(409);
    await seed(resource, scope, 'executing', now + 1000);
    expect((await request('/resolve', 'owner', review)).status).toBe(409);
    expect(coordination.records.size).toBe(1);
  });
  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=1&limit=2',
    '?beforeResource=bad',
    '?cursor=bad',
    '?org=other',
  ])('rejects malformed paging before IO (%s)', async (query) => {
    const list = vi.spyOn(coordination, 'list');
    expect((await request(query)).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
  it.each([
    '',
    ' ',
    'a'.repeat(257),
    'reason\nwith-control',
  ])('rejects invalid review reasons before resolution IO', async (reason) => {
    const resolve = vi.spyOn(coordination, 'resolve');
    expect((await request('/resolve', 'owner', { resource, token, reason })).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('rechecks administrator access after a delayed list and never leaks its result', async () => {
    await seed();
    const original = coordination.list.bind(coordination);
    vi.spyOn(coordination, 'list').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await records.revokeGrant({
        scope,
        subject: 'administrator',
        actorSubject: 'owner',
        expectedRevision: 1,
      });
      return result;
    });
    const result = await request('', 'administrator');
    expect(result.status).toBe(403);
    expect(JSON.stringify(await result.json())).not.toContain(token);
  });
  it('rechecks access after parsing a review before mutation IO', async () => {
    await seed();
    const grant = await records.getGrant(scope, 'owner');
    vi.spyOn(records, 'getGrant').mockResolvedValueOnce(grant).mockResolvedValueOnce(undefined);
    const resolve = vi.spyOn(coordination, 'resolve');
    expect(
      (await request('/resolve', 'owner', { resource, token, reason: 'Reviewed' })).status,
    ).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('never resolves a resource in another organization even when that installation is administered', async () => {
    await seed();
    const foreign = { ...scope, org: 'foreign' };
    await records.createInstallation({
      scope: foreign,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
      actorEmail: 'owner@example.test',
    });
    const response = await fetch(
      `${base.replace('/orgs/acme/', '/orgs/foreign/')}/${scope.installationId}/operations/coordination/resolve`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
        body: JSON.stringify({ resource, token, reason: 'Reviewed' }),
      },
    );
    expect(response.status).toBe(409);
    expect(coordination.records.has(resource)).toBe(true);
    expect(coordination.receipts).toEqual([]);
  });
  it('fails closed if storage is unavailable or returns another scope', async () => {
    available = false;
    expect((await request()).status).toBe(503);
    available = true;
    await seed(resource, otherScope);
    vi.spyOn(coordination, 'list').mockResolvedValueOnce([...coordination.records.values()]);
    const result = await request();
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain(token);
  });
});
