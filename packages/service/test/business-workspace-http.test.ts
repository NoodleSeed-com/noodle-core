import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryApplicationDraftBackend } from '../src/application-drafts/memory.js';
import { ApplicationDraftStore } from '../src/application-drafts/store.js';
import { BusinessMemoryLocks } from '../src/business-information/in-memory-locks.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';

describe('versioned workspace administration API', () => {
  let server: Server, base: string, workspaces: BusinessWorkspaceStore;
  const suspended = new Set<string>();
  let emailVerification: 'verified' | 'unavailable' | 'missing';
  beforeEach(async () => {
    suspended.clear();
    emailVerification = 'verified';
    const locks = new BusinessMemoryLocks();
    workspaces = new BusinessWorkspaceStore(new InMemoryBusinessWorkspaceBackend(locks), {
      isIdentityActive: async (subject) => !suspended.has(subject),
    });
    await workspaces.initializeNewWorkspace({ org: 'acme', ownerSubject: 'owner' });
    const drafts = new ApplicationDraftStore(new InMemoryApplicationDraftBackend(locks), {
      authorize: async (scope, actor, permission) =>
        (await workspaces.authorize(scope.org, actor, permission)) === 'allowed',
    });
    server = createServer(
      createServiceHandler(new ServerRegistry(), {
        businessInformationEnabled: false,
        businessAuthoring: {
          drafts,
          workspaces,
          verifiedEmail: async (subject, email) => {
            if (emailVerification === 'unavailable')
              throw new Error('private identity provider failure');
            return emailVerification === 'verified' &&
              subject !== 'unverified' &&
              email === `${subject}@example.test`
              ? email
              : undefined;
          },
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orgs/acme/business-workspace`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const request = (method = 'GET', suffix = '', body?: unknown, actor = 'owner') =>
    fetch(`${base}${suffix}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(actor ? { authorization: `Bearer ${actor}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function invite(email = 'operator@example.test', role?: string) {
    const response = await request('POST', '/invitations', {
      email,
      expectedRevision: (await workspaces.inspect('acme', 'owner')).revision,
      ...(role ? { role } : {}),
    });
    expect(response.status).toBe(201);
    return (await response.json()).data;
  }
  it('returns only current staff projections, not invitation hashes or legacy/developer authority', async () => {
    expect((await request('GET', '', undefined, '')).status).toBe(401);
    for (const actor of ['stranger', 'super-admin'])
      expect((await request('GET', '', undefined, actor)).status).toBe(403);
    const invitation = await invite();
    const state = await request();
    expect(state.status).toBe(200);
    expect(state.headers.get('cache-control')).toBe('private, no-store');
    const data = await state.json();
    expect(data.data.role).toBe('owner');
    expect(JSON.stringify(data)).not.toContain(invitation.token);
    expect(JSON.stringify(data)).not.toContain('tokenDigest');
    base = base.replace('/acme/', '/legacy/');
    expect((await request()).status).toBe(409);
    expect((await request('POST', '', { ownerSubject: 'owner' })).status).toBe(405);
  });
  it('defaults to Operator, accepts once with verified identity and enforces revision/last-Owner rules', async () => {
    const invitation = await invite();
    expect(invitation.role).toBe('operator');
    expect((await request('POST', '/accept', { token: invitation.token }, 'operator')).status).toBe(
      200,
    );
    expect((await request('POST', '/accept', { token: invitation.token }, 'operator')).status).toBe(
      409,
    );
    const operator = await (await request('GET', '', undefined, 'operator')).json();
    expect(operator.data.role).toBe('operator');
    expect(operator.data.invitations).toEqual([]);
    expect(
      (
        await request('PATCH', '/members', {
          subject: 'operator',
          role: 'viewer',
          expectedRevision: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (await request('PATCH', '/members', { subject: 'owner', role: null, expectedRevision: 3 }))
        .status,
    ).toBe(409);
    expect(
      (
        await request('PATCH', '/members', {
          subject: 'operator',
          role: 'viewer',
          expectedRevision: 3,
        })
      ).status,
    ).toBe(200);
    expect((await workspaces.inspect('acme', 'operator')).role).toBe('viewer');
  });
  it('never accepts browser-supplied identity or unverified email, or an invitation after issuer suspension', async () => {
    const invitation = await invite('unverified@example.test');
    expect(
      (await request('POST', '/accept', { token: invitation.token }, 'unverified')).status,
    ).toBe(403);
    expect(
      (
        await request(
          'POST',
          '/accept',
          { token: invitation.token, verifiedEmail: 'unverified@example.test' },
          'owner',
        )
      ).status,
    ).toBe(400);
    const other = await invite();
    suspended.add('owner');
    expect((await request('POST', '/accept', { token: other.token }, 'operator')).status).toBe(409);
    expect((await request()).status).toBe(403);
  });
  it('prevents admin promotion and revokes invitations explicitly', async () => {
    const admin = await invite('admin@example.test', 'administrator');
    expect((await request('POST', '/accept', { token: admin.token }, 'admin')).status).toBe(200);
    expect(
      (
        await request(
          'POST',
          '/invitations',
          { email: 'next@example.test', role: 'owner', expectedRevision: 3 },
          'admin',
        )
      ).status,
    ).toBe(403);
    const invited = await invite();
    expect(
      (await request('DELETE', `/invitations/${invited.id}`, { expectedRevision: 4 })).status,
    ).toBe(200);
    expect((await request('POST', '/accept', { token: invited.token }, 'operator')).status).toBe(
      409,
    );
    expect((await request('GET', '?include=secrets')).status).toBe(400);
  });
  it('fails closed on canonical identity outages without consuming the invitation or exposing diagnostics', async () => {
    const invitation = await invite();
    emailVerification = 'unavailable';
    const response = await request('POST', '/accept', { token: invitation.token }, 'operator');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private identity');
    expect((await workspaces.inspect('acme', 'owner')).revision).toBe(2);
    emailVerification = 'missing';
    expect((await request('POST', '/accept', { token: invitation.token }, 'operator')).status).toBe(
      403,
    );
    emailVerification = 'verified';
    expect((await request('POST', '/accept', { token: invitation.token }, 'operator')).status).toBe(
      200,
    );
  });
  it('rejects extra identity fields, malformed roles and oversized mutation bodies without changing state', async () => {
    for (const body of [
      { email: 'staff@example.test', expectedRevision: 1, actor: 'owner' },
      { email: 'staff@example.test', expectedRevision: 1, role: 'superuser' },
      { email: 'staff@example.test', expectedRevision: 1, extra: 'x'.repeat(17 * 1024) },
    ]) {
      expect([400, 413]).toContain((await request('POST', '/invitations', body)).status);
    }
    expect((await workspaces.inspect('acme', 'owner')).revision).toBe(1);
  });
  it('does not expose workspace routes without explicit authoring composition', async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server = createServer(createServiceHandler(new ServerRegistry()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orgs/acme/business-workspace`;
    expect((await request()).status).toBe(404);
    expect((await request('POST', '/accept', { token: 'x'.repeat(43) })).status).toBe(404);
  });
});
