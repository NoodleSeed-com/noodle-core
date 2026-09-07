import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BusinessInformationStore,
  InMemoryBusinessInformationStore,
} from '../src/business-information/portable.js';
import { builtInDefinitionAtRelease } from '../src/business-information/profiles.js';
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
let registry: ServerRegistry;

function gate() {
  const identities: Record<string, { subject: string; email: string }> = {
    owner: { subject: 'owner-sub', email: 'owner@acme.test' },
    secondOwner: { subject: 'second-owner-sub', email: 'second-owner@acme.test' },
    operator: { subject: 'operator-sub', email: 'operator@acme.test' },
    viewer: { subject: 'viewer-sub', email: 'viewer@acme.test' },
    invitee: { subject: 'invitee-sub', email: 'invitee@example.test' },
    wrongInvitee: { subject: 'wrong-invitee-sub', email: 'wrong@example.test' },
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

async function startService(
  store: BusinessInformationStore = businessStore,
  overrides: Partial<ServiceOptions> = {},
): Promise<void> {
  const options: ServiceOptions = {
    controlPlaneStore: controlPlane,
    deployGate: gate(),
    businessInformationStore: store,
    ...overrides,
  };
  http = createServer(createServiceHandler(registry, options));
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
  registry = new ServerRegistry(new InMemoryArtifactStore());
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
      definition: { kind: 'managed', profileId: 'travel' },
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
  it('archives intake without erasing custody, and restoring the app requires explicit intake resume', async () => {
    const { installationId, publicId } = await install();
    const installationUrl = `${base}/v1/orgs/acme/solution-installations/${installationId}`;
    const recordsUrl = `${installationUrl}/collections/travel_requests/records`;
    const publicUrl = `${base}/v1/solution-intake/${publicId}/travel_requests/records`;
    const create = (key: string) =>
      fetch(publicUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          payload: { request_type: 'service', summary: 'Retained after archive' },
        }),
      });
    expect((await create('before-archive')).status).toBe(201);
    expect(
      (
        await fetch(`${base}/v1/orgs/acme/apps/travel-desk/archive`, {
          method: 'POST',
          headers: headers('owner'),
        })
      ).status,
    ).toBe(200);
    const detail = await (await fetch(installationUrl, { headers: headers('owner') })).json();
    expect(detail.data.installation).toMatchObject({ active: false, revision: 2 });
    expect((await create('after-archive')).status).toBe(503);
    expect((await create('before-archive')).status).toBe(200);
    const retained = await (await fetch(recordsUrl, { headers: headers('owner') })).json();
    expect(retained.data.records).toHaveLength(1);
    const resume = () =>
      fetch(installationUrl, {
        method: 'PATCH',
        headers: headers('owner', { 'content-type': 'application/json' }),
        body: JSON.stringify({ active: true, expectedRevision: 2 }),
      });
    expect((await resume()).status).toBe(409);
    expect(
      (
        await fetch(`${base}/v1/orgs/acme/apps/travel-desk/restore`, {
          method: 'POST',
          headers: headers('owner'),
        })
      ).status,
    ).toBe(200);
    expect((await create('after-restore')).status).toBe(503);
    expect((await resume()).status).toBe(200);
    expect((await create('after-explicit-resume')).status).toBe(201);
  });

  it('proves the candidate reader floor from the authenticated accepted-schema inventory', async () => {
    expect((await fetch(`${base}/v1/service/business-information-reader-floor`)).status).toBe(401);
    const before = await fetch(`${base}/v1/service/business-information-reader-floor`, {
      headers: headers('owner'),
    });
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      ok: true,
      inventory: { acceptedSchemaIdentities: 0, digest: expect.stringMatching(/^sha256:/) },
    });

    const { publicId } = await install();
    const intake = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'reader-floor-record' },
      body: JSON.stringify({
        payload: { request_type: 'service', summary: 'Reader floor private content.' },
      }),
    });
    expect(intake.status).toBe(201);
    const after = await fetch(`${base}/v1/service/business-information-reader-floor`, {
      headers: headers('owner'),
    });
    const body = await after.json();
    expect(after.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      inventory: { acceptedSchemaIdentities: 1, digest: expect.stringMatching(/^sha256:/) },
      readerTargets: 3,
    });
    expect(JSON.stringify(body)).not.toContain('Reader floor private content.');
    expect(JSON.stringify(body)).not.toContain('acme');
  });

  it('projects the same central release for installations created before and after it', async () => {
    await stopService();
    let stableRelease = 1;
    businessStore = new InMemoryBusinessInformationStore({
      managedDefinition: (key) => builtInDefinitionAtRelease(key, stableRelease),
    });
    const oldScope = {
      org: 'acme',
      app: 'travel-before',
      env: 'prod',
      installationId: 'travel-before-prod',
    };
    const old = await businessStore.createInstallation({
      scope: oldScope,
      definition: builtInDefinitionAtRelease('travel', 1),
      managedCollections: ['travel_requests'],
      retentionDays: 90,
      actorSubject: 'owner-sub',
      actorEmail: 'owner@acme.test',
    });
    if (old.disposition !== 'created') throw new Error('old installation was not created');
    const accepted = await businessStore.createRequest({
      scope: oldScope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'release-1-record',
      payload: {
        request_type: 'refund',
        summary: 'Accepted before the central update.',
        booking_reference: 'KEEP-OLD-FIELD',
      },
      origin: { kind: 'embedded' },
      actorSubject: 'visitor',
    });
    if (accepted.disposition !== 'created') throw new Error('historical record missing');
    const recordId = accepted.record.id;
    await startService();
    await businessStore.setIntakeState({
      scope: oldScope,
      expectedRevision: 1,
      active: false,
      actorSubject: 'owner-sub',
    });

    stableRelease = 3;
    const before = await fetch(
      `${base}/v1/orgs/acme/solution-installations/${oldScope.installationId}`,
      { headers: headers('owner') },
    );
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      data: {
        installation: {
          publicId: old.installation.publicId,
          active: false,
          revision: 2,
          retentionDays: 90,
          definition: { kind: 'managed', definitionId: 'travel', release: 3 },
          collections: [{ key: 'travel_requests', schemaVersion: 3 }],
        },
      },
    });

    const recordUrl =
      `${base}/v1/orgs/acme/solution-installations/${oldScope.installationId}` +
      `/collections/travel_requests/records/${recordId}`;
    const preserved = await fetch(recordUrl, { headers: headers('owner') });
    expect(preserved.status).toBe(200);
    const detail = await preserved.json();
    expect(detail).toMatchObject({
      data: {
        record: { schemaVersion: 1, payload: { summary: 'Accepted before the central update.' } },
        collection: {
          key: 'travel_requests',
          schemaVersion: 1,
          schemaDigest: builtInDefinitionAtRelease('travel', 1).collections[0]?.schemaDigest,
          recordSchema: builtInDefinitionAtRelease('travel', 1).collections[0]?.recordSchema,
          management: { assignment: true, notes: true },
        },
      },
    });
    expect(detail.data.collection.recordSchema.properties).not.toHaveProperty('priority');
    expect(detail.data.collection.recordSchema.properties).not.toHaveProperty('status');
    expect(detail.data.collection.editableFields).not.toContain('priority');
    expect(detail.data.collection.editableFields).not.toContain('status');
    const compatibleUpdate = await fetch(recordUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        operation: 'update',
        expectedRevision: 1,
        patch: { summary: 'Updated after the central release.' },
      }),
    });
    expect(compatibleUpdate.status).toBe(200);
    await expect(compatibleUpdate.json()).resolves.toMatchObject({
      data: {
        record: {
          schemaVersion: 1,
          revision: 2,
          payload: {
            summary: 'Updated after the central release.',
            booking_reference: 'KEEP-OLD-FIELD',
          },
        },
      },
    });
    const wrongSchemaUpdate = await fetch(recordUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        operation: 'update',
        expectedRevision: 2,
        patch: { priority: 'urgent' },
      }),
    });
    expect(wrongSchemaUpdate.status).toBe(400);
    await grant(oldScope.installationId, 'operator');
    const migrate = (token: string, expectedRevision: number) =>
      fetch(recordUrl, {
        method: 'PATCH',
        headers: headers(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ operation: 'migrate-schema', expectedRevision }),
      });
    expect((await migrate('operator', 2)).status).toBe(403);
    expect((await migrate('owner', 1)).status).toBe(409);
    const migrated = await migrate('owner', 2);
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({
      data: {
        record: {
          schemaVersion: 3,
          revision: 3,
          payload: { status: 'new', summary: 'Updated after the central release.' },
        },
      },
    });
    const activity = await fetch(`${recordUrl}/activity`, { headers: headers('owner') });
    expect(await activity.json()).toMatchObject({
      data: {
        activities: expect.arrayContaining([
          {
            id: expect.any(String),
            recordId,
            revision: 3,
            operation: 'schema-migrated',
            createdAt: expect.any(String),
            actorSubject: 'owner-sub',
          },
        ]),
      },
    });

    const { installationId } = await install();
    const after = await fetch(`${base}/v1/orgs/acme/solution-installations/${installationId}`, {
      headers: headers('owner'),
    });
    expect(after.status).toBe(200);
    await expect(after.json()).resolves.toMatchObject({
      data: {
        installation: {
          active: true,
          revision: 1,
          definition: { kind: 'managed', definitionId: 'travel', release: 3 },
          collections: [{ key: 'travel_requests', schemaVersion: 3 }],
        },
      },
    });
  });

  it('publishes the three managed verticals and installs one with an initial administrator grant', async () => {
    const catalog = await fetch(`${base}/v1/solutions/catalog`);
    expect(catalog.status).toBe(200);
    const catalogBody = (await catalog.json()) as { data: { profiles: Array<{ id: string }> } };
    expect(catalogBody.data.profiles.map((profile) => profile.id).sort()).toEqual([
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

  it('rejects anonymous staff fields before idempotency probing or admission', async () => {
    const { publicId } = await install();
    const submit = (payload: unknown) =>
      fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'public-fields' },
        body: JSON.stringify({ payload }),
      });
    const forbidden = await submit({
      request_type: 'refund',
      summary: 'Public request',
      status: 'closed',
    });
    expect(forbidden.status).toBe(400);
    expect(await forbidden.json()).toMatchObject({ code: 'prohibited_field' });
    const accepted = await submit({ request_type: 'refund', summary: 'Public request' });
    expect(accepted.status).toBe(201);
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
            payload: { summary: 'Please review my refund request.', status: 'new' },
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
          operation: 'update',
          expectedRevision: 1,
          patch: { status: 'in_progress' },
        }),
      },
    );
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      data: { record: { revision: 2, payload: { status: 'in_progress' } } },
    });
  });

  it('exposes only the first enabled native collection through an installation public id', async () => {
    const nativeCollection = (key: string) => ({
      key,
      title: key,
      singularTitle: key,
      description: `${key} records.`,
      schemaVersion: 1,
      schemaDigest: 'a'.repeat(64),
      recordSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      summaryFields: ['value'],
      authority: { authority: 'native' as const },
    });
    const created = await businessStore.createInstallation({
      scope: { org: 'acme', app: 'private-app', env: 'prod', installationId: 'private-app' },
      definition: {
        reference: {
          kind: 'private',
          publisherOrg: 'acme',
          app: 'private-app',
          env: 'prod',
          deploymentId: 'dep-private',
          version: '1.0.0',
          digest: 'b'.repeat(64),
        },
        title: 'Private application',
        description: 'A private application with internal business data.',
        collections: [nativeCollection('public_requests'), nativeCollection('internal_notes')],
      },
      managedCollections: ['public_requests', 'internal_notes'],
      retentionDays: 30,
      actorSubject: 'owner-sub',
    });
    const response = await fetch(
      `${base}/v1/solution-intake/${created.installation.publicId}/internal_notes/records`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'guessed-collection' },
        body: JSON.stringify({ payload: { value: 'must remain private' } }),
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'public intake unavailable' });
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

  it('lets only an administrator pause and resume public intake without blocking staff custody', async () => {
    const { installationId, publicId } = await install();
    await grant(installationId, 'viewer');
    const publicUrl = `${base}/v1/solution-intake/${publicId}/travel_requests/records`;
    const before = await fetch(publicUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'before-intake-pause' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Keep my receipt.' } }),
    });
    expect(before.status).toBe(201);

    const installationUrl = `${base}/v1/orgs/acme/solution-installations/${installationId}`;
    const viewerPause = await fetch(installationUrl, {
      method: 'PATCH',
      headers: headers('viewer', { 'content-type': 'application/json' }),
      body: JSON.stringify({ active: false, expectedRevision: 1 }),
    });
    expect(viewerPause.status).toBe(403);
    const paused = await fetch(installationUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ active: false, expectedRevision: 1 }),
    });
    expect(paused.status).toBe(200);
    await expect(paused.json()).resolves.toMatchObject({
      data: { installation: { active: false, revision: 2 } },
    });
    expect((await fetch(`${base}/v1/solution-intake/${publicId}`)).status).toBe(503);
    const receiptReplay = await fetch(publicUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'before-intake-pause' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Keep my receipt.' } }),
    });
    expect(receiptReplay.status).toBe(200);
    const denied = await fetch(publicUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'after-intake-pause' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Must be refused.' } }),
    });
    expect(denied.status).toBe(503);
    await expect(denied.json()).resolves.toEqual({
      error: 'public intake is paused',
      code: 'intake_paused',
    });

    const recordsUrl = `${installationUrl}/collections/travel_requests/records`;
    const staffCreated = await fetch(recordsUrl, {
      method: 'POST',
      headers: headers('owner', {
        'content-type': 'application/json',
        'idempotency-key': 'staff-while-paused',
      }),
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Staff entry.' } }),
    });
    expect(staffCreated.status).toBe(201);

    const staleResume = await fetch(installationUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ active: true, expectedRevision: 1 }),
    });
    expect(staleResume.status).toBe(409);
    const resumed = await fetch(installationUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ active: true, expectedRevision: 2 }),
    });
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      data: { installation: { active: true, revision: 3 } },
    });
    const accepted = await fetch(publicUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'after-intake-resume' },
      body: JSON.stringify({ payload: { request_type: 'service', summary: 'Accepted again.' } }),
    });
    expect(accepted.status).toBe(201);
  });

  it('supports a fleet intake kill switch without disabling authenticated record work', async () => {
    const { installationId, publicId } = await install();
    await stopService();
    await startService(businessStore, { businessInformationPublicIntakeEnabled: false });
    const publicRoot = await fetch(`${base}/v1/solution-intake/${publicId}`);
    expect(publicRoot.status).toBe(503);
    await expect(publicRoot.json()).resolves.toEqual({
      error: 'public intake is temporarily disabled',
      code: 'intake_disabled',
    });
    const staffCreated = await fetch(
      `${base}/v1/orgs/acme/solution-installations/${installationId}` +
        '/collections/travel_requests/records',
      {
        method: 'POST',
        headers: headers('owner', {
          'content-type': 'application/json',
          'idempotency-key': 'staff-during-intake-incident',
        }),
        body: JSON.stringify({
          payload: { request_type: 'service', summary: 'Keep operating during intake incident.' },
        }),
      },
    );
    expect(staffCreated.status).toBe(201);
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
        definition: { kind: 'managed', profileId: 'travel' },
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

  it('validates declared payload queries at the operator API boundary', async () => {
    const { installationId, publicId } = await install();
    await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'query-record' },
      body: JSON.stringify({ payload: { request_type: 'refund', summary: 'Query this record' } }),
    });
    const url = new URL(
      `${base}/v1/orgs/acme/solution-installations/${installationId}/collections/travel_requests/records`,
    );
    url.searchParams.set('filters', JSON.stringify([{ field: 'status', value: 'new' }]));
    url.searchParams.set('sortField', 'status');
    const valid = await fetch(url, { headers: headers('owner') });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      data: { records: [{ payload: { status: 'new' } }] },
    });
    url.searchParams.set(
      'filters',
      JSON.stringify([{ field: 'summary', value: 'Query this record' }]),
    );
    const invalid = await fetch(url, { headers: headers('owner') });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_query' });
    url.searchParams.set('filters', 'not-json');
    expect((await fetch(url, { headers: headers('owner') })).status).toBe(400);
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

  it('invites business-only staff who claim and discover one installation', async () => {
    const { installationId } = await install();
    const token = 'a'.repeat(43);
    const invitationPath = `${base}/v1/orgs/acme/solution-installations/${installationId}/invitations`;
    const createBody = {
      email: 'invitee@example.test',
      role: 'operator',
      token,
      idempotencyKey: 'invitee-1',
      expiresInHours: 24,
    };
    const created = await fetch(invitationPath, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      data: {
        invitation: {
          installationId,
          email: 'invitee@example.test',
          status: 'pending',
          revision: 1,
        },
        acceptPath: `/portal-invitations/${token}`,
        replayed: false,
      },
    });
    const replayed = await fetch(invitationPath, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify(createBody),
    });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({ data: { replayed: true } });
    const acceptPath = `${base}/v1/solution-invitations/${token}/accept`;
    expect(
      (
        await fetch(acceptPath, {
          method: 'POST',
          headers: headers('wrongInvitee'),
        })
      ).status,
    ).toBe(403);
    const accepted = await fetch(acceptPath, {
      method: 'POST',
      headers: headers('invitee'),
    });
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      data: {
        installation: { id: installationId, currentRole: 'operator' },
        grant: { subject: 'invitee-sub', role: 'operator' },
      },
    });
    expect((await fetch(acceptPath, { method: 'POST', headers: headers('invitee') })).status).toBe(
      410,
    );
    const discovered = await fetch(`${base}/v1/me/solution-installations`, {
      headers: headers('invitee'),
    });
    expect(discovered.status).toBe(200);
    await expect(discovered.json()).resolves.toMatchObject({
      data: { installations: [{ id: installationId, currentRole: 'operator' }] },
    });
    await expect(controlPlane.getOrgMember({ org: 'acme', subject: 'invitee-sub' })).resolves.toBe(
      undefined,
    );
  });

  it('pages grant-only installation discovery with a bounded opaque cursor', async () => {
    const first = await install();
    const second = await businessStore.createInstallation({
      scope: {
        org: 'acme',
        app: 'restaurant-desk',
        env: 'prod',
        installationId: 'restaurant-desk-prod',
      },
      profileKey: 'restaurant',
      managedCollections: ['guest_requests'],
      actorSubject: 'owner-sub',
      actorEmail: 'owner@acme.test',
    });
    expect(second.disposition).toBe('created');

    const pageOne = await fetch(`${base}/v1/me/solution-installations?limit=1`, {
      headers: headers('owner'),
    });
    expect(pageOne.status).toBe(200);
    const firstBody = (await pageOne.json()) as {
      data: { installations: readonly { id: string }[]; nextCursor: string };
    };
    expect(firstBody.data.installations).toHaveLength(1);
    expect(firstBody.data.nextCursor).toEqual(expect.any(String));

    const pageTwo = await fetch(
      `${base}/v1/me/solution-installations?limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
      { headers: headers('owner') },
    );
    expect(pageTwo.status).toBe(200);
    const secondBody = (await pageTwo.json()) as {
      data: { installations: readonly { id: string }[]; nextCursor?: string };
    };
    expect(
      [...firstBody.data.installations, ...secondBody.data.installations].map(({ id }) => id),
    ).toEqual(expect.arrayContaining([first.installationId, 'restaurant-desk-prod']));
    expect(secondBody.data.nextCursor).toBeUndefined();
    expect(
      (
        await fetch(`${base}/v1/me/solution-installations?cursor=not-a-real-cursor`, {
          headers: headers('owner'),
        })
      ).status,
    ).toBe(400);
  });

  it('revokes one installation invitation with CAS and keeps its token unusable', async () => {
    const { installationId } = await install();
    const token = 'b'.repeat(43);
    const path = `${base}/v1/orgs/acme/solution-installations/${installationId}/invitations`;
    const created = await fetch(path, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        email: 'invitee@example.test',
        role: 'viewer',
        token,
        idempotencyKey: 'revoked-invite',
      }),
    });
    const invitation = (await created.json()) as {
      data: { invitation: { invitationId: string } };
    };
    const revokePath = `${path}/${invitation.data.invitation.invitationId}`;
    expect(
      (
        await fetch(revokePath, {
          method: 'DELETE',
          headers: headers('owner', { 'content-type': 'application/json' }),
          body: JSON.stringify({ expectedRevision: 2 }),
        })
      ).status,
    ).toBe(409);
    const revoked = await fetch(revokePath, {
      method: 'DELETE',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      data: { invitation: { status: 'revoked', revision: 2 } },
    });
    expect(
      (
        await fetch(`${base}/v1/solution-invitations/${token}/accept`, {
          method: 'POST',
          headers: headers('invitee'),
        })
      ).status,
    ).toBe(410);
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

    const token = 'c'.repeat(43);
    const invitation = await fetch(
      `${base}/v1/orgs/acme/solution-installations/${installationId}/invitations`,
      {
        method: 'POST',
        headers: headers('owner', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          email: 'owner@acme.test',
          role: 'operator',
          token,
          idempotencyKey: 'owner-self-demotion',
        }),
      },
    );
    expect(invitation.status).toBe(201);
    const accepted = await fetch(`${base}/v1/solution-invitations/${token}/accept`, {
      method: 'POST',
      headers: headers('owner'),
    });
    expect(accepted.status).toBe(409);
    await expect(accepted.json()).resolves.toMatchObject({ code: 'last_administrator' });

    const grants = await fetch(grantsUrl, { headers: headers('owner') });
    await expect(grants.json()).resolves.toMatchObject({
      data: { grants: [{ subject: 'owner-sub', role: 'administrator', revision: 1 }] },
    });
  });

  it('bounds public intake with the shared admission counter port', async () => {
    await stopService();
    const admissionTime = new Date();
    await startService(businessStore, { clock: () => new Date(admissionTime) });
    const { publicId } = await install();
    const url = `${base}/v1/solution-intake/${publicId}/travel_requests/records`;
    for (let first = 0; first < 600; first += 20)
      await Promise.all(
        Array.from({ length: 20 }, async (_, offset) => {
          const index = first + offset;
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
          await response.arrayBuffer();
          expect(response.status).toBe(201);
        }),
      );
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

  it('hides expired payloads from API reads and exports before background cleanup', async () => {
    await stopService();
    let now = new Date('2030-01-01T00:00:00.000Z');
    businessStore = new InMemoryBusinessInformationStore({ now: () => new Date(now) });
    await startService();
    const { installationId, publicId } = await install();
    const secret = 'expired private itinerary';
    const created = await fetch(`${base}/v1/solution-intake/${publicId}/travel_requests/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'retention-api' },
      body: JSON.stringify({
        payload: { request_type: 'service', summary: secret },
      }),
    });
    const recordId = ((await created.json()) as { data: { recordId: string } }).data.recordId;
    const recordsPath =
      `${base}/v1/orgs/acme/solution-installations/${installationId}` +
      '/collections/travel_requests/records';
    now = new Date('2030-02-01T00:00:00.000Z');

    const list = await fetch(recordsPath, { headers: headers('owner') });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ data: { records: [] } });
    const exported = await fetch(`${recordsPath}/export`, { headers: headers('owner') });
    expect(exported.status).toBe(200);
    expect(await exported.text()).not.toContain(secret);
    const mutation = await fetch(`${recordsPath}/${recordId}`, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ operation: 'add-note', expectedRevision: 1, note: 'revive' }),
    });
    expect(mutation.status).toBe(404);
    const detail = await fetch(`${recordsPath}/${recordId}`, { headers: headers('owner') });
    expect(detail.status).toBe(404);
    const activity = await fetch(`${recordsPath}/${recordId}/activity`, {
      headers: headers('owner'),
    });
    const activityText = await activity.text();
    expect(activity.status).toBe(200);
    expect(activityText).toContain('"operation":"delete"');
    expect(activityText).not.toContain(secret);
    const tombstones = await fetch(`${recordsPath}/export?includeDeleted=true`, {
      headers: headers('owner'),
    });
    const tombstoneText = await tombstones.text();
    expect(tombstones.status).toBe(200);
    expect(tombstoneText).toContain(recordId);
    expect(tombstoneText).not.toContain(secret);
  });
});
