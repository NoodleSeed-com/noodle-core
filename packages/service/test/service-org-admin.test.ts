import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  type InvitationEmailSender,
  ResendEmailSender,
  ServerRegistry,
} from '../src/index.js';

/**
 * Org administration routes (issue #267): invitation list/revoke, org rename, and member role change,
 * with owner-only authorization, the last-owner guard, and durable audit events for every mutation.
 */

const verifier: GoogleIdTokenVerifier = {
  verify: async (token: string) => {
    if (token === 'owner') return { subject: 'sub-owner', email: 'owner@noodleseed.com' };
    if (token === 'dev') return { subject: 'sub-dev', email: 'dev@noodleseed.com' };
    if (token === 'admin') return { subject: 'sub-admin', email: 'admin@noodleseed.com' };
    if (token === 'newbie') return { subject: 'sub-new', email: 'newbie@noodleseed.com' };
    throw new Error('bad token');
  },
};

async function listenOrgAdmin(
  options: { readonly invitationEmailSender?: InvitationEmailSender } = {},
): Promise<{
  url: string;
  store: InMemoryControlPlaneStore;
  audit: InMemoryAuditStore;
  close: () => Promise<void>;
}> {
  const store = new InMemoryControlPlaneStore();
  const audit = new InMemoryAuditStore();
  await store.createOrg({ slug: 'acme', displayName: 'Acme' });
  await store.addOrgMember({
    org: 'acme',
    subject: 'sub-owner',
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
  await store.addOrgMember({
    org: 'acme',
    subject: 'sub-dev',
    email: 'dev@noodleseed.com',
    role: 'developer',
  });
  const srv = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: store,
      audit,
      ...(options.invitationEmailSender !== undefined
        ? {
            invitationEmailSender: options.invitationEmailSender,
            invitationConsoleBaseUrl: 'https://console.noodleseed.dev',
          }
        : {}),
      deployGate: new GoogleControlPlaneGate({
        audience: 'client-id',
        admins: ['admin@noodleseed.com'],
        verifier,
      }),
    }),
  );
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    store,
    audit,
    close: () =>
      new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('invitation email delivery', () => {
  it('sends the invite through the Resend boundary with a console acceptance link', async () => {
    const resendFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'email_invite' }));
    const sender = new ResendEmailSender({
      apiKey: 'test-resend-key',
      welcomeFrom: 'Asad <asad@noodleseed.com>',
      invitationFrom: 'Noodle Seed <hello@noodleseed.com>',
      fetch: resendFetch,
    });
    const srv = await listenOrgAdmin({ invitationEmailSender: sender });
    try {
      const res = await call(srv.url, '/v1/orgs/acme/invitations', 'owner', {
        method: 'POST',
        body: { email: 'newbie@noodleseed.com', role: 'developer' },
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ emailDelivery: 'sent' });
      expect(resendFetch).toHaveBeenCalledOnce();
      const request = JSON.parse(String(resendFetch.mock.calls[0]?.[1]?.body)) as Record<
        string,
        unknown
      >;
      expect(request).toMatchObject({
        from: 'Noodle Seed <hello@noodleseed.com>',
        to: ['newbie@noodleseed.com'],
        subject: 'Owner invited you to Acme on Noodle Seed',
      });
      expect(request.html).toMatch(
        /https:\/\/console\.noodleseed\.dev\/invitations\/accept\?org=acme#token=/,
      );
      expect(new Headers(resendFetch.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toMatch(
        /^invitation\.[a-f0-9]{64}$/,
      );
    } finally {
      await srv.close();
    }
  });
});

function call(
  base: string,
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function invite(base: string, email: string, role = 'developer'): Promise<string> {
  const res = await call(base, '/v1/orgs/acme/invitations', 'owner', {
    method: 'POST',
    body: { email, role },
  });
  expect(res.status).toBe(201);
  return (await res.json()).acceptPath as string;
}

describe('invitation listing', () => {
  it('lists pending invitations for owners only and never exposes token material', async () => {
    const srv = await listenOrgAdmin();
    try {
      await invite(srv.url, 'newbie@noodleseed.com');
      expect((await call(srv.url, '/v1/orgs/acme/invitations', 'dev')).status).toBe(403);

      const res = await call(srv.url, '/v1/orgs/acme/invitations', 'owner');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('tokenHash');
      const body = JSON.parse(text);
      expect(body.ok).toBe(true);
      expect(body.invitations).toEqual([
        expect.objectContaining({
          email: 'newbie@noodleseed.com',
          role: 'developer',
          status: 'pending',
        }),
      ]);
    } finally {
      await srv.close();
    }
  });

  it('hides accepted invitations by default and includes them with ?all=true', async () => {
    const srv = await listenOrgAdmin();
    try {
      const acceptPath = await invite(srv.url, 'newbie@noodleseed.com');
      expect((await call(srv.url, acceptPath, 'newbie', { method: 'POST' })).status).toBe(201);

      const pending = await (await call(srv.url, '/v1/orgs/acme/invitations', 'owner')).json();
      expect(pending.invitations).toEqual([]);

      const all = await (await call(srv.url, '/v1/orgs/acme/invitations?all=true', 'owner')).json();
      expect(all.invitations).toEqual([
        expect.objectContaining({ email: 'newbie@noodleseed.com', status: 'accepted' }),
      ]);
    } finally {
      await srv.close();
    }
  });
});

describe('invitation revocation', () => {
  it('revokes pending invitations by email (owner-only) and invalidates their tokens', async () => {
    const srv = await listenOrgAdmin();
    try {
      const acceptPath = await invite(srv.url, 'newbie@noodleseed.com');
      expect(
        (
          await call(srv.url, '/v1/orgs/acme/invitations', 'dev', {
            method: 'DELETE',
            body: { email: 'newbie@noodleseed.com' },
          })
        ).status,
      ).toBe(403);

      const missing = await call(srv.url, '/v1/orgs/acme/invitations', 'owner', {
        method: 'DELETE',
        body: {},
      });
      expect(missing.status).toBe(400);

      const revoked = await call(srv.url, '/v1/orgs/acme/invitations', 'owner', {
        method: 'DELETE',
        body: { email: 'newbie@noodleseed.com' },
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ ok: true, revoked: 1 });

      // The minted token no longer accepts.
      expect((await call(srv.url, acceptPath, 'newbie', { method: 'POST' })).status).toBe(404);

      const events = await srv.audit.list({ org: 'acme', eventType: 'org.invitation.revoked' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorSubject: 'sub-owner',
        decision: 'allow',
        details: { email: 'newbie@noodleseed.com', revoked: 1 },
      });
    } finally {
      await srv.close();
    }
  });
});

describe('org rename', () => {
  it('lets owners rename their org and audits the change', async () => {
    const srv = await listenOrgAdmin();
    try {
      expect(
        (
          await call(srv.url, '/v1/orgs/acme', 'dev', {
            method: 'PATCH',
            body: { displayName: 'Nope' },
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(srv.url, '/v1/orgs/acme', 'owner', { method: 'PATCH', body: {} })).status,
      ).toBe(400);
      expect(
        (
          await call(srv.url, '/v1/orgs/acme', 'owner', {
            method: 'PATCH',
            body: { displayName: '   ' },
          })
        ).status,
      ).toBe(400);

      const res = await call(srv.url, '/v1/orgs/acme', 'owner', {
        method: 'PATCH',
        body: { displayName: 'Acme Industries' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).org).toMatchObject({
        slug: 'acme',
        displayName: 'Acme Industries',
      });
      expect((await srv.store.listOrgs())[0]?.displayName).toBe('Acme Industries');

      const events = await srv.audit.list({ org: 'acme', eventType: 'org.renamed' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorSubject: 'sub-owner',
        details: { displayName: 'Acme Industries' },
      });
    } finally {
      await srv.close();
    }
  });

  it('returns 404 for unknown orgs (super-admin path) instead of creating them', async () => {
    const srv = await listenOrgAdmin();
    try {
      const res = await call(srv.url, '/v1/orgs/ghost', 'admin', {
        method: 'PATCH',
        body: { displayName: 'Ghost' },
      });
      expect(res.status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});

describe('member role change', () => {
  it('changes roles owner-only, blocks demoting the last owner, and audits changes', async () => {
    const srv = await listenOrgAdmin();
    try {
      expect(
        (
          await call(srv.url, '/v1/orgs/acme/members/sub-owner', 'dev', {
            method: 'PATCH',
            body: { role: 'owner' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call(srv.url, '/v1/orgs/acme/members/sub-ghost', 'owner', {
            method: 'PATCH',
            body: { role: 'owner' },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call(srv.url, '/v1/orgs/acme/members/sub-dev', 'owner', {
            method: 'PATCH',
            body: { role: 'admin' },
          })
        ).status,
      ).toBe(400);

      // sub-owner is the only owner: demoting itself must be blocked.
      const lastOwner = await call(srv.url, '/v1/orgs/acme/members/sub-owner', 'owner', {
        method: 'PATCH',
        body: { role: 'developer' },
      });
      expect(lastOwner.status).toBe(409);

      const promoted = await call(srv.url, '/v1/orgs/acme/members/sub-dev', 'owner', {
        method: 'PATCH',
        body: { role: 'owner' },
      });
      expect(promoted.status).toBe(200);
      expect((await promoted.json()).member).toMatchObject({ subject: 'sub-dev', role: 'owner' });

      // Two owners now: demoting one is fine.
      const demoted = await call(srv.url, '/v1/orgs/acme/members/sub-owner', 'dev', {
        method: 'PATCH',
        body: { role: 'developer' },
      });
      expect(demoted.status).toBe(200);

      const events = await srv.audit.list({ org: 'acme', eventType: 'org.member.role_changed' });
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.details)).toEqual(
        expect.arrayContaining([
          { subject: 'sub-dev', role: 'owner' },
          { subject: 'sub-owner', role: 'developer' },
        ]),
      );
    } finally {
      await srv.close();
    }
  });
});

describe('member removal guard and audit', () => {
  it('blocks removing the last owner, allows other removals, and audits them', async () => {
    const srv = await listenOrgAdmin();
    try {
      const lastOwner = await call(srv.url, '/v1/orgs/acme/members/sub-owner', 'owner', {
        method: 'DELETE',
      });
      expect(lastOwner.status).toBe(409);
      expect(await srv.store.isOrgMember({ org: 'acme', subject: 'sub-owner' })).toBe(true);

      // The add route upserts, so re-adding the last owner with a weaker role is also a demotion.
      const upsertDemote = await call(srv.url, '/v1/orgs/acme/members', 'owner', {
        method: 'POST',
        body: { subject: 'sub-owner', email: 'owner@noodleseed.com', role: 'developer' },
      });
      expect(upsertDemote.status).toBe(409);

      const removed = await call(srv.url, '/v1/orgs/acme/members/sub-dev', 'owner', {
        method: 'DELETE',
      });
      expect(removed.status).toBe(204);

      const events = await srv.audit.list({ org: 'acme', eventType: 'org.member.removed' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorSubject: 'sub-owner',
        details: { subject: 'sub-dev' },
      });
    } finally {
      await srv.close();
    }
  });

  it('audits member adds, invitation creates, and invitation accepts without token material', async () => {
    const srv = await listenOrgAdmin();
    try {
      const added = await call(srv.url, '/v1/orgs/acme/members', 'owner', {
        method: 'POST',
        body: { subject: 'sub-extra', email: 'extra@noodleseed.com', role: 'developer' },
      });
      expect(added.status).toBe(201);

      const acceptPath = await invite(srv.url, 'newbie@noodleseed.com');
      expect((await call(srv.url, acceptPath, 'newbie', { method: 'POST' })).status).toBe(201);

      const events = await srv.audit.list({ org: 'acme' });
      const types = events.map((event) => event.eventType);
      expect(types).toContain('org.member.added');
      expect(types).toContain('org.invitation.created');
      expect(types).toContain('org.invitation.accepted');
      const flat = JSON.stringify(events);
      expect(flat).not.toContain('tokenHash');
      // The raw invitation token (last accept path segment before /accept) must never be audited.
      const rawToken = acceptPath.split('/').at(-2) as string;
      expect(flat).not.toContain(rawToken);
    } finally {
      await srv.close();
    }
  });

  it('returns conflict without success audit when a co-owner targets the personal owner', async () => {
    const srv = await listenOrgAdmin();
    const personalOrg = 'u-owner-12345678';
    try {
      await srv.store.provisionPersonalWorkspace({
        slug: personalOrg,
        displayName: 'Owner workspace',
        subject: 'sub-owner',
        email: 'owner@noodleseed.com',
      });
      await srv.store.addOrgMember({
        org: personalOrg,
        subject: 'sub-dev',
        email: 'dev@noodleseed.com',
        role: 'owner',
      });

      const demoted = await call(srv.url, `/v1/orgs/${personalOrg}/members/sub-owner`, 'dev', {
        method: 'PATCH',
        body: { role: 'developer' },
      });
      expect(demoted.status).toBe(409);
      const upserted = await call(srv.url, `/v1/orgs/${personalOrg}/members`, 'dev', {
        method: 'POST',
        body: {
          subject: 'sub-owner',
          email: 'owner@noodleseed.com',
          role: 'developer',
        },
      });
      expect(upserted.status).toBe(409);
      const removed = await call(srv.url, `/v1/orgs/${personalOrg}/members/sub-owner`, 'dev', {
        method: 'DELETE',
      });
      expect(removed.status).toBe(409);
      await expect(
        srv.store.getOrgMember({ org: personalOrg, subject: 'sub-owner' }),
      ).resolves.toMatchObject({ role: 'owner' });
      await expect(srv.audit.list({ org: personalOrg })).resolves.toEqual([]);
    } finally {
      await srv.close();
    }
  });
});

describe('org creation validation', () => {
  it('keeps the local loopback organization unavailable to customer creation', async () => {
    const srv = await listenOrgAdmin();
    try {
      const response = await call(srv.url, '/v1/orgs', 'admin', {
        method: 'POST',
        body: { slug: 'local', displayName: 'Customer Local' },
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringMatching(/reserved|system/i),
      });
      expect(await srv.store.getOrg('local')).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('applies the same displayName rules as rename (trimmed, non-empty, capped)', async () => {
    const srv = await listenOrgAdmin();
    try {
      expect(
        (
          await call(srv.url, '/v1/orgs', 'admin', {
            method: 'POST',
            body: { slug: 'blank', displayName: '   ' },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(srv.url, '/v1/orgs', 'admin', {
            method: 'POST',
            body: { slug: 'big', displayName: 'x'.repeat(201) },
          })
        ).status,
      ).toBe(400);
      const res = await call(srv.url, '/v1/orgs', 'admin', {
        method: 'POST',
        body: { slug: 'tidy', displayName: '  Tidy Co  ' },
      });
      expect(res.status).toBe(201);
      expect((await res.json()).org).toMatchObject({ slug: 'tidy', displayName: 'Tidy Co' });
    } finally {
      await srv.close();
    }
  });
});
