import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agreementDocumentDigest, InMemoryAtomicState } from '@noodle-borg/control-plane/portable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryApplicationDraftBackend } from '../src/application-drafts/memory.js';
import { ApplicationDraftStore } from '../src/application-drafts/store.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { BusinessOnboarding } from '../src/business-onboarding.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';

const documents = {
  version: 'workspace-test',
  terms: { url: 'https://example.test/terms', sha256: 'a'.repeat(64) },
  privacy: { url: 'https://example.test/privacy', sha256: 'b'.repeat(64) },
  processing: { url: 'https://example.test/processing', sha256: 'c'.repeat(64) },
};
const acceptance = {
  version: documents.version,
  documentDigest: agreementDocumentDigest(documents),
  accepted: true,
};
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

async function fixture() {
  const transactions = new InMemoryAtomicState();
  const organizations = new InMemoryControlPlaneStore({ transactions });
  await organizations.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'legacy-owner', email: 'legacy@example.test' },
  });
  const suspended = new Set<string>();
  const workspaces = new BusinessWorkspaceStore(
    new InMemoryBusinessWorkspaceBackend(undefined, undefined, transactions),
    { isIdentityActive: async (subject) => !suspended.has(subject) },
  );
  await workspaces.initializeNewWorkspace({ org: 'acme', ownerSubject: 'owner' });
  for (const role of ['administrator', 'builder', 'operator', 'viewer', 'owner'] as const) {
    const subject = role === 'owner' ? 'second-owner' : role;
    const invite = await workspaces.invite({
      org: 'acme',
      actor: 'owner',
      expectedRevision: (await workspaces.inspect('acme', 'owner')).revision,
      email: `${subject}@example.test`,
      role,
    });
    await workspaces.accept({
      org: 'acme',
      subject,
      verifiedEmail: `${subject}@example.test`,
      token: invite.token,
    });
  }
  const drafts = new ApplicationDraftStore(new InMemoryApplicationDraftBackend(), {
    authorize: async () => false,
  });
  const server = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: organizations,
      businessInformationStore: new InMemoryBusinessInformationStore(),
      businessOnboarding: { documents },
      businessAuthoring: { workspaces, drafts, verifiedEmail: async () => undefined },
      deployGate: {
        authorize: async (req) => ({
          ok: true,
          identity: {
            subject: req.headers.authorization ?? 'owner',
            email: 'actor@example.test',
            superAdmin: req.headers.authorization === 'super-admin',
          },
        }),
      },
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orgs/acme/agreement`;
  const request = (actor = 'owner', body?: unknown) =>
    fetch(base, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: actor, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { organizations, workspaces, suspended, request, transactions };
}

describe('business agreement owner authority', () => {
  it('rolls back the shared local workspace and agreement composition after outer failure', async () => {
    const { transactions, organizations, workspaces } = await fixture();
    const onboarding = new BusinessOnboarding(
      { documents },
      organizations,
      new InMemoryBusinessInformationStore(),
      workspaces,
    );
    await expect(
      transactions.run(async () => {
        expect(await onboarding.accept('acme', 'owner', acceptance)).toMatchObject({
          accepted: true,
        });
        throw new Error('composition failed');
      }),
    ).rejects.toThrow('composition failed');
    expect(await organizations.getOrganizationAgreement('acme', documents.version)).toBeUndefined();
    expect(await onboarding.accept('acme', 'owner', acceptance)).toMatchObject({ accepted: true });
  });

  it('accepts the current workspace Owner without a developer role and preserves the first receipt', async () => {
    const { request, organizations } = await fixture();
    expect(await organizations.getOrgMember({ org: 'acme', subject: 'owner' })).toBeUndefined();
    const before = await request();
    expect(before.status).toBe(200);
    expect(before.headers.get('cache-control')).toBe('private, no-store');
    expect(await before.json()).toMatchObject({ data: { canAccept: true, accepted: false } });
    const accepted = await request('owner', acceptance);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const receipt = await organizations.getOrganizationAgreement('acme', documents.version);
    expect(receipt?.actorSubject).toBe('owner');
    expect((await request('second-owner', acceptance)).status).toBe(200);
    expect(await organizations.getOrganizationAgreement('acme', documents.version)).toEqual(
      receipt,
    );
  });

  it('lets Admin inspect only, denies other roles and never supplements workspace authority with legacy ownership', async () => {
    const { request, organizations, suspended } = await fixture();
    const admin = await request('administrator');
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ data: { canAccept: false } });
    for (const actor of [
      'administrator',
      'builder',
      'operator',
      'viewer',
      'legacy-owner',
      'super-admin',
      'stranger',
    ]) {
      expect((await request(actor, acceptance)).status, actor).toBe(403);
      if (actor !== 'administrator') expect((await request(actor)).status, actor).toBe(403);
    }
    suspended.add('owner');
    expect((await request('owner', acceptance)).status).toBe(403);
    expect(await organizations.getOrganizationAgreement('acme', documents.version)).toBeUndefined();
  });

  it('rechecks ownership at acceptance, including retries after the prior Owner is removed', async () => {
    const { request, workspaces, organizations } = await fixture();
    const original = organizations.acceptOrganizationAgreement.bind(organizations);
    vi.spyOn(organizations, 'acceptOrganizationAgreement').mockImplementationOnce(
      async (...args) => {
        await workspaces.changeRole({
          org: 'acme',
          actor: 'second-owner',
          expectedRevision: (await workspaces.inspect('acme', 'second-owner')).revision,
          subject: 'owner',
          role: null,
        });
        return original(...args);
      },
    );
    expect((await request('owner', acceptance)).status).toBe(403);
    expect(await organizations.getOrganizationAgreement('acme', documents.version)).toBeUndefined();
    expect((await request('second-owner', acceptance)).status).toBe(200);
    expect((await request('owner', acceptance)).status).toBe(403);
  });

  it('keeps the strict approved-document contract and refuses authority supplied as request data', async () => {
    const { request, organizations } = await fixture();
    expect((await request('owner', { ...acceptance, version: 'other' })).status).toBe(409);
    expect((await request('owner', { ...acceptance, documentDigest: 'd'.repeat(64) })).status).toBe(
      409,
    );
    for (const extra of [{ owner: true }, { authority: 'owner' }, { actorSubject: 'second-owner' }])
      expect((await request('owner', { ...acceptance, ...extra })).status).toBe(400);
    expect(await organizations.getOrganizationAgreement('acme', documents.version)).toBeUndefined();
  });
});
