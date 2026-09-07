import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ControlPlaneIdentity,
  createServiceHandler,
  type DeployAuthGate,
  InMemoryAuditStore,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`;
const NOW_MILLISECONDS = 1_800_000_000_000;

const identities: Readonly<Record<string, Omit<ControlPlaneIdentity, 'authTime'>>> = {
  owner: {
    subject: 'owner-sub',
    email: 'owner@noodleseed.com',
    superAdmin: false,
  },
  boundary: {
    subject: 'owner-sub',
    email: 'owner@noodleseed.com',
    superAdmin: false,
  },
  missing_freshness: {
    subject: 'owner-sub',
    email: 'owner@noodleseed.com',
    superAdmin: false,
  },
  stale: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: false },
  over_300: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: false },
  future: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: false },
  developer: {
    subject: 'developer-sub',
    email: 'developer@noodleseed.com',
    superAdmin: false,
  },
  outsider: {
    subject: 'outsider-sub',
    email: 'outsider@example.com',
    superAdmin: false,
  },
  domain_only: {
    subject: 'domain-only-sub',
    email: 'domain-only@noodleseed.com',
    superAdmin: false,
  },
  super_admin: {
    subject: 'support-admin-sub',
    email: 'support-admin@noodleseed.com',
    superAdmin: true,
  },
  cross_org: {
    subject: 'cross-org-sub',
    email: 'owner@globex.example',
    superAdmin: false,
  },
};

const gate: DeployAuthGate = {
  authorize(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const baseIdentity = token === undefined ? undefined : identities[token];
    if (baseIdentity === undefined) {
      return { ok: false, status: 401, message: 'missing bearer token' };
    }
    const now = Math.floor(Date.now() / 1_000);
    const authTime =
      token === 'missing_freshness'
        ? undefined
        : token === 'boundary'
          ? now - 300
          : token === 'stale'
            ? now - 3_600
            : token === 'over_300'
              ? now - 301
              : token === 'future'
                ? now + 1
                : now - 60;
    return {
      ok: true,
      identity: { ...baseIdentity, ...(authTime === undefined ? {} : { authTime }) },
    };
  },
};

let http: Server | undefined;
let base: string;
let configStore: InMemoryConfigStore;
let controlPlane: InMemoryControlPlaneStore;
let registry: ServerRegistry;
let audit: InMemoryAuditStore;

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MILLISECONDS);
  controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: identities.owner.subject,
    email: identities.owner.email,
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: identities.developer.subject,
    email: identities.developer.email,
    role: 'developer',
  });
  await controlPlane.addOrgMember({
    org: 'globex',
    subject: identities.cross_org.subject,
    email: identities.cross_org.email,
    role: 'owner',
  });
  configStore = new InMemoryConfigStore();
  registry = new ServerRegistry(undefined, undefined, configStore);
  expect(
    await registry.deploy({ org: 'acme', app: 'support', env: 'release' }, HELLO, {
      actor: identities.owner,
      accessMode: 'owner-only',
    }),
  ).toMatchObject({ ok: true });
  await configStore.setConfigValue({
    kind: 'secret',
    scope: { level: 'org', org: 'acme' },
    name: 'INHERITED',
    value: 'inherited-secret-value',
  });
  await configStore.setConfigValue({
    kind: 'secret',
    scope: { level: 'app', org: 'acme', app: 'support' },
    name: 'TOKEN',
    value: 'app-secret-value',
  });
  await configStore.setConfigValue({
    kind: 'secret',
    scope: { level: 'env', org: 'acme', app: 'support', env: 'release' },
    name: 'TOKEN',
    value: 'environment-secret-value',
  });
  audit = new InMemoryAuditStore();
  http = createServer(
    createServiceHandler(registry, {
      deployGate: gate,
      controlPlaneStore: controlPlane,
      configStore,
      audit,
    }),
  );
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (http !== undefined) {
    await new Promise<void>((resolve, reject) =>
      http?.close((error) => (error ? reject(error) : resolve())),
    );
  }
  http = undefined;
  vi.restoreAllMocks();
});

function reveal(
  token: string | undefined,
  name = 'TOKEN',
  options: { readonly tenant?: string; readonly method?: string } = {},
): Promise<Response> {
  const tenant = options.tenant ?? 'acme/apps/support/envs/release';
  return fetch(`${base}/v1/orgs/${tenant}/secrets/${name}/reveal`, {
    method: options.method ?? 'POST',
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

describe('owner-only single-secret reveal', () => {
  it.each([
    ['organization', '/v1/orgs/%ZZ/apps/support/envs/release/secrets/TOKEN/reveal'],
    ['app', '/v1/orgs/acme/apps/%ZZ/envs/release/secrets/TOKEN/reveal'],
    ['environment', '/v1/orgs/acme/apps/support/envs/%ZZ/secrets/TOKEN/reveal'],
    ['name', '/v1/orgs/acme/apps/support/envs/release/secrets/%ZZ/reveal'],
  ])('controls malformed percent encoding in the %s component before auth or storage', async (_component, path) => {
    const authorize = vi.spyOn(gate, 'authorize');
    const getOrg = vi.spyOn(controlPlane, 'getOrg');
    const getApp = vi.spyOn(registry, 'getApp');
    const list = vi.spyOn(configStore, 'listConfigValues');
    const resolve = vi.spyOn(configStore, 'resolveConfigValues');

    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner' },
      signal: AbortSignal.timeout(1_000),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid config scope or name' });
    expect(authorize).not.toHaveBeenCalled();
    expect(getOrg).not.toHaveBeenCalled();
    expect(getApp).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns only the requested effective secret and its exact environment source', async () => {
    const response = await reveal('owner');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      value: 'environment-secret-value',
      source: {
        kind: 'environment',
        organizationId: 'acme',
        appId: 'support',
        environmentId: 'release',
        environmentName: 'release',
        isProduction: true,
      },
    });
  });

  it('reports the inherited organization source without exposing other secret values', async () => {
    const response = await reveal('owner', 'INHERITED');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      value: 'inherited-secret-value',
      source: { kind: 'organization', organizationId: 'acme' },
    });
  });

  it.each([
    'developer',
    'outsider',
    'domain_only',
    'super_admin',
    'cross_org',
  ])('denies %s authority identically for known and unknown secret names', async (token) => {
    const known = await reveal(token, 'TOKEN');
    const unknown = await reveal(token, 'UNKNOWN');

    expect(known.status).toBe(403);
    expect(await known.json()).toEqual({ error: 'forbidden' });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual({ error: 'forbidden' });
    expect(known.headers.get('cache-control')).toBe('no-store');
    expect(unknown.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    'missing_freshness',
    'stale',
    'over_300',
    'future',
  ])('requires fresh authentication for %s identically for known and unknown names', async (token) => {
    const known = await reveal(token, 'TOKEN');
    const unknown = await reveal(token, 'UNKNOWN');

    expect(known.status).toBe(403);
    expect(await known.json()).toEqual({ error: 'fresh_auth_required' });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual({ error: 'fresh_auth_required' });
    expect(known.headers.get('cache-control')).toBe('no-store');
    expect(unknown.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts authentication exactly 300 seconds old', async () => {
    const response = await reveal('boundary');
    expect(response.status).toBe(200);
    expect((await response.json()).value).toBe('environment-secret-value');
  });

  it('validates exact tenant existence before evaluating membership', async () => {
    const missingEnvironment = await reveal('outsider', 'TOKEN', {
      tenant: 'acme/apps/support/envs/missing',
    });
    expect(missingEnvironment.status).toBe(404);
    expect(await missingEnvironment.json()).toEqual({ error: 'not found' });

    const existingEnvironment = await reveal('outsider');
    expect(existingEnvironment.status).toBe(403);
    expect(await existingEnvironment.json()).toEqual({ error: 'forbidden' });
  });

  it('denies an owner immediately after their live role is revoked', async () => {
    await controlPlane.updateOrgMemberRole({
      org: 'acme',
      subject: identities.owner.subject,
      role: 'developer',
    });

    const known = await reveal('owner', 'TOKEN');
    const unknown = await reveal('owner', 'UNKNOWN');
    expect(known.status).toBe(403);
    expect(await known.json()).toEqual({ error: 'forbidden' });
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toEqual({ error: 'forbidden' });
  });

  it('returns not found only after a fresh owner requests an unknown name', async () => {
    const response = await reveal('owner', 'UNKNOWN');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });

  it('sets no-store on every response from the recognized reveal route', async () => {
    const responses = [
      await reveal('owner'),
      await reveal('developer'),
      await reveal('missing_freshness'),
      await reveal('owner', 'UNKNOWN'),
      await reveal(undefined),
      await reveal('owner', 'TOKEN', { method: 'GET' }),
      await reveal('owner', 'bad-name'),
    ];

    expect(responses.map((response) => response.status)).toEqual([
      200, 403, 403, 404, 401, 404, 400,
    ]);
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('audits success and denials with actor, tenant, scope, name, and reason but never value', async () => {
    expect((await reveal('owner')).status).toBe(200);
    expect((await reveal('developer')).status).toBe(403);
    expect((await reveal('missing_freshness')).status).toBe(403);
    expect((await reveal('owner', 'UNKNOWN')).status).toBe(404);

    const events = await audit.list({ org: 'acme' });
    expect(events).toHaveLength(4);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'config.secret.revealed',
          org: 'acme',
          app: 'support',
          env: 'release',
          actorSubject: 'owner-sub',
          actorEmail: 'owner@noodleseed.com',
          decision: 'allow',
          reasonCode: 'revealed',
          details: {
            kind: 'secret',
            scope: 'effective',
            name: 'TOKEN',
            reason: 'revealed',
          },
        }),
        expect.objectContaining({
          eventType: 'config.secret.reveal_denied',
          actorSubject: 'developer-sub',
          decision: 'deny',
          reasonCode: 'owner_required',
          details: expect.objectContaining({ name: 'TOKEN', reason: 'owner_required' }),
        }),
        expect.objectContaining({
          eventType: 'config.secret.reveal_denied',
          actorSubject: 'owner-sub',
          decision: 'deny',
          reasonCode: 'fresh_auth_required',
          details: expect.objectContaining({ name: 'TOKEN', reason: 'fresh_auth_required' }),
        }),
        expect.objectContaining({
          eventType: 'config.secret.reveal_denied',
          actorSubject: 'owner-sub',
          decision: 'deny',
          reasonCode: 'secret_not_found',
          details: expect.objectContaining({ name: 'UNKNOWN', reason: 'secret_not_found' }),
        }),
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('environment-secret-value');
    expect(serialized).not.toContain('app-secret-value');
    expect(serialized).not.toContain('inherited-secret-value');
  });
});
