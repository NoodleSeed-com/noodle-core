import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryBusinessInformationStore,
  InMemorySourceIngestionStore,
  type SourceReadExecutor,
} from '../src/business-information/portable.js';
import { SourceCredentialError } from '../src/business-information/source-credential-fence.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';
import {
  sourceConfigurationFixture,
  sourceConnectorDocument,
} from './source-configuration-fixture.js';

let http: Server | undefined;
let base = '';
let controlPlane: InMemoryControlPlaneStore;

function gate() {
  const identities: Record<string, { subject: string; email: string }> = {
    owner: { subject: 'owner-sub', email: 'owner@acme.test' },
    operator: { subject: 'operator-sub', email: 'operator@acme.test' },
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
  store: InMemoryBusinessInformationStore,
  overrides: Partial<ServiceOptions>,
): Promise<void> {
  const registry = new ServerRegistry(new InMemoryArtifactStore());
  // This route fixture supplies a deliberate synthetic executor. Its immutable connector metadata
  // still participates in real configuration fencing; it is not an executable/provider proof.
  if (overrides.businessInformationSourceExecutor) {
    const fixture = sourceConfigurationFixture(registry.configStore);
    vi.spyOn(registry, 'getActiveByTenant').mockImplementation(async (scope) => ({
      ...(await fixture.registry.getActiveByTenant()),
      org: scope.org,
      app: scope.app,
      environment: scope.env,
    }));
    vi.spyOn(registry, 'getDeploymentSource').mockResolvedValue({
      manifest: '{}',
      connectors: sourceConnectorDocument
        .replaceAll('gmail', 'calendar-provider')
        .replaceAll('"scan"', '"scan_appointments"'),
    });
  }
  http = createServer(
    createServiceHandler(registry, {
      controlPlaneStore: controlPlane,
      deployGate: gate(),
      businessInformationStore: store,
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (!http) return;
  await new Promise<void>((resolve, reject) =>
    http?.close((error) => (error ? reject(error) : resolve())),
  );
  http = undefined;
});

describe('business information external collection API', () => {
  it('configures, refreshes, reads, pauses, resumes, and suppresses an external collection', async () => {
    controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrg({ slug: 'acme' });
    await controlPlane.addOrgMember({
      org: 'acme',
      subject: 'owner-sub',
      email: 'owner@acme.test',
      role: 'owner',
    });
    const externalStore = new InMemoryBusinessInformationStore();
    const sourceStore = new InMemorySourceIngestionStore({
      identityKey: 'test-source-identity-key-at-least-32-bytes',
    });
    const externalInstallation = await externalStore.createInstallation({
      scope: {
        org: 'acme',
        app: 'calendar-ops',
        env: 'prod',
        installationId: 'ins-calendar',
      },
      definition: {
        reference: {
          kind: 'private',
          publisherOrg: 'acme',
          app: 'calendar-definition',
          env: 'prod',
          deploymentId: 'dep-calendar',
          version: '1.0.0',
          digest: 'a'.repeat(64),
        },
        title: 'Calendar operations',
        description: 'Operate externally authoritative appointments.',
        collections: [
          {
            key: 'appointments',
            title: 'Appointments',
            singularTitle: 'Appointment',
            description: 'Appointments projected from an external calendar.',
            schemaVersion: 1,
            schemaDigest: 'b'.repeat(64),
            recordSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['title'],
              properties: { title: { type: 'string' } },
            },
            summaryFields: ['title'],
            authority: {
              authority: 'external',
              connectorAlias: 'calendar',
              connectorId: 'calendar-provider',
              connectorVersion: '1.0.0',
              scanOperation: 'scan_appointments',
              scanSignatureHash: `sha256v2:${'c'.repeat(64)}`,
            },
          },
        ],
      },
      managedCollections: ['appointments'],
      retentionDays: 30,
      actorSubject: 'owner-sub',
      actorEmail: 'owner@acme.test',
    });
    await externalStore.setGrant({
      scope: externalInstallation.installation.scope,
      subject: 'operator-sub',
      email: 'operator@acme.test',
      role: 'operator',
      expectedRevision: 0,
      actorSubject: 'owner-sub',
    });
    await externalStore.createInstallation({
      scope: {
        org: 'customer',
        app: 'calendar-ops',
        env: 'prod',
        installationId: 'ins-cross-org-calendar',
      },
      definition: externalInstallation.installation.definition,
      managedCollections: ['appointments'],
      retentionDays: 30,
      actorSubject: 'owner-sub',
      actorEmail: 'owner@acme.test',
    });
    let sourceCalls = 0;
    const executor: SourceReadExecutor = {
      scan: () => {
        sourceCalls += 1;
        return Promise.resolve({
          records: [
            { id: 'provider-event-1', version: 'etag-1', record: { title: 'Pilot call' } },
            { id: 'provider-event-2', version: 'etag-2', record: { title: 'Design review' } },
            { id: 'provider-event-3', version: 'etag-3', record: { title: 'Launch review' } },
          ],
          deletedIds: [],
          checkpoint: 'checkpoint-1',
          complete: true,
        });
      },
    };
    await startService(externalStore, {
      businessInformationSourceStore: sourceStore,
      businessInformationSourceExecutor: executor,
    });
    const sourceUrl =
      `${base}/v1/orgs/acme/solution-installations/ins-calendar` +
      '/collections/appointments/source';
    const recordsUrl = sourceUrl.replace(/\/source$/, '/records');

    const crossOrgConfiguration = await fetch(
      `${base}/v1/orgs/customer/solution-installations/ins-cross-org-calendar` +
        '/collections/appointments/source',
      {
        method: 'PATCH',
        headers: headers('owner', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          expectedRevision: 1,
          binding: { reference: 'google-calendar', generation: 1 },
          configurationReference: 'primary-calendar',
          enable: true,
        }),
      },
    );
    expect(crossOrgConfiguration.status).toBe(409);
    await expect(crossOrgConfiguration.json()).resolves.toMatchObject({
      code: 'source_cross_org_binding_unavailable',
    });

    const unconfigured = await fetch(sourceUrl, { headers: headers('owner') });
    await expect(unconfigured.json()).resolves.toMatchObject({
      data: { source: { state: 'unconfigured', revision: 1 } },
    });
    const unavailableRecords = await fetch(recordsUrl, { headers: headers('owner') });
    expect(unavailableRecords.status).toBe(503);
    await expect(unavailableRecords.json()).resolves.toMatchObject({
      code: 'source_unavailable',
    });
    const configured = await fetch(sourceUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        expectedRevision: 1,
        binding: { reference: 'google-calendar', generation: 1 },
        configurationReference: 'primary-calendar',
        enable: true,
      }),
    });
    expect(configured.status, await configured.clone().text()).toBe(201);

    const refresh = await fetch(`${sourceUrl}/refresh`, {
      method: 'POST',
      headers: headers('operator', { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: 'first-calendar-refresh' }),
    });
    expect(refresh.status, await refresh.clone().text()).toBe(202);
    const refreshBody = (await refresh.json()) as {
      data: { job: { id: string }; source: { revision: number } };
    };
    expect(refreshBody).toMatchObject({
      data: {
        source: { health: 'pending', completeness: 'unknown' },
        job: { state: 'queued', coalesced: false },
      },
    });
    const replay = await fetch(`${sourceUrl}/refresh`, {
      method: 'POST',
      headers: headers('operator', { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: 'first-calendar-refresh' }),
    });
    expect(replay.status, await replay.clone().text()).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      data: { job: { id: refreshBody.data.job.id, coalesced: true } },
    });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = (await (await fetch(recordsUrl, { headers: headers('owner') })).json()) as {
        data?: { records?: unknown[] };
      };
      if (ready.data?.records?.length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sourceCalls).toBe(1);

    const firstPageResponse = await fetch(`${recordsUrl}?limit=1`, {
      headers: headers('owner'),
    });
    expect(firstPageResponse.status).toBe(200);
    const firstPage = (await firstPageResponse.json()) as {
      data: { records: Array<{ id: string }>; nextCursor?: string };
    };
    expect(firstPage.data.records).toHaveLength(1);
    expect(firstPage.data.nextCursor).toBeTypeOf('string');
    const secondPageResponse = await fetch(
      `${recordsUrl}?limit=1&cursor=${encodeURIComponent(firstPage.data.nextCursor ?? '')}`,
      { headers: headers('owner') },
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = (await secondPageResponse.json()) as {
      data: { records: Array<{ id: string }>; nextCursor?: string };
    };
    expect(secondPage.data.records).toHaveLength(1);
    expect(secondPage.data.records[0]?.id).not.toBe(firstPage.data.records[0]?.id);
    expect(secondPage.data.nextCursor).toBeTypeOf('string');
    const exactSecondRecord = await fetch(
      `${recordsUrl}/${secondPage.data.records[0]?.id ?? 'missing'}`,
      { headers: headers('owner') },
    );
    expect(exactSecondRecord.status).toBe(200);
    await expect(exactSecondRecord.json()).resolves.toMatchObject({
      data: { record: { id: secondPage.data.records[0]?.id } },
    });
    const invalidCursor = await fetch(`${recordsUrl}?limit=1&cursor=invalid`, {
      headers: headers('owner'),
    });
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toMatchObject({ code: 'invalid_cursor' });

    const listed = await fetch(recordsUrl, { headers: headers('owner') });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      data: { records: Array<{ id: string; revision: number }> };
    };
    expect(listedBody.data.records).toHaveLength(3);
    expect(listedBody.data.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authority: 'external',
          payload: { title: 'Pilot call' },
          source: expect.objectContaining({
            sourceRecordId: 'provider-event-1',
            sourceVersion: 'etag-1',
          }),
        }),
      ]),
    );
    expect(
      (
        await fetch(recordsUrl, {
          method: 'POST',
          headers: headers('owner', {
            'content-type': 'application/json',
            'idempotency-key': 'external-create',
          }),
          body: JSON.stringify({ payload: { title: 'Forbidden' } }),
        })
      ).status,
    ).toBe(405);

    const sourceState = (await (await fetch(sourceUrl, { headers: headers('owner') })).json()) as {
      data: { source: { revision: number } };
    };
    const pause = await fetch(`${sourceUrl}/pause`, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision: sourceState.data.source.revision }),
    });
    expect(pause.status).toBe(200);
    const paused = (await pause.json()) as { data: { source: { revision: number } } };
    const resume = await fetch(`${sourceUrl}/resume`, {
      method: 'POST',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision: paused.data.source.revision }),
    });
    expect(resume.status).toBe(200);

    const record = listedBody.data.records[0];
    expect(record).toBeDefined();
    const rejectedUpdate = await fetch(`${recordsUrl}/${record?.id}`, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({
        operation: 'update',
        expectedRevision: record?.revision,
        patch: { title: 'Forbidden local replacement' },
      }),
    });
    expect(rejectedUpdate.status).toBe(405);
    await expect(rejectedUpdate.json()).resolves.toMatchObject({
      code: 'operation_not_supported',
    });

    const erased = await fetch(`${recordsUrl}/${record?.id}`, {
      method: 'DELETE',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision: record?.revision }),
    });
    expect(erased.status).toBe(200);
    await expect(erased.json()).resolves.toMatchObject({
      data: { authority: 'external', disposition: 'suppressed' },
    });
    const remaining = (await (await fetch(recordsUrl, { headers: headers('owner') })).json()) as {
      data: { records: Array<{ id: string }> };
    };
    expect(remaining.data.records).toHaveLength(2);
    expect(remaining.data.records.map((item) => item.id)).not.toContain(record?.id);

    const deniedRead = vi
      .spyOn(sourceStore, 'listExternalRecords')
      .mockRejectedValueOnce(new SourceCredentialError());
    const denied = await fetch(recordsUrl, { headers: headers('owner') });
    expect(denied.status).toBe(503);
    await expect(denied.json()).resolves.toEqual({
      code: 'source_unavailable',
      error: 'Collection source authorization changed; reconnect and replace its binding.',
    });
    deniedRead.mockRestore();

    const beforeReplacement = (await (
      await fetch(sourceUrl, { headers: headers('owner') })
    ).json()) as { data: { source: { revision: number } } };
    const replacementBody = {
      expectedRevision: beforeReplacement.data.source.revision,
      binding: { reference: 'google-calendar', generation: 2 },
      configurationReference: 'secondary-calendar',
      enable: true,
    };
    const implicitReplacement = await fetch(sourceUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify(replacementBody),
    });
    expect(implicitReplacement.status).toBe(409);
    await expect(implicitReplacement.json()).resolves.toMatchObject({
      code: 'source_replacement_required',
    });
    const replacement = await fetch(sourceUrl, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ ...replacementBody, replace: true }),
    });
    expect(replacement.status, await replacement.clone().text()).toBe(200);
    await expect(replacement.json()).resolves.toMatchObject({
      data: {
        source: {
          binding: { reference: 'google-calendar', generation: 2 },
          health: 'pending',
          completeness: 'unknown',
        },
      },
    });
  });
});
