import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BusinessInformationStore,
  InMemoryBusinessInformationStore,
} from '../src/business-information/portable.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';

let http: Server;
let base: string;
let controlPlane: InMemoryControlPlaneStore;
let businessStore: InMemoryBusinessInformationStore;

function gate() {
  const identities: Record<string, { subject: string; email: string }> = {
    owner: { subject: 'owner-sub', email: 'owner@acme.test' },
    secondOwner: { subject: 'second-owner-sub', email: 'second-owner@acme.test' },
    operator: { subject: 'operator-sub', email: 'operator@acme.test' },
    viewer: { subject: 'viewer-sub', email: 'viewer@acme.test' },
    outsider: { subject: 'outsider-sub', email: 'outsider@example.test' },
  };
  return {
    authorize: (req: { headers: Record<string, unknown> }) => {
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      const identity = token === undefined ? undefined : identities[token];
      return Promise.resolve(
        identity === undefined
          ? { ok: false as const, status: 401, message: 'missing bearer token' }
          : { ok: true as const, identity: { ...identity, superAdmin: false } },
      );
    },
  };
}

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function startService(store: BusinessInformationStore = businessStore): Promise<void> {
  const options: ServiceOptions = {
    controlPlaneStore: controlPlane,
    deployGate: gate(),
    businessInformationStore: store,
  };
  http = createServer(
    createServiceHandler(new ServerRegistry(new InMemoryArtifactStore()), options),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}

async function stopService(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
}

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore();
  businessStore = new InMemoryBusinessInformationStore();
  await controlPlane.createOrg({ slug: 'acme' });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });
  await startService();
});

afterEach(async () => {
  await stopService();
});

async function install(): Promise<{ installationId: string; publicId: string }> {
  const response = await fetch(`${base}/v1/orgs/acme/solution-installations`, {
    method: 'POST',
    headers: headers('owner', { 'content-type': 'application/json' }),
    body: JSON.stringify({
      profileId: 'travel',
      appSlug: 'travel-desk',
      environment: 'prod',
      retentionDays: 30,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as {
    data: {
      installation: { id: string; publicId: string; currentRole: string };
    };
  };
  expect(body.data.installation.currentRole).toBe('administrator');
  return {
    installationId: body.data.installation.id,
    publicId: body.data.installation.publicId,
  };
}

async function grant(installationId: string, token: 'operator' | 'viewer'): Promise<void> {
  const response = await fetch(
    `${base}/v1/orgs/acme/solution-installations/${installationId}/grants`,
    {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        subject: `${token}-sub`,
        email: `${token}@acme.test`,
        role: token,
        expectedRevision: 0,
      }),
    },
  );
  expect(response.status).toBe(201);
}

describe('managed business information API', () => {
  it('publishes four data-driven profiles and installs one with an initial administrator grant', async () => {
    const catalog = await fetch(`${base}/v1/solutions/catalog`);
    expect(catalog.status).toBe(200);
    const catalogBody = (await catalog.json()) as { data: { profiles: Array<{ id: string }> } };
    expect(catalogBody.data.profiles.map((profile) => profile.id).sort()).toEqual([
      'b2b_saas',
      'ecommerce',
      'restaurant',
      'travel',
    ]);

    const { installationId } = await install();
    const grants = await fetch(
      `${base}/v1/orgs/acme/solution-installations/${installationId}/grants`,
      { headers: headers('owner') },
    );
    expect(grants.status).toBe(200);
    await expect(grants.json()).resolves.toMatchObject({
      data: { grants: [{ subject: 'owner-sub', email: 'owner@acme.test', role: 'administrator' }] },
    });
  });

  it('receives public intake and lets a granted operator handle the request', async () => {
    const { installationId, publicId } = await install();
    await grant(installationId, 'operator');

    const intake = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'browser-submit-1' },
      body: JSON.stringify({
        payload: { request_type: 'refund', summary: 'Please review my refund request.' },
      }),
    });
    expect(intake.status).toBe(201);
    const receipt = (await intake.json()) as { data: { recordId: string } };

    const list = await fetch(
      `${base}/v1/orgs/acme/solution-installations/${installationId}/collections/travel_requests/records`,
      { headers: headers('operator') },
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: {
        records: [
          {
            id: receipt.data.recordId,
            payload: { summary: 'Please review my refund request.' },
            status: 'new',
          },
        ],
      },
    });

    const update = await fetch(
      `${base}/v1/orgs/acme/solution-installations/${installationId}/collections/travel_requests/records/${receipt.data.recordId}`,
      {
        method: 'PATCH',
        headers: headers('operator', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          operation: 'set-status',
          expectedRevision: 1,
          status: 'in_progress',
        }),
      },
    );
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      data: { record: { revision: 2, status: 'in_progress' } },
    });
  });

  it('admits browser preflight for credential-free public intake', async () => {
    const { publicId } = await install();
    const response = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://customer.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
  });

  it('enforces business roles independently from organization membership', async () => {
    const { installationId, publicId } = await install();
    await grant(installationId, 'viewer');
    const created = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'browser-submit-2' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Please call me.' } }),
    });
    const recordId = ((await created.json()) as { data: { recordId: string } }).data.recordId;
    const recordPath =
      `${base}/v1/orgs/acme/solution-installations/${installationId}` +
      `/collections/travel_requests/records/${recordId}`;

    expect((await fetch(recordPath, { headers: headers('viewer') })).status).toBe(200);
    expect((await fetch(recordPath, { headers: headers('outsider') })).status).toBe(403);
    expect(
      (
        await fetch(recordPath, {
          method: 'PATCH',
          headers: headers('viewer', { 'content-type': 'application/json' }),
          body: JSON.stringify({ operation: 'add-note', expectedRevision: 1, note: 'Not allowed' }),
        })
      ).status,
    ).toBe(403);
  });

  it('returns the caller role with installation lists and details', async () => {
    const { installationId } = await install();
    await grant(installationId, 'viewer');

    const list = await fetch(`${base}/v1/orgs/acme/solution-installations`, {
      headers: headers('viewer'),
    });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: { installations: [{ id: installationId, currentRole: 'viewer' }] },
    });

    const detail = await fetch(`${base}/v1/orgs/acme/solution-installations/${installationId}`, {
      headers: headers('viewer'),
    });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: { installation: { id: installationId, currentRole: 'viewer' } },
    });
  });

  it('does not imply business access when a revoked administrator replays installation', async () => {
    await controlPlane.addOrgMember({
      org: 'acme',
      subject: 'second-owner-sub',
      email: 'second-owner@acme.test',
      role: 'owner',
    });
    const { installationId } = await install();
    const grantsUrl = `${base}/v1/orgs/acme/solution-installations/${installationId}/grants`;
    const grantSecondOwner = await fetch(grantsUrl, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        subject: 'second-owner-sub',
        email: 'second-owner@acme.test',
        role: 'administrator',
        expectedRevision: 0,
      }),
    });
    expect(grantSecondOwner.status).toBe(201);
    const revokeOriginalOwner = await fetch(`${grantsUrl}/owner-sub`, {
      method: 'DELETE',
      headers: headers('secondOwner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(revokeOriginalOwner.status).toBe(200);

    const replay = await fetch(`${base}/v1/orgs/acme/solution-installations`, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        profileId: 'travel',
        appSlug: 'travel-desk',
        environment: 'prod',
        retentionDays: 30,
      }),
    });
    expect(replay.status).toBe(403);
  });

  it('rejects prohibited public payloads before custody', async () => {
    const { publicId } = await install();
    const response = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'unsafe-submit' },
      body: JSON.stringify({
        payload: { request_type: 'service', summary: 'Help', api_key: 'secret' },
      }),
    });
    expect(response.status).toBe(400);
  });

  it('maps malformed cursors to a bounded client error', async () => {
    const { installationId } = await install();
    const response = await fetch(
      `${base}/v1/orgs/acme/solution-installations/${installationId}` +
        '/collections/travel_requests/records?cursor=not-a-cursor',
      { headers: headers('owner') },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'cursor is invalid',
      code: 'invalid_cursor',
    });
  });

  it('assigns records only to live operator grants', async () => {
    const { installationId, publicId } = await install();
    const created = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'assignment-record' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Assign this.' } }),
    });
    const recordId = ((await created.json()) as { data: { recordId: string } }).data.recordId;
    const recordPath =
      `${base}/v1/orgs/acme/solution-installations/${installationId}` +
      `/collections/travel_requests/records/${recordId}`;
    const assign = (subject: string, expectedRevision = 1) =>
      fetch(recordPath, {
        method: 'PATCH',
        headers: headers('owner', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          operation: 'assign',
          expectedRevision,
          assigneeSubject: subject,
        }),
      });

    expect((await assign('outsider-sub')).status).toBe(422);
    await grant(installationId, 'viewer');
    expect((await assign('viewer-sub')).status).toBe(422);
    await grant(installationId, 'operator');
    const assigned = await assign('operator-sub');
    expect(assigned.status).toBe(200);
    await expect(assigned.json()).resolves.toMatchObject({
      data: { record: { assigneeSubject: 'operator-sub', revision: 2 } },
    });
  });

  it('preserves a live administrator through grant mutations', async () => {
    const { installationId } = await install();
    const grantsUrl = `${base}/v1/orgs/acme/solution-installations/${installationId}/grants`;
    const demote = await fetch(grantsUrl, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        subject: 'owner-sub',
        email: 'owner@acme.test',
        role: 'manager',
        expectedRevision: 1,
      }),
    });
    expect(demote.status).toBe(409);
    await expect(demote.json()).resolves.toMatchObject({ code: 'last_administrator' });
  });

  it('bounds public intake with the shared admission counter port', async () => {
    const { publicId } = await install();
    const url = `${base}/v1/solution-intake/${publicId}/travel_requests/records`;
    for (let index = 0; index < 60; index += 1) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `bounded-intake-${index}`,
        },
        body: JSON.stringify({
          payload: { request_type: 'service', summary: `Request ${index}` },
        }),
      });
      expect(response.status).toBe(201);
    }
    const refused = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'bounded-intake-refused' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'One too many' } }),
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
  });

  it('redacts infrastructure failures from public responses', async () => {
    const { publicId } = await install();
    await stopService();
    const failingStore = new Proxy(businessStore, {
      get(target, property) {
        if (property === 'createRequest') {
          return () => Promise.reject(new Error('database password leaked'));
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await startService(failingStore);

    const response = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'failing-intake' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Do not leak.' } }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'internal error' });
  });
});
