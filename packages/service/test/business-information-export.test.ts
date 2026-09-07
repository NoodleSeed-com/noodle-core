import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ManagedRecordExportResponseSchema } from '@noodle-borg/wire-contracts';
import { expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';
import { activateRecordFixture } from './business-information-test-application.js';

it('exports current native notes only to permitted live grants and removes them on erasure', async () => {
  const store = new InMemoryBusinessInformationStore();
  const controlPlane = new InMemoryControlPlaneStore();
  const registry = new ServerRegistry();
  await controlPlane.createOrg({ slug: 'acme' });
  const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'export-proof' };
  await store.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    actorSubject: 'owner',
    actorEmail: 'owner@example.test',
  });
  const server = createServer(
    createServiceHandler(registry, {
      businessInformationStore: store,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: (request) =>
          Promise.resolve({
            ok: true,
            identity: {
              subject: request.headers.authorization === 'Bearer outsider' ? 'outsider' : 'owner',
              email: 'owner@example.test',
              superAdmin: false,
            },
          }),
      },
    }),
  );
  await activateRecordFixture(registry, store, scope);
  const created = await store.createRequest({
    scope,
    collectionKey: 'travel_requests',
    payload: { request_type: 'service', summary: 'Export fixture' },
    idempotencyKey: 'fixture',
    actorSubject: 'owner',
    origin: { kind: 'portal' },
  });
  if (created.disposition !== 'created') throw new Error('record fixture missing');
  await store.mutateRequest({
    scope,
    collectionKey: 'travel_requests',
    id: created.record.id,
    expectedRevision: 1,
    actorSubject: 'owner',
    operation: { kind: 'add_note', note: 'Private staff note\nSecond line' },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orgs/acme/solution-installations/export-proof/collections/travel_requests`;
  const headers = { authorization: 'Bearer owner' };
  try {
    const response = await fetch(`${base}/records/export`, { headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.records[0]).toMatchObject({
      payload: { summary: 'Export fixture' },
      notes: [
        {
          text: 'Private staff note\nSecond line',
          createdBySubject: 'owner',
          createdAt: expect.any(String),
          id: expect.any(String),
        },
      ],
    });
    expect(ManagedRecordExportResponseSchema.safeParse(body).success).toBe(true);
    expect(
      JSON.stringify(await (await fetch(`${base}/records`, { headers })).json()),
    ).not.toContain('Private staff note');
    expect(
      (await fetch(`${base}/records/export`, { headers: { authorization: 'Bearer outsider' } }))
        .status,
    ).toBe(403);
    await store.deleteRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.record.id,
      expectedRevision: 2,
      actorSubject: 'owner',
      reason: 'customer_request',
    });
    const erased = await (
      await fetch(`${base}/records/export?includeDeleted=true`, { headers })
    ).json();
    expect(erased.data.records[0]).toHaveProperty('deletedAt');
    expect(erased.data.records[0]).not.toHaveProperty('notes');
    expect(JSON.stringify(erased)).not.toContain('Private staff note');
    expect(ManagedRecordExportResponseSchema.safeParse(erased).success).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
