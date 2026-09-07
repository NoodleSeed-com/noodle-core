import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { noopLogger, sendJson } from '@noodle-borg/transport-http';
import {
  ApplicationActivityListResponseSchema,
  ApplicationActivitySettingsResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActivityHistoryAllowance, ApplicationActivity } from '../src/application-activity.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';
import { dispatchBusinessInformationRoutes } from '../src/routes/business-information-dispatch.js';

const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
const otherScope = { org: 'acme', app: 'other', env: 'prod', installationId: 'other-prod' };
const now = Date.parse('2026-09-06T12:00:00Z');
let http: Server;
let base: string;
let records: InMemoryBusinessInformationStore;
let evidence: InMemoryOperationEvidenceStore;
let allowance: ActivityHistoryAllowance | undefined = {
  maximumDays: 30,
  defaultDays: 30,
  revision: 'standard-v1',
};

beforeEach(async () => {
  records = new InMemoryBusinessInformationStore();
  evidence = new InMemoryOperationEvidenceStore();
  allowance = { maximumDays: 30, defaultDays: 30, revision: 'standard-v1' };
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@example.com' },
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'member',
    email: 'member@example.com',
    role: 'owner',
  });
  for (const target of [scope, otherScope]) {
    await records.createInstallation({
      scope: target,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
      actorEmail: 'owner@example.com',
    });
    await records.setGrant({
      scope: target,
      subject: 'viewer',
      email: 'viewer@example.com',
      role: 'viewer',
      expectedRevision: 0,
      actorSubject: 'owner',
    });
    for (const role of ['manager', 'operator'] as const)
      await records.setGrant({
        scope: target,
        subject: role,
        email: `${role}@example.com`,
        role,
        expectedRevision: 0,
        actorSubject: 'owner',
      });
  }
  const activity = new ApplicationActivity({
    store: evidence,
    epoch: 'activity-http-epoch',
    identityKey: 'activity-http-fixture-key-over-thirty-two-characters',
    now: () => now,
    allowance: async () => allowance,
  });
  http = createServer((req, res) => {
    const handled = dispatchBusinessInformationRoutes(
      req,
      res,
      new URL(req.url ?? '/', 'http://localhost'),
      {
        store: records,
        activity,
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
            const subject = /^Bearer (owner|viewer|member|manager|operator)$/.exec(
              String(request.headers.authorization ?? ''),
            )?.[1];
            return subject === undefined
              ? { ok: false, status: 401, message: 'Authentication required' }
              : {
                  ok: true,
                  identity: { subject, email: `${subject}@example.com`, superAdmin: false },
                };
          },
        },
      },
    );
    if (!handled) sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/orgs/acme/solution-installations`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});
function get(path: string, subject = 'owner') {
  return fetch(`${base}/${path}`, { headers: { authorization: `Bearer ${subject}` } });
}
function patch(body: unknown, subject = 'owner') {
  return fetch(`${base}/travel-prod/activity/settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${subject}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function seed(id: string, target = scope, ageDays = 0) {
  await evidence.claim({
    scope: target,
    id: id.repeat(64),
    lease: 'private-lease',
    epoch: 'private-epoch',
    deploymentId: 'private-deployment',
    tool: 'submit_request',
    connector: 'records',
    operation: 'submit',
    connectionId: 'account',
    generation: 'private-generation',
    actorDigest: 'private-actor-digest',
    intentDigest: 'private-intent-digest',
    startedAt: now - 1000 - ageDays * 86400000,
    executionDeadline: now,
    completedAt: now - 500 - ageDays * 86400000,
    historyExpiresAt: now + 86400000,
    outcome: 'completed',
    reference: 'receipt-reference',
  });
}

describe('application Activity HTTP projection', () => {
  it('requires live business read grants, not organization ownership, and emits a private payload-free projection', async () => {
    await seed('a');
    expect((await get('travel-prod/activity', 'member')).status).toBe(403);
    expect((await get('travel-prod/activity', 'missing')).status).toBe(401);
    const response = await get('travel-prod/activity', 'viewer');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = ApplicationActivityListResponseSchema.parse(await response.json());
    expect(body.data.activities).toEqual([
      {
        id: 'a'.repeat(64),
        tool: 'submit_request',
        operation: 'submit',
        connectionId: 'account',
        actorReference: expect.stringMatching(/^[a-f0-9]{64}$/),
        outcome: 'completed',
        startedAt: new Date(now - 1000).toISOString(),
        completedAt: new Date(now - 500).toISOString(),
        reference: 'receipt-reference',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('private-');
    await records.revokeGrant({
      scope,
      subject: 'viewer',
      actorSubject: 'owner',
      expectedRevision: 1,
    });
    expect((await get('travel-prod/activity', 'viewer')).status).toBe(403);
  });
  it('exposes read-only settings to viewers and requires administrator authority, tier limits and exact CAS for changes', async () => {
    const viewer = ApplicationActivitySettingsResponseSchema.parse(
      await (await get('travel-prod/activity/settings', 'viewer')).json(),
    ).data;
    expect(viewer.canEdit).toBe(false);
    expect(
      (await patch({ expectedRevision: viewer.revision, retentionDays: 7 }, 'viewer')).status,
    ).toBe(403);
    expect((await patch({ expectedRevision: viewer.revision, retentionDays: 31 })).status).toBe(
      400,
    );
    const result = await patch({ expectedRevision: viewer.revision, retentionDays: 7 });
    expect(result.status).toBe(200);
    const saved = ApplicationActivitySettingsResponseSchema.parse(await result.json()).data;
    expect(saved).toMatchObject({ retentionDays: 7, maximumDays: 30, canEdit: true });
    expect((await patch({ expectedRevision: viewer.revision, retentionDays: 8 })).status).toBe(409);
    allowance = { maximumDays: 7, defaultDays: 7, revision: 'free-v2' };
    expect((await patch({ expectedRevision: saved.revision, retentionDays: 7 })).status).toBe(409);
    const current = ApplicationActivitySettingsResponseSchema.parse(
      await (await get('travel-prod/activity/settings')).json(),
    ).data;
    expect(current.maximumDays).toBe(7);
  });
  it('pages equal timestamps without skipping and rejects reuse across installation, page size or policy', async () => {
    await Promise.all(['a', 'b', 'c'].map((id) => seed(id)));
    await seed('d', otherScope);
    const first = ApplicationActivityListResponseSchema.parse(
      await (await get('travel-prod/activity?limit=1')).json(),
    ).data;
    expect(first.activities.map((entry) => entry.id)).toEqual(['a'.repeat(64)]);
    expect(first.nextCursor).toBeDefined();
    const cursor = encodeURIComponent(first.nextCursor ?? '');
    expect((await get(`other-prod/activity?limit=1&cursor=${cursor}`)).status).toBe(400);
    expect((await get(`travel-prod/activity?limit=2&cursor=${cursor}`)).status).toBe(400);
    const second = ApplicationActivityListResponseSchema.parse(
      await (await get(`travel-prod/activity?limit=1&cursor=${cursor}`)).json(),
    ).data;
    expect(second.activities.map((entry) => entry.id)).toEqual(['b'.repeat(64)]);
    const third = ApplicationActivityListResponseSchema.parse(
      await (
        await get(
          `travel-prod/activity?limit=1&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
        )
      ).json(),
    ).data;
    expect(third.activities.map((entry) => entry.id)).toEqual(['c'.repeat(64)]);
    expect(third.nextCursor).toBeUndefined();
    allowance = { maximumDays: 7, defaultDays: 7, revision: 'free-v2' };
    expect((await get(`travel-prod/activity?limit=1&cursor=${cursor}`)).status).toBe(400);
  });
  it.each([
    'activity?limit=101',
    'activity?limit=0',
    'activity?cursor=forged',
    'activity?tool=unsupported',
    'activity?limit=1&limit=2',
  ])('rejects unsupported query or invalid paging: %s', async (path) => {
    expect((await get(`travel-prod/${path}`)).status).toBe(400);
  });
  it('scopes opaque actor references to each installation and organization without raw identity evidence', async () => {
    const foreign = { ...scope, org: 'foreign' };
    await records.createInstallation({
      scope: foreign,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
      actorEmail: 'owner@example.com',
    });
    const references = [];
    for (const target of [scope, otherScope, foreign]) {
      await seed('a', target);
      const response = await fetch(
        `${base.replace('/orgs/acme/', `/orgs/${target.org}/`)}/${target.installationId}/activity`,
        { headers: { authorization: 'Bearer owner' } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      references.push(body.data.activities[0].actorReference);
      expect(body.data.activities[0].actorReference).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(body)).not.toMatch(
        /private-|actorDigest|lease|generation|@example|caller|intentDigest/,
      );
    }
    expect(new Set(references).size).toBe(3);
    expect(
      (await (await get('travel-prod/activity')).json()).data.activities[0].actorReference,
    ).toBe(references[0]);
  });
  it('exports one bounded page for administrators and managers; other roles cannot download', async () => {
    await Promise.all(['a', 'b', 'c'].map((id) => seed(id)));
    for (const subject of ['operator', 'viewer', 'member'])
      expect((await get('travel-prod/activity/export', subject)).status).toBe(403);
    for (const subject of ['owner', 'manager']) {
      const response = await get('travel-prod/activity/export?limit=2', subject);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await response.json();
      expect(body.data.activities).toHaveLength(2);
      expect(body.data.nextCursor).toBeDefined();
      expect(body.data.activities[0]).toMatchObject({
        actorReference: expect.stringMatching(/^[a-f0-9]{64}$/),
        connectionId: 'account',
      });
      expect(JSON.stringify(body)).not.toMatch(
        /private-|actorDigest|lease|generation|caller|intentDigest/,
      );
    }
    for (const query of ['limit=101', 'limit=0', 'limit=1&limit=2', 'cursor=forged', 'format=raw'])
      expect((await get(`travel-prod/activity/export?${query}`)).status).toBe(400);
  });
  it('binds export cursors to purpose, tenant and current policy and rechecks each download grant', async () => {
    await Promise.all(['a', 'b', 'c'].map((id) => seed(id)));
    const first = await (await get('travel-prod/activity/export?limit=1', 'manager')).json();
    const cursor = encodeURIComponent(first.data.nextCursor);
    expect((await get(`travel-prod/activity?limit=1&cursor=${cursor}`)).status).toBe(400);
    expect((await get(`other-prod/activity/export?limit=1&cursor=${cursor}`)).status).toBe(400);
    const list = await (await get('travel-prod/activity?limit=1')).json();
    expect(
      (
        await get(
          `travel-prod/activity/export?limit=1&cursor=${encodeURIComponent(list.data.nextCursor)}`,
        )
      ).status,
    ).toBe(400);
    const next = await (
      await get(`travel-prod/activity/export?limit=1&cursor=${cursor}`, 'manager')
    ).json();
    expect(next.data.activities[0].id).toBe('b'.repeat(64));
    await records.revokeGrant({
      scope,
      subject: 'manager',
      actorSubject: 'owner',
      expectedRevision: 1,
    });
    expect(
      (await get(`travel-prod/activity/export?limit=1&cursor=${cursor}`, 'manager')).status,
    ).toBe(403);
    allowance = { maximumDays: 7, defaultDays: 7, revision: 'free-v2' };
    expect((await get(`travel-prod/activity/export?limit=1&cursor=${cursor}`)).status).toBe(400);
    allowance = undefined;
    expect((await get('travel-prod/activity/export')).status).toBe(503);
  });
  it('rechecks the live export grant when a query finishes after access was revoked', async () => {
    await seed('a');
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const list = evidence.list.bind(evidence);
    vi.spyOn(evidence, 'list').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await released.promise;
      return list(...args);
    });
    const pending = get('travel-prod/activity/export', 'manager');
    await entered.promise;
    await records.revokeGrant({
      scope,
      subject: 'manager',
      actorSubject: 'owner',
      expectedRevision: 1,
    });
    released.resolve();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toMatch(/actorReference|calendar|private-/);
  });
  it('refuses an export whose verified plan changes while its query is in progress', async () => {
    await seed('a');
    const list = evidence.list.bind(evidence);
    vi.spyOn(evidence, 'list').mockImplementationOnce(async (...args) => {
      const page = await list(...args);
      allowance = { maximumDays: 7, defaultDays: 7, revision: 'downgraded' };
      return page;
    });
    const response = await get('travel-prod/activity/export');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'activity_conflict' });
  });
  it('requires business read grants and accepts no client assumptions for impact previews', async () => {
    expect((await get('travel-prod/activity/preview', 'member')).status).toBe(403);
    const response = await get('travel-prod/activity/preview', 'viewer');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      ok: true,
      data: { state: 'unavailable', reason: 'no_verified_paid_period' },
    });
    for (const query of ['effectiveAt=2027-01-01', 'maximumDays=7', 'cursor=forged'])
      expect((await get(`travel-prod/activity/preview?${query}`)).status).toBe(400);
  });
  it('uses the active history window for new downloads without rewriting physical expiry', async () => {
    await seed('a', scope, 15);
    const originalExpiry = (await evidence.list(scope, now, 30, 1))[0]?.historyExpiresAt;
    expect((await (await get('travel-prod/activity/export')).json()).data.activities).toHaveLength(
      1,
    );
    allowance = { maximumDays: 7, defaultDays: 7, revision: 'free-v2' };
    expect((await (await get('travel-prod/activity/export')).json()).data.activities).toHaveLength(
      0,
    );
    expect((await evidence.list(scope, now, 30, 1))[0]?.historyExpiresAt).toBe(originalExpiry);
    allowance = { maximumDays: 30, defaultDays: 30, revision: 'pro-v2' };
    expect((await (await get('travel-prod/activity/export')).json()).data.activities).toHaveLength(
      1,
    );
    expect(await evidence.list(scope, now + 86400000, 30, 1)).toHaveLength(0);
  });
  it.each([
    'settings/settings',
    'channels/settings',
    'activity/settings/settings',
  ])('does not route unintended settings aliases: %s', async (path) => {
    expect((await get(`travel-prod/${path}`)).status).toBe(404);
  });
});
