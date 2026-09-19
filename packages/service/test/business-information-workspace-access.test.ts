import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BusinessWorkspaceRole } from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryApplicationDraftBackend } from '../src/application-drafts/memory.js';
import { ApplicationDraftStore } from '../src/application-drafts/store.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';
import { InMemoryConfigStore } from '../src/store/config-values.js';

describe('business operations use one workspace authority version', () => {
  let http: Server, base: string, business: InMemoryBusinessInformationStore;
  let workspaces: BusinessWorkspaceStore;
  const scope = { org: 'acme', app: 'assistant', env: 'prod', installationId: 'native' };
  const roles: readonly BusinessWorkspaceRole[] = [
    'owner',
    'administrator',
    'builder',
    'operator',
    'viewer',
  ];
  const request = (path: string, actor: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${actor}`,
        'content-type': 'application/json',
        'idempotency-key': `${actor}-${method}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  beforeEach(async () => {
    business = new InMemoryBusinessInformationStore();
    workspaces = new BusinessWorkspaceStore(new InMemoryBusinessWorkspaceBackend(), {
      isIdentityActive: async () => true,
    });
    await workspaces.initializeNewWorkspace({ org: 'acme', ownerSubject: 'owner' });
    for (const role of roles.filter((role) => role !== 'owner')) {
      const invitation = await workspaces.invite({
        org: 'acme',
        actor: 'owner',
        email: `${role}@example.test`,
        role,
        expectedRevision: (await workspaces.inspect('acme', 'owner')).revision,
      });
      await workspaces.accept({
        org: 'acme',
        subject: role,
        token: invitation.token,
        verifiedEmail: `${role}@example.test`,
      });
    }
    // A stale legacy administrator must not bypass the selected workspace version.
    await business.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'legacy-admin',
    });
    http = createServer(
      createServiceHandler(new ServerRegistry(), {
        businessInformationStore: business,
        configStore: new InMemoryConfigStore(),
        businessPageOrigin: 'https://portal.example.test',
        publicBaseUrl: 'https://runtime.example.test',
        businessAuthoring: {
          workspaces,
          drafts: new ApplicationDraftStore(new InMemoryApplicationDraftBackend(), {
            authorize: async () => false,
          }),
        },
        deployGate: {
          authorize: async (req) => {
            const subject = req.headers.authorization?.replace(/^Bearer /, '');
            return subject
              ? {
                  ok: true,
                  identity: {
                    subject,
                    email: `${subject}@example.test`,
                    superAdmin: subject === 'super-admin',
                  },
                }
              : { ok: false, status: 401, message: 'Sign in required' };
          },
        },
      }),
    );
    business.configureApplicationLifecycle(async () => ({
      generation: '2026-09-19T00:00:00.000Z',
      active: true,
    }));
    expect(await business.bindApplication(scope, '2026-09-19T00:00:00.000Z')).toBe(true);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/orgs/acme/solution-installations/native`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('reads records by fixed role without requiring installation or developer grants', async () => {
    for (const role of roles) {
      const response = await request('/collections/travel_requests/records', role);
      expect(response.status, role).toBe(role === 'builder' ? 403 : 200);
    }
    for (const actor of ['legacy-admin', 'outsider', 'super-admin'])
      expect((await request('/collections/travel_requests/records', actor)).status, actor).toBe(
        403,
      );
  });

  it('lets invited workspace members discover applications without a legacy grant and hides revoked legacy candidates', async () => {
    for (const actor of ['owner', 'administrator', 'builder', 'operator', 'viewer']) {
      const response = await fetch(`${new URL(base).origin}/v1/orgs/acme/solution-installations`, {
        headers: { authorization: `Bearer ${actor}` },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).data.installations).toMatchObject([
        { id: 'native', authorityVersion: 1, currentRole: actor },
      ]);
    }
    const legacy = await fetch(`${new URL(base).origin}/v1/me/solution-installations`, {
      headers: { authorization: 'Bearer legacy-admin' },
    });
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).data.installations).toEqual([]);
  });

  it('projects exact roles and authority version without treating Builder as an operator', async () => {
    for (const role of roles) {
      const response = await request('', role);
      expect(response.status, role).toBe(200);
      expect((await response.json()).data.installation).toMatchObject({
        currentRole: role,
        authorityVersion: 1,
      });
    }
  });

  it('creates native records only for Owner, Administrator and Operator', async () => {
    for (const role of roles) {
      const response = await request('/collections/travel_requests/records', role, 'POST', {
        payload: { request_type: 'service', summary: `Enquiry from ${role}` },
      });
      expect(response.status, `${role}: ${await response.clone().text()}`).toBe(
        role === 'builder' || role === 'viewer' ? 403 : 201,
      );
    }
  });

  it('does not use legacy grant or invitation administration in a versioned workspace', async () => {
    for (const path of ['/grants', '/invitations'])
      expect((await request(path, 'owner')).status).toBe(403);
  });

  it('shows business-notice editing and private hosted pages only to the appropriate workspace roles', async () => {
    for (const actor of roles) {
      const response = await request('/notice', actor);
      expect(response.status).toBe(200);
      expect((await response.json()).data.canEdit).toBe(
        actor === 'owner' || actor === 'administrator',
      );
      expect((await request('/page', actor)).status).toBe(
        actor === 'owner' || actor === 'administrator' ? 200 : 403,
      );
    }
  });

  it.each([
    'settings',
    'channels',
    'notice',
    'page',
  ])('does not save %s after the administrator is removed mid-request', async (section) => {
    let body: unknown = { expectedRevision: 1, active: false };
    if (section === 'settings') {
      const current = await request('/settings', 'administrator');
      expect(current.status).toBe(200);
      const data = (await current.json()).data;
      body = { expectedRevision: data.revision, schemaDigest: data.schemaDigest, values: {} };
    } else if (section === 'page') {
      body = { expectedRevision: 0, content: { introduction: 'Private draft', sections: [] } };
    } else if (section === 'notice') {
      body = {
        expectedRevision: 0,
        notice: {
          displayName: 'Acme',
          privacyUrl: 'https://acme.test/privacy',
          supportUrl: 'mailto:help@acme.test',
        },
      };
    }
    const resolve = workspaces.resolveAccess.bind(workspaces);
    vi.spyOn(workspaces, 'resolveAccess').mockImplementationOnce(async (org, subject) => {
      const before = await resolve(org, subject);
      await workspaces.changeRole({
        org,
        actor: 'owner',
        subject,
        role: null,
        expectedRevision: (await workspaces.inspect(org, 'owner')).revision,
      });
      return before;
    });
    const response = await request(
      `/${section}`,
      'administrator',
      section === 'page' || section === 'notice' ? 'PUT' : 'PATCH',
      body,
    );
    expect(response.status, await response.clone().text()).toBe(403);
    expect((await business.getInstallation(scope))?.intakeActive).toBe(true);
    expect(await business.getBusinessNotice(scope)).toBeUndefined();
    expect(await business.pages.get(scope)).toBeUndefined();
  });

  it.each(
    roles,
  )('allows only workspace administrators to change live setup as %s', async (actor) => {
    const canEdit = actor === 'owner' || actor === 'administrator';
    const current = await request('/settings', 'owner');
    const data = (await current.json()).data;
    const settings = await request('/settings', actor, 'PATCH', {
      expectedRevision: data.revision,
      schemaDigest: data.schemaDigest,
      values: {},
    });
    expect(settings.status, await settings.clone().text()).toBe(canEdit ? 200 : 403);
    const channels = await request('/channels', actor, 'PATCH', {
      expectedRevision: 1,
      active: false,
    });
    expect(channels.status, await channels.clone().text()).toBe(canEdit ? 200 : 403);
    expect((await business.getInstallation(scope))?.intakeActive).toBe(!canEdit);
    const notice = await request('/notice', actor, 'PUT', {
      expectedRevision: 0,
      notice: {
        displayName: 'Acme',
        privacyUrl: 'https://acme.test/privacy',
        supportUrl: 'mailto:help@acme.test',
      },
    });
    expect(notice.status, await notice.clone().text()).toBe(canEdit ? 200 : 403);
    const page = await request('/page', actor, 'PUT', {
      expectedRevision: 0,
      content: { introduction: 'Welcome to Acme', sections: [] },
    });
    expect(page.status, await page.clone().text()).toBe(canEdit ? 200 : 403);
    expect((await business.pages.get(scope))?.revision).toBe(canEdit ? 1 : undefined);
  });

  it('handles and assigns records using current workspace roles, with exports and erasure limited to administrators', async () => {
    const created = await request('/collections/travel_requests/records', 'owner', 'POST', {
      payload: { request_type: 'service', summary: 'Please help' },
    });
    expect(created.status).toBe(201);
    const record = (await created.json()).data.record;
    const path = `/collections/travel_requests/records/${record.id}`;
    for (const assigneeSubject of ['builder', 'viewer', 'legacy-admin']) {
      expect(
        (
          await request(path, 'operator', 'PATCH', {
            operation: 'assign',
            assigneeSubject,
            expectedRevision: 1,
          })
        ).status,
      ).toBe(422);
    }
    expect(
      (
        await request(path, 'operator', 'PATCH', {
          operation: 'assign',
          assigneeSubject: 'operator',
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    for (const role of ['owner', 'administrator', 'operator', 'viewer', 'builder']) {
      const response = await request('/collections/travel_requests/records/export', role);
      expect(response.status, role).toBe(role === 'owner' || role === 'administrator' ? 200 : 403);
    }
    expect((await request(path, 'operator', 'DELETE', { expectedRevision: 2 })).status).toBe(403);
    expect((await request(path, 'administrator', 'DELETE', { expectedRevision: 2 })).status).toBe(
      200,
    );
  });

  it('offers only active workspace members who can handle records, without inventing emails', async () => {
    const response = await request('/assignees', 'operator');
    expect(response.status).toBe(200);
    expect((await response.json()).data.assignees).toEqual([
      { subject: 'owner', role: 'owner', authorityVersion: 1 },
      { subject: 'administrator', role: 'administrator', authorityVersion: 1 },
      { subject: 'operator', role: 'operator', authorityVersion: 1 },
    ]);
    for (const actor of ['builder', 'viewer', 'legacy-admin'])
      expect((await request('/assignees', actor)).status).toBe(403);
  });

  it('rechecks the current role at a save after the browser request was initially authorized', async () => {
    const resolve = workspaces.resolveAccess.bind(workspaces);
    vi.spyOn(workspaces, 'resolveAccess').mockImplementationOnce(async (org, subject) => {
      const previous = await resolve(org, subject);
      await workspaces.changeRole({
        org,
        actor: 'owner',
        subject: 'operator',
        role: null,
        expectedRevision: (await workspaces.inspect(org, 'owner')).revision,
      });
      return previous;
    });
    const response = await request('/collections/travel_requests/records', 'operator', 'POST', {
      payload: { request_type: 'service', summary: 'Must not be saved after revocation' },
    });
    expect(response.status).toBe(403);
    expect(
      (await business.listRequests({ scope, collectionKey: 'travel_requests' })).records,
    ).toHaveLength(0);
  });

  it.each([
    'list',
    'detail',
    'export',
    'activity',
  ])('rechecks access before reading a native %s after authorization changes', async (kind) => {
    const created = await request('/collections/travel_requests/records', 'owner', 'POST', {
      payload: { request_type: 'service', summary: 'Private enquiry' },
    });
    const record = (await created.json()).data.record;
    const resolve = workspaces.resolveAccess.bind(workspaces);
    vi.spyOn(workspaces, 'resolveAccess').mockImplementationOnce(async (org, subject) => {
      const previous = await resolve(org, subject);
      await workspaces.changeRole({
        org,
        actor: 'owner',
        subject: 'administrator',
        role: null,
        expectedRevision: (await workspaces.inspect(org, 'owner')).revision,
      });
      return previous;
    });
    const suffix =
      kind === 'list'
        ? ''
        : kind === 'export'
          ? '/export'
          : `/${record.id}${kind === 'activity' ? '/activity' : ''}`;
    const response = await request(
      `/collections/travel_requests/records${suffix}`,
      'administrator',
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('Private enquiry');
  });
});
