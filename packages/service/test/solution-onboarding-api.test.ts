import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AgreementDocuments,
  agreementDocumentDigest,
} from '@noodle-borg/control-plane/portable';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const documents = {
  version: 'test-version',
  terms: { url: 'https://example.com/terms', sha256: 'a'.repeat(64) },
  privacy: { url: 'https://example.com/privacy', sha256: 'b'.repeat(64) },
  processing: { url: 'https://example.com/processing', sha256: 'c'.repeat(64) },
};
const notice = {
  displayName: 'Acme',
  privacyUrl: 'https://acme.example/privacy',
  supportUrl: 'mailto:support@acme.example',
};
const install = {
  definition: { kind: 'managed', profileId: 'travel' },
  appSlug: 'travel-desk',
  environment: 'prod',
  retentionDays: 30,
};
let server: Server;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function setup(approved = true) {
  const controlPlane = new InMemoryControlPlaneStore();
  const store = new InMemoryBusinessInformationStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@acme.example' },
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'developer',
    email: 'developer@acme.example',
    role: 'developer',
  });
  const registry = new ServerRegistry(new InMemoryArtifactStore());
  const start = async (catalog: AgreementDocuments | undefined) => {
    server = createServer(
      createServiceHandler(registry, {
        controlPlaneStore: controlPlane,
        businessInformationStore: store,
        businessOnboarding: catalog ? { documents: catalog } : {},
        deployGate: {
          authorize: async (req) => ({
            ok: true,
            identity: {
              subject: String(req.headers.authorization ?? 'owner'),
              email: 'actor@acme.example',
              superAdmin: req.headers.authorization === 'super',
            },
          }),
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  };
  await start(approved ? documents : undefined);
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown, actor = 'owner') =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: actor,
        'content-type': 'application/json',
        'idempotency-key': 'synthetic-onboarding-request',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const replaceCatalog = async (catalog: AgreementDocuments) => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(catalog);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  return { request, store, controlPlane, registry, replaceCatalog };
}

describe('one resumable solution onboarding authority', () => {
  it('a required-version change blocks existing public channels while records remain readable, exportable and erasable', async () => {
    const { request, store, replaceCatalog } = await setup();
    await request('/v1/orgs/acme/agreement', 'POST', {
      version: documents.version,
      documentDigest: agreementDocumentDigest(documents),
      accepted: true,
    });
    await request('/v1/orgs/acme/solution-installations', 'POST', {
      ...install,
      businessNotice: notice,
    });
    const installation = (await store.listInstallations('acme'))[0];
    if (!installation) throw new Error('Expected installation');
    const path = `/v1/orgs/acme/solution-installations/${installation.scope.installationId}`;
    const records = `${path}/collections/travel_requests/records`;
    const created = await request(records, 'POST', {
      payload: { request_type: 'service', summary: 'Synthetic retained request' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const record = (await created.json()) as { data: { record: { id: string; revision: number } } };
    const publicPath = `/v1/solution-intake/${installation.publicId}`;
    expect(await (await request(publicPath)).json()).toMatchObject({
      data: { businessNotice: notice },
    });
    await replaceCatalog({ ...documents, version: 'next-required-version' });
    expect((await request(publicPath)).status).toBe(409);
    expect((await request(`${path}/channels`)).status).toBe(409);
    expect((await request('/v1/orgs/acme/solution-installations', 'POST', install)).status).toBe(
      409,
    );
    expect((await request(records)).status).toBe(200);
    expect((await request(`${records}/export`)).status).toBe(200);
    expect(
      (
        await request(`${records}/${record.data.record.id}`, 'DELETE', {
          expectedRevision: record.data.record.revision,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`${path}/channels`, 'PATCH', {
          expectedRevision: installation.revision,
          active: false,
        })
      ).status,
    ).toBe(200);
  });
  it('fails closed without approved documents, including direct installation activation', async () => {
    const { request, registry } = await setup(false);
    expect(await (await request('/v1/orgs/acme/agreement')).json()).toMatchObject({
      data: { required: null, accepted: false, canAccept: true },
    });
    const response = await request('/v1/orgs/acme/solution-installations', 'POST', {
      ...install,
      businessNotice: notice,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'business_setup_required',
      installationId: expect.any(String),
    });
    expect(
      await registry.getActiveByTenant({ org: 'acme', app: install.appSlug, env: 'prod' }),
    ).toBeUndefined();
  });

  it('requires exact version/digest and current owner; browser fields cannot authorize acceptance', async () => {
    const { request } = await setup();
    const path = '/v1/orgs/acme/agreement';
    const accept = {
      version: documents.version,
      documentDigest: agreementDocumentDigest(documents),
      accepted: true,
    };
    for (const actor of ['developer', 'super'])
      expect((await request(path, 'POST', accept, actor)).status).toBe(403);
    for (const body of [
      { ...accept, version: 'unknown' },
      { ...accept, documentDigest: 'd'.repeat(64) },
    ])
      expect((await request(path, 'POST', body)).status).toBe(409);
    expect((await request(path, 'POST', { ...accept, acceptedAt: 'today' })).status).toBe(400);
    expect((await request(path, 'POST', accept)).status).toBe(200);
    const first = await (await request(path)).json();
    expect(await (await request(path, 'POST', accept)).json()).toEqual(first);
    expect(first).toMatchObject({
      data: { accepted: true, receipt: { version: documents.version } },
    });
  });

  it('retains one draft on interruption, requires notice and activates the same installation on retry', async () => {
    const { request, store } = await setup();
    const first = await request('/v1/orgs/acme/solution-installations', 'POST', install);
    expect(first.status).toBe(409);
    const firstBody = (await first.json()) as { installationId: string };
    await request('/v1/orgs/acme/agreement', 'POST', {
      version: documents.version,
      documentDigest: agreementDocumentDigest(documents),
      accepted: true,
    });
    expect((await request('/v1/orgs/acme/solution-installations', 'POST', install)).status).toBe(
      409,
    );
    const resumed = await request('/v1/orgs/acme/solution-installations', 'POST', {
      ...install,
      businessNotice: notice,
    });
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    expect(await resumed.json()).toMatchObject({
      data: { installation: { id: firstBody.installationId } },
    });
    expect(await store.listInstallations('acme')).toHaveLength(1);
    const path = `/v1/orgs/acme/solution-installations/${firstBody.installationId}/notice`;
    expect(await (await request(path)).json()).toMatchObject({
      data: { revision: 1, notice, canEdit: true },
    });
    expect((await request(path, 'PUT', { expectedRevision: 0, notice })).status).toBe(409);
    expect(
      (
        await request(path, 'PUT', {
          expectedRevision: 1,
          notice: { ...notice, displayName: 'Updated' },
        })
      ).status,
    ).toBe(200);
    await request('/v1/orgs/acme/solution-installations', 'POST', {
      ...install,
      businessNotice: notice,
    });
    expect(await (await request(path)).json()).toMatchObject({
      data: { revision: 2, notice: { displayName: 'Updated' } },
    });
  });
});
