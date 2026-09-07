import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { builtInDefinitionAtRelease } from '../src/business-information/profiles.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';
import { activateRecordFixture } from './business-information-test-application.js';

let http: Server;
let base: string;
let businessStore: InMemoryBusinessInformationStore;
let registry: ServerRegistry;
function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}
beforeEach(async () => {
  businessStore = new InMemoryBusinessInformationStore();
  registry = new ServerRegistry(new InMemoryArtifactStore());
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  http = createServer(
    createServiceHandler(registry, {
      businessInformationStore: businessStore,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@acme.test', superAdmin: false },
          }),
      },
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

it('merges an admitted PATCH without resubmitting retained protected fields', async () => {
  const scope = { org: 'acme', app: 'assets', env: 'prod', installationId: 'assets-prod' };
  const baseline = builtInDefinitionAtRelease('travel', 3);
  const collection = baseline.collections[0];
  if (collection === undefined) throw new Error('collection fixture missing');
  await businessStore.createInstallation({
    scope,
    actorSubject: 'owner-sub',
    actorEmail: 'owner@acme.test',
    managedCollections: ['items'],
    definition: {
      reference: {
        kind: 'private',
        publisherOrg: 'acme',
        app: 'assets',
        env: 'prod',
        deploymentId: 'private-assets',
        version: '1',
        digest: 'b'.repeat(64),
      },
      title: 'Assets',
      description: 'Synthetic assets',
      collections: [
        {
          ...collection,
          key: 'items',
          schemaVersion: 1,
          schemaDigest: 'a'.repeat(64),
          recordSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'reference'],
            properties: {
              label: { type: 'string', maxLength: 100 },
              reference: { type: 'string', maxLength: 100, default: 'protected' },
              optionalReference: { type: 'string', maxLength: 100 },
            },
          },
          summaryFields: ['label'],
          publicFields: ['label'],
          editableFields: ['label', 'optionalReference'],
          filterFields: [],
          sortFields: [],
          fields: {},
        },
      ],
    },
  });
  await activateRecordFixture(registry, businessStore, scope);
  const created = await businessStore.createRequest({
    scope,
    collectionKey: 'items',
    actorSubject: 'owner-sub',
    idempotencyKey: 'protected',
    origin: { kind: 'portal' },
    payload: { label: 'Original', optionalReference: 'CLEAR' },
  });
  if (created.disposition !== 'created') throw new Error('record fixture missing');
  const url = `${base}/v1/orgs/acme/solution-installations/assets-prod/collections/items/records/${created.record.id}`;
  const patch = (value: unknown, expectedRevision: number, unset?: string[]) =>
    fetch(url, {
      method: 'PATCH',
      headers: headers('owner', { 'content-type': 'application/json' }),
      body: JSON.stringify({ operation: 'update', expectedRevision, patch: value, unset }),
    });
  const updated = await patch({ label: 'Changed' }, 1);
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({
    data: { record: { payload: { label: 'Changed', reference: 'protected' }, revision: 2 } },
  });
  expect((await patch({ reference: 'overwrite' }, 2)).status).toBe(400);
  expect((await patch({}, 2, ['reference'])).status).toBe(400);
  const cleared = await patch({}, 2, ['optionalReference']);
  expect(cleared.status).toBe(200);
  expect((await cleared.json()).data.record.payload).toEqual({
    label: 'Changed',
    reference: 'protected',
  });
});
