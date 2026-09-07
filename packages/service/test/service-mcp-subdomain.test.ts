import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const verifier: GoogleIdTokenVerifier = {
  verify: async (token: string) => {
    if (token === 'owner') return { subject: 'owner-sub', email: 'owner@example.com' };
    if (token === 'dev') return { subject: 'dev-sub', email: 'dev@example.com' };
    if (token === 'other-owner') {
      return { subject: 'other-owner-sub', email: 'other-owner@example.com' };
    }
    if (token === 'admin') return { subject: 'admin-sub', email: 'admin@example.com' };
    if (token === 'outsider') return { subject: 'outside-sub', email: 'outside@example.com' };
    throw new Error('bad token');
  },
};

describe('organization MCP subdomain service resource', () => {
  it('lets current members read only the current setting without a super-admin bypass', async () => {
    const srv = await listen();
    try {
      for (const token of ['owner', 'dev']) {
        const response = await call(srv.url, 'acme', token);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          ok: true,
          data: {
            orgSlug: 'acme',
            mcpSubdomain: 'acme',
            mcpServerHost: 'acme.borg.noodleseed.test',
            changeAllowedAt: null,
          },
        });
      }
      for (const token of ['admin', 'outsider']) {
        const response = await call(srv.url, 'acme', token);
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          ok: false,
          code: 'organization_member_required',
        });
      }
    } finally {
      await srv.close();
    }
  });

  it('requires an exact owner, idempotency header, and explicit URL-breakage acknowledgement', async () => {
    const srv = await listen();
    try {
      for (const token of ['dev', 'admin', 'outsider']) {
        const response = await change(srv.url, 'acme', 'acme-new', token, 'owner-guard-key');
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          ok: false,
          code: 'organization_owner_required',
        });
      }
      const noKey = await call(srv.url, 'acme', 'owner', {
        method: 'PUT',
        body: { mcpSubdomain: 'acme-new', acknowledgeOldUrlsStopWorking: true },
      });
      expect(noKey.status).toBe(400);
      await expect(noKey.json()).resolves.toMatchObject({ code: 'idempotency_key_required' });

      const noAcknowledgement = await call(srv.url, 'acme', 'owner', {
        method: 'PUT',
        idempotencyKey: 'ack-required-key',
        body: { mcpSubdomain: 'acme-new' },
      });
      expect(noAcknowledgement.status).toBe(400);
      await expect(noAcknowledgement.json()).resolves.toMatchObject({
        code: 'mcp_subdomain_acknowledgement_required',
      });
      await expect(srv.store.getActiveMcpSubdomain('acme')).resolves.toMatchObject({
        mcpSubdomain: 'acme',
      });
    } finally {
      await srv.close();
    }
  });

  it('changes once, retires the old host immediately, replays without duplicate audit, and exposes cooldown', async () => {
    const srv = await listen();
    try {
      const changed = await change(srv.url, 'acme', 'acme-new', 'owner', 'stable-change-key');
      expect(changed.status).toBe(200);
      const body = await changed.json();
      expect(body).toEqual({
        ok: true,
        data: {
          orgSlug: 'acme',
          previousMcpSubdomain: 'acme',
          previousMcpServerHost: 'acme.borg.noodleseed.test',
          mcpSubdomain: 'acme-new',
          mcpServerHost: 'acme-new.borg.noodleseed.test',
          changed: true,
          replayed: false,
          changedAt: '2026-08-11T12:00:00.000Z',
          changeAllowedAt: '2026-09-10T12:00:00.000Z',
          oldUrlsInvalidated: true,
          reauthorizationRequired: true,
        },
      });
      await expect(srv.store.resolveActiveMcpSubdomain('acme')).resolves.toBeUndefined();
      await expect(srv.store.resolveActiveMcpSubdomain('acme-new')).resolves.toMatchObject({
        orgSlug: 'acme',
      });

      const replay = await change(srv.url, 'acme', 'acme-new', 'owner', 'stable-change-key');
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        data: { changed: true, replayed: true, changeAllowedAt: body.data.changeAllowedAt },
      });
      const events = await srv.audit.list({ org: 'acme', eventType: 'org.mcp_subdomain.changed' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorSubject: 'owner-sub',
        details: { previousMcpSubdomain: 'acme', mcpSubdomain: 'acme-new' },
      });
      expect(JSON.stringify(events)).not.toContain('stable-change-key');

      const read = await call(srv.url, 'acme', 'dev');
      await expect(read.json()).resolves.toMatchObject({
        data: { mcpSubdomain: 'acme-new', changeAllowedAt: body.data.changeAllowedAt },
      });
    } finally {
      await srv.close();
    }
  });

  it('keeps no-op cooldown-neutral and returns stable conflict categories without claim ownership', async () => {
    const srv = await listen();
    try {
      const noOp = await change(srv.url, 'acme', 'acme', 'owner', 'noop-request-key');
      expect(noOp.status).toBe(200);
      await expect(noOp.json()).resolves.toMatchObject({
        data: {
          changed: false,
          changeAllowedAt: null,
          oldUrlsInvalidated: false,
          reauthorizationRequired: false,
        },
      });
      await expect(
        srv.audit.list({ org: 'acme', eventType: 'org.mcp_subdomain.changed' }),
      ).resolves.toHaveLength(0);

      await change(srv.url, 'other-org', 'other-new', 'other-owner', 'retire-other-key');
      for (const unavailable of ['other-new', 'other-org']) {
        const response = await change(
          srv.url,
          'acme',
          unavailable,
          'owner',
          `collision-${unavailable}`,
        );
        expect(response.status).toBe(409);
        const text = await response.text();
        expect(text).toContain('mcp_subdomain_unavailable');
        expect(text).not.toContain('other-owner');
      }

      const changed = await change(srv.url, 'acme', 'acme-new', 'owner', 'cooldown-first-key');
      expect(changed.status).toBe(200);
      const cooldown = await change(srv.url, 'acme', 'acme-next', 'owner', 'cooldown-next-key');
      expect(cooldown.status).toBe(429);
      await expect(cooldown.json()).resolves.toMatchObject({
        ok: false,
        code: 'mcp_subdomain_cooldown',
        changeAllowedAt: '2026-09-10T12:00:00.000Z',
      });

      const mismatch = await change(srv.url, 'acme', 'different', 'owner', 'cooldown-first-key');
      expect(mismatch.status).toBe(409);
      await expect(mismatch.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });
    } finally {
      await srv.close();
    }
  });
});

async function listen() {
  let now = new Date('2026-08-11T12:00:00.000Z');
  const store = new InMemoryControlPlaneStore({ now: () => now });
  const audit = new InMemoryAuditStore({ now: () => now });
  await store.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner-sub', email: 'owner@example.com' },
  });
  await store.addOrgMember({
    org: 'acme',
    subject: 'dev-sub',
    email: 'dev@example.com',
    role: 'developer',
  });
  await store.createOrgWithOwner({
    slug: 'other-org',
    owner: { subject: 'other-owner-sub', email: 'other-owner@example.com' },
  });
  const server = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: store,
      audit,
      clock: () => now,
      mcpPublicRouting: { publicBaseDomain: 'borg.noodleseed.test' },
      deployGate: new GoogleControlPlaneGate({
        audience: 'client-id',
        admins: ['admin@example.com'],
        signupMode: 'public',
        verifier,
      }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    audit,
    setNow: (value: Date) => {
      now = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function change(
  base: string,
  org: string,
  mcpSubdomain: string,
  token: string,
  idempotencyKey: string,
): Promise<Response> {
  return call(base, org, token, {
    method: 'PUT',
    idempotencyKey,
    body: { mcpSubdomain, acknowledgeOldUrlsStopWorking: true },
  });
}

function call(
  base: string,
  org: string,
  token: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<Response> {
  return fetch(`${base}/v1/orgs/${encodeURIComponent(org)}/mcp-subdomain`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.idempotencyKey === undefined ? {} : { 'idempotency-key': init.idempotencyKey }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
