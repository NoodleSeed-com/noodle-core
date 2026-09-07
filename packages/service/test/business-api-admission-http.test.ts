import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { counterRow, InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessApiCounter } from '../src/business-api-admission.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

let server: Server;
let base: string;
let counters: InMemoryDailyCounterStore;
let installationId: string;
let records: string;
const now = new Date('2026-09-07T10:20:15Z');
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  key?: string,
  subject = 'owner',
) {
  return fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${subject}`,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function fill(
  bucket: 'subject' | 'org' | 'installation',
  lane: 'mutation' | 'read' = 'mutation',
) {
  const request = businessApiCounter(
    lane,
    bucket,
    bucket === 'subject' ? 'owner' : bucket === 'org' ? 'acme' : ['acme', installationId],
  );
  await counters.consume(
    {
      ...request,
      amount: request.limit - ((await counters.peek(counterRow(request, now).key, now)) ?? 0),
    },
    now,
  );
}
async function used(bucket: 'subject' | 'org' | 'installation', subject = 'owner') {
  const request = businessApiCounter(
    'mutation',
    bucket,
    bucket === 'subject' ? subject : bucket === 'org' ? 'acme' : ['acme', installationId],
  );
  return (await counters.peek(counterRow(request, now).key, now)) ?? 0;
}
beforeEach(async () => {
  counters = new InMemoryDailyCounterStore();
  const store = new InMemoryBusinessInformationStore();
  const cp = new InMemoryControlPlaneStore();
  await cp.createOrg({ slug: 'acme' });
  await cp.addOrgMember({
    org: 'acme',
    subject: 'owner',
    role: 'owner',
    email: 'owner@example.test',
  });
  server = createServer(
    createServiceHandler(new ServerRegistry(new InMemoryArtifactStore()), {
      controlPlaneStore: cp,
      businessInformationStore: store,
      admissionCounters: counters,
      clock: () => now,
      deployGate: {
        authorize: async (req) => ({
          ok: true,
          identity: {
            subject: String(req.headers.authorization).replace('Bearer ', ''),
            email: 'owner@example.test',
            superAdmin: false,
          },
        }),
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const install = await request('/v1/orgs/acme/solution-installations', 'POST', {
    definition: { kind: 'managed', profileId: 'travel' },
    appSlug: 'travel',
    environment: 'prod',
    retentionDays: 30,
  });
  expect(install.status, await install.clone().text()).toBe(201);
  const result = await install.json();
  installationId = result.data.installation.id;
  records = `/v1/orgs/acme/solution-installations/${installationId}/collections/travel_requests/records`;
  const installation = await store.getInstallationById('acme', installationId);
  if (!installation) throw new Error('missing fixture installation');
  await store.setGrant({
    scope: installation.scope,
    subject: 'viewer',
    email: 'viewer@example.test',
    role: 'viewer',
    expectedRevision: 0,
    actorSubject: 'owner',
  });
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
describe('business API limits through the actual HTTP dispatcher', () => {
  it('preserves completed/conflicting receipts, export, deletion and pause after mutation exhaustion', async () => {
    const payload = { request_type: 'service', summary: 'Need assistance' };
    const created = await request(records, 'POST', { payload }, 'receipt');
    expect(created.status, await created.clone().text()).toBe(201);
    const record = (await created.json()).data.record;
    for (const bucket of ['subject', 'org', 'installation'] as const) await fill(bucket);
    expect((await request(records, 'POST', { payload }, 'receipt')).status).toBe(200);
    expect(
      (await request(records, 'POST', { payload: { ...payload, summary: 'Different' } }, 'receipt'))
        .status,
    ).toBe(409);
    const denied = await request(records, 'POST', { payload }, 'new');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('45');
    expect(await denied.json()).toMatchObject({
      code: 'business_api_rate_limited',
      resetAt: '2026-09-07T10:21:00.000Z',
    });
    expect((await request(records)).status).toBe(200);
    await fill('subject', 'read');
    expect((await request(records)).status).toBe(429);
    expect((await request(`${records}/export`)).status).toBe(200);
    expect(
      (await request(`${records}/${record.id}`, 'DELETE', { expectedRevision: record.revision }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(`/v1/orgs/acme/solution-installations/${installationId}`, 'PATCH', {
          active: false,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
  });
  it('charges outsider/viewer attempts only to their own subject and does not charge target mutations or invalid payload creation', async () => {
    const orgBefore = await used('org');
    const installationBefore = await used('installation');
    for (const subject of ['outsider', 'viewer']) {
      const result = await request(
        `${records}/unknown`,
        'PATCH',
        { operation: 'update', expectedRevision: 1, patch: { summary: 'forgery' } },
        undefined,
        subject,
      );
      expect(result.status).toBe(403);
      expect(await used('subject', subject)).toBe(1);
    }
    expect(await used('org')).toBe(orgBefore);
    expect(await used('installation')).toBe(installationBefore);
    const before = await used('subject');
    expect((await request(records, 'POST', { payload: { summary: 42 } }, 'invalid')).status).toBe(
      400,
    );
    expect(await used('subject')).toBe(before);
  });
  it('fails closed on counter outage with a value-free response', async () => {
    vi.spyOn(counters, 'consumeAll').mockRejectedValue(new Error('private backend body'));
    const response = await request(records);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'business_api_admission_unavailable',
      error: 'Business API admission is temporarily unavailable. Retry later.',
    });
  });
});
