import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  InMemoryServicePrincipalStore,
  ServerRegistry,
  type ServiceOptions,
  type ServicePrincipalRuntime,
} from '../src/index.js';

const NOW = '2026-08-03T12:00:00.000Z';

let http: Server;
let base: string;
let controlPlane: InMemoryControlPlaneStore;
let principals: InMemoryServicePrincipalStore;
let audit: InMemoryAuditStore;
let publicJwk: Record<string, unknown>;

function gate() {
  return {
    authorize: (req: { headers: Record<string, unknown> }) => {
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (token === 'member-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'usr_member', email: 'member@acme.test', superAdmin: false },
        });
      }
      if (token === 'other-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'usr_other', email: 'other@rival.test', superAdmin: false },
        });
      }
      return Promise.resolve({ ok: false as const, status: 401 as const, message: 'unauthorized' });
    },
  };
}

async function start(runtime: ServicePrincipalRuntime = { ready: true, store: principals }) {
  const registry = new ServerRegistry();
  vi.spyOn(registry, 'getEnvironment').mockImplementation(async (org, app, env) =>
    org === 'acme' && app === 'todoist' && env === 'prod'
      ? {
          orgSlug: org,
          appSlug: app,
          envName: env,
          isProduction: true,
          active: true,
          createdAt: NOW,
          deploymentCount: 1,
        }
      : undefined,
  );
  const options: ServiceOptions = {
    controlPlaneStore: controlPlane,
    deployGate: gate(),
    audit,
    servicePrincipalRuntime: runtime,
    maxBodyBytes: 1_024,
  };
  http = createServer(createServiceHandler(registry, options));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

async function api(
  path: string,
  token = 'member-token',
  init: { readonly method?: string; readonly body?: unknown } = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  const keys = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  publicJwk = await exportJWK(keys.publicKey);
  controlPlane = new InMemoryControlPlaneStore({ now: () => new Date(NOW) });
  await controlPlane.createOrg({ slug: 'acme' });
  await controlPlane.createOrg({ slug: 'rival' });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'usr_member',
    email: 'member@acme.test',
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'rival',
    subject: 'usr_other',
    email: 'other@rival.test',
    role: 'owner',
  });
  principals = new InMemoryServicePrincipalStore({ now: () => new Date(NOW) });
  audit = new InMemoryAuditStore({ now: () => new Date(NOW) });
});

afterEach(async () => {
  if (http?.listening) {
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

describe('service-principal management API', () => {
  it('creates, lists, shows, and revokes an organization-owned principal', async () => {
    await start();
    const created = await api('/v1/orgs/acme/service-principals', 'member-token', {
      method: 'POST',
      body: { name: 'nightly sync' },
    });
    expect(created).toMatchObject({
      status: 201,
      body: { ok: true, data: { name: 'nightly sync', status: 'active' } },
    });
    const principalId = (created.body as { data: { principalId: string } }).data.principalId;

    await expect(api('/v1/orgs/acme/service-principals')).resolves.toMatchObject({
      status: 200,
      body: { ok: true, data: [expect.objectContaining({ principalId })] },
    });
    await expect(api(`/v1/orgs/acme/service-principals/${principalId}`)).resolves.toMatchObject({
      status: 200,
      body: { ok: true, data: { principal: { principalId }, grants: [], credentials: [] } },
    });
    await expect(
      api(`/v1/orgs/acme/service-principals/${principalId}`, 'member-token', {
        method: 'DELETE',
      }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await expect(audit.list({ org: 'acme' })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'service_principal.created' }),
        expect.objectContaining({ eventType: 'service_principal.revoked' }),
      ]),
    );
  });

  it('returns a client secret once and never exposes secret or key material on later reads', async () => {
    await start();
    const created = await api('/v1/orgs/acme/service-principals', 'member-token', {
      method: 'POST',
      body: { name: 'automation' },
    });
    const principalId = (created.body as { data: { principalId: string } }).data.principalId;
    const secret = await api(
      `/v1/orgs/acme/service-principals/${principalId}/credentials`,
      'member-token',
      { method: 'POST', body: { kind: 'client_secret', label: 'primary' } },
    );
    expect(secret).toMatchObject({
      status: 201,
      body: { ok: true, data: { kind: 'client_secret', secret: expect.any(String) } },
    });
    const rawSecret = (secret.body as { data: { secret: string } }).data.secret;
    expect(rawSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const jwk = await api(
      `/v1/orgs/acme/service-principals/${principalId}/credentials`,
      'member-token',
      {
        method: 'POST',
        body: { kind: 'public_jwk', label: 'signer', algorithm: 'RS256', publicJwk },
      },
    );
    expect(jwk.status).toBe(201);

    const shown = await api(`/v1/orgs/acme/service-principals/${principalId}`);
    const serialized = JSON.stringify(shown.body);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain('secretDigest');
    expect(serialized).not.toContain('publicJwk');
    expect(serialized).not.toContain(String(publicJwk.n));
  });

  it('manages target-bound grants only for existing logical environments', async () => {
    await start();
    const created = await api('/v1/orgs/acme/service-principals', 'member-token', {
      method: 'POST',
      body: { name: 'todo worker' },
    });
    const principalId = (created.body as { data: { principalId: string } }).data.principalId;
    const grant = await api(
      `/v1/orgs/acme/service-principals/${principalId}/grants`,
      'member-token',
      {
        method: 'POST',
        body: {
          app: 'todoist',
          environment: 'prod',
          scopes: ['todos.read', 'todos.write'],
        },
      },
    );
    expect(grant).toMatchObject({
      status: 201,
      body: { data: { scopes: ['todos.read', 'todos.write'] } },
    });
    const grantId = (grant.body as { data: { grantId: string } }).data.grantId;

    await expect(
      api(`/v1/orgs/acme/service-principals/${principalId}/grants/${grantId}`, 'member-token', {
        method: 'DELETE',
      }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await expect(
      api(`/v1/orgs/acme/service-principals/${principalId}/grants`, 'member-token', {
        method: 'POST',
        body: { app: 'missing', environment: 'prod', scopes: [] },
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it('authenticates before bodies and conceals records from anonymous and cross-org callers', async () => {
    await start();
    const created = await api('/v1/orgs/acme/service-principals', 'member-token', {
      method: 'POST',
      body: { name: 'private worker' },
    });
    const principalId = (created.body as { data: { principalId: string } }).data.principalId;

    const anonymous = await fetch(`${base}/v1/orgs/acme/service-principals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(anonymous.status).toBe(401);
    await expect(
      api(`/v1/orgs/acme/service-principals/${principalId}`, 'other-token'),
    ).resolves.toMatchObject({ status: 404, body: { error: 'not found' } });
  });

  it('rejects strict, unsafe, duplicate, private-key, oversized, and unsupported requests before mutation', async () => {
    await start();
    for (const body of [{ name: 'worker', extra: true }, { name: 'bad\nname' }, { name: '' }]) {
      await expect(
        api('/v1/orgs/acme/service-principals', 'member-token', { method: 'POST', body }),
      ).resolves.toMatchObject({ status: 400 });
    }
    expect(await principals.listPrincipals('acme')).toEqual([]);

    const created = await api('/v1/orgs/acme/service-principals', 'member-token', {
      method: 'POST',
      body: { name: 'valid worker' },
    });
    const principalId = (created.body as { data: { principalId: string } }).data.principalId;
    await expect(
      api(`/v1/orgs/acme/service-principals/${principalId}/grants`, 'member-token', {
        method: 'POST',
        body: { app: 'todoist', environment: 'prod', scopes: ['todos.read', 'todos.read'] },
      }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      api(`/v1/orgs/acme/service-principals/${principalId}/credentials`, 'member-token', {
        method: 'POST',
        body: {
          kind: 'public_jwk',
          label: 'private',
          algorithm: 'RS256',
          publicJwk: { ...publicJwk, d: 'private' },
        },
      }),
    ).resolves.toMatchObject({ status: 400 });

    const oversized = await fetch(`${base}/v1/orgs/acme/service-principals`, {
      method: 'POST',
      headers: { authorization: 'Bearer member-token', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(2_000) }),
    });
    expect(oversized.status).toBe(413);
    const unsupported = await fetch(`${base}/v1/orgs/acme/service-principals`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer member-token' },
    });
    expect(unsupported.status).toBe(405);
  });

  it('returns stable unavailable state after human authorization', async () => {
    await start({ ready: false, reason: 'schema_unavailable' });
    await expect(api('/v1/orgs/acme/service-principals')).resolves.toEqual({
      status: 503,
      body: { error: 'service_principals_unavailable' },
    });
  });
});
