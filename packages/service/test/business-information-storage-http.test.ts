import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { NativeStorageLimitError } from '../src/business-information/native-storage-budget.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

it('projects capacity refusal safely and rejects cross-record/malformed history cursors over HTTP', async () => {
  const store = new InMemoryBusinessInformationStore();
  const control = new InMemoryControlPlaneStore();
  await control.createOrg({ slug: 'acme' });
  await control.addOrgMember({
    org: 'acme',
    subject: 'owner',
    email: 'owner@example.test',
    role: 'owner',
  });
  const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
  await store.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    actorSubject: 'owner',
  });
  const input = {
    scope,
    collectionKey: 'travel_requests',
    idempotencyKey: 'original',
    payload: { request_type: 'refund', summary: 'Original' },
    origin: { kind: 'portal' as const },
    actorSubject: 'owner',
  };
  const created = await store.createRequest(input);
  if (created.disposition !== 'created') throw new Error('Missing fixture');
  await store.mutateRequest({
    scope,
    collectionKey: 'travel_requests',
    id: created.record.id,
    expectedRevision: 1,
    actorSubject: 'owner',
    operation: { kind: 'update', payload: { summary: 'Updated' } },
  });
  const server = createServer(
    createServiceHandler(new ServerRegistry(new InMemoryArtifactStore()), {
      controlPlaneStore: control,
      businessInformationStore: store,
      deployGate: {
        authorize: async () => ({
          ok: true as const,
          identity: { subject: 'owner', superAdmin: false },
        }),
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orgs/acme/solution-installations/travel-prod/collections/travel_requests/records`;
  try {
    const first = await fetch(`${base}/${created.record.id}/activity?limit=1`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      data: { activities: { revision: number }[]; nextCursor: string };
    };
    expect(page.data.activities.map((entry) => entry.revision)).toEqual([2]);
    const next = await fetch(
      `${base}/${created.record.id}/activity?cursor=${encodeURIComponent(page.data.nextCursor)}`,
    );
    expect(await next.json()).toMatchObject({ data: { activities: [{ revision: 1 }] } });
    const wrong = await fetch(
      `${base}/other/activity?cursor=${encodeURIComponent(page.data.nextCursor)}`,
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: 'invalid_cursor' });
    const spy = vi
      .spyOn(store, 'mutateRequest')
      .mockRejectedValueOnce(new NativeStorageLimitError());
    const denied = await fetch(`${base}/${created.record.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 2,
        operation: 'update',
        patch: { summary: 'Another edit' },
      }),
    });
    spy.mockRestore();
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({
      code: 'managed_record_storage_limit',
      error: 'Managed record storage is full. Erase retained records to reclaim capacity.',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
