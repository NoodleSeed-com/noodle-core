import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import {
  createJwtVerifier,
  createStaticSigningKeyProvider,
  mintAccessToken,
} from '@noodle-borg/auth';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { PortableConnections } from '../src/connections/service.js';
import { InMemoryConnectionStore } from '../src/connections/store.js';
import { createDefaultControlPlaneGate } from '../src/control-plane-auth-bootstrap.js';
import { reconcileFirstPartyOAuthClient } from '../src/oauth/first-party-client.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import {
  type BusinessConnectionRouteDeps,
  handleApplicationConnectionCallback,
  handleApplicationConnections,
} from '../src/routes/business-information-connections.js';
import { parseSolutionInstallationPath } from '../src/routes/business-information-paths.js';
import { oauthFixture } from './connection-oauth-fixture.js';

const key = {
  org: 'acme',
  app: 'workflow',
  env: 'prod',
  installationId: 'installation-one',
  connectionId: 'records_account',
};
const target = {
  key,
  label: 'Records account',
  connectionConfigRevision: 'compiled-revision',
  requiredScopes: ['records.read', 'records.write'],
};
const binding = 'b'.repeat(43);
const path = '/v1/orgs/acme/solution-installations/installation-one/connections';
let server: Server;
let origin: string;
let provider: Awaited<ReturnType<typeof oauthFixture>>;
let deps: BusinessConnectionRouteDeps;
let business: InMemoryBusinessInformationStore;
beforeEach(async () => {
  business = new InMemoryBusinessInformationStore();
  await business.createInstallation({
    scope: key,
    profileKey: 'travel',
    managedCollections: [],
    actorSubject: 'owner',
  });
  for (const role of ['manager', 'operator', 'viewer'] as const)
    await business.setGrant({
      scope: key,
      subject: role,
      email: `${role}@example.com`,
      role,
      expectedRevision: 0,
      actorSubject: 'owner',
    });
  provider = await oauthFixture();
  const connections = new PortableConnections({
    store: new InMemoryConnectionStore(),
    providers: async () => provider.provider,
    resolveTarget: async () => target,
    authorize: async (scope, actor) => {
      const grant = await business.getGrant(scope, actor);
      return grant?.role === 'administrator' && grant.revokedAt === undefined;
    },
    portalOrigins: ['https://portal.example.test'],
    credentialEpoch: 'fixture-epoch-0001',
    guardedFetch: provider.fetch,
  });
  deps = {
    store: business,
    connections,
    resolveConnectionTargets: async () => [target],
    publicCounters: new InMemoryDailyCounterStore(),
    controlPlane: new InMemoryControlPlaneStore(),
    maxBody: 64_000,
    trustProxy: false,
    gate: {
      authorize: async (req) => {
        const subject = String(req.headers.authorization ?? '').replace('Bearer ', '');
        return subject
          ? {
              ok: true,
              identity: {
                subject,
                email: `${subject}@example.com`,
                superAdmin: subject === 'developer',
              },
            }
          : { ok: false, status: 401, message: 'Sign in required' };
      },
    },
  };
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const ref = parseSolutionInstallationPath(pathname);
    const handle =
      pathname === '/v1/solution-connections/callback'
        ? handleApplicationConnectionCallback(req, res, deps)
        : ref
          ? handleApplicationConnections(req, res, ref, deps)
          : Promise.resolve().then(() => {
              res.writeHead(404);
              res.end();
            });
    void handle.catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
function call(suffix = '', body?: unknown, actor = 'owner') {
  return fetch(`${origin}${path}${suffix}`, {
    headers: { authorization: actor ? `Bearer ${actor}` : '', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
}
const startBody = {
  expectedRevision: 0,
  returnUrl: 'https://portal.example.test/o/acme/workflow/integrations',
  sessionBinding: binding,
};
describe('Portal connection HTTP boundary', () => {
  it('completes the POST callback with a cryptographically verified first-party Portal token', async () => {
    const issuer = 'https://service.example.test';
    const signer = await createStaticSigningKeyProvider();
    const oauthStore = new InMemoryOAuthStore();
    await reconcileFirstPartyOAuthClient(oauthStore, {
      owner: 'portal',
      clientId: 'portal',
      resource: issuer,
      redirectUri: 'https://portal.example.test/api/portal/auth/callback',
    });
    const gate = createDefaultControlPlaneGate({
      options: { publicBaseUrl: issuer, controlPlaneSignupMode: 'public' },
      authServerIssuer: issuer,
      controlPlaneStore: deps.controlPlane,
      oauthStore,
      verifyOwnerToken: createJwtVerifier({ issuer, keyResolver: await signer.verifierKey() }),
    });
    if (!gate) throw new Error('Portal gate was not configured');
    deps = { ...deps, gate };
    const token = await mintAccessToken(
      signer,
      {
        issuer,
        subject: 'owner',
        email: 'owner@example.com',
        audience: `${issuer}/`,
        oauthClientId: 'portal',
        scope: 'openid email',
      },
      300,
    );
    const started = await call('/records_account/connect', startBody, token);
    expect(started.status, await started.clone().text()).toBe(200);
    const start = await started.json();
    const callback = provider.authorize(start.data.authorizationUrl);
    const completed = await fetch(`${origin}/v1/solution-connections/callback`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...callback,
        sessionBinding: binding,
        iss: provider.provider.server.issuer,
      }),
    });
    expect(completed.status, await completed.clone().text()).toBe(200);
    expect(await completed.json()).toEqual({ ok: true, data: { returnUrl: startBody.returnUrl } });
    expect(provider.metrics().tokenCalls).toBe(1);
    expect(await (await call('', undefined, token)).json()).toMatchObject({
      data: { connections: [{ state: 'ready' }] },
    });
  });

  it('projects safe availability and enforces live installation roles including super-admin isolation', async () => {
    expect((await call('', undefined, '')).status).toBe(401);
    expect((await call('', undefined, 'viewer')).status).toBe(403);
    expect((await call('', undefined, 'developer')).status).toBe(403);
    const operator = await call('', undefined, 'operator');
    expect(operator.status).toBe(200);
    expect(operator.headers.get('cache-control')).toBe('private, no-store');
    expect(await operator.json()).toEqual({
      ok: true,
      data: {
        connections: [
          {
            id: key.connectionId,
            label: target.label,
            state: 'unconfigured',
            revision: 0,
            connectable: true,
          },
        ],
        canEdit: false,
      },
    });
    expect((await call('/records_account/connect', startBody, 'operator')).status).toBe(403);
    expect(provider.metrics().tokenCalls).toBe(0);
  });
  it('connects through typed start/callback then disconnects without leaking credential material', async () => {
    const started = await call('/records_account/connect', startBody);
    expect(started.status).toBe(200);
    const start = (await started.json()) as { data: { authorizationUrl: string } };
    expect(JSON.stringify(start)).not.toContain('fixture-client-secret');
    const callback = provider.authorize(start.data.authorizationUrl);
    const finish = () =>
      fetch(`${origin}/v1/solution-connections/callback`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...callback,
          sessionBinding: binding,
          iss: provider.provider.server.issuer,
        }),
      });
    const completed = await finish();
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ ok: true, data: { returnUrl: startBody.returnUrl } });
    expect((await finish()).status).toBe(400);
    const listed = (await (await call()).json()) as {
      data: { connections: { revision: number }[] };
    };
    expect(JSON.stringify(listed)).not.toMatch(/token|secret|account-one|nonce|verifier/);
    const disconnected = await call('/records_account/disconnect', {
      expectedRevision: listed.data.connections[0]?.revision,
    });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({
      data: { connections: [{ state: 'revoked' }] },
    });
    expect((await call('/records_account/disconnect', { expectedRevision: 0 })).status).toBe(409);
  });
  it('rejects unknown connections, untrusted URLs, excess body fields and wrong methods', async () => {
    expect((await call('/unknown/connect', startBody)).status).toBe(404);
    expect(
      (await call('/records_account/connect', { ...startBody, returnUrl: 'javascript:alert(1)' }))
        .status,
    ).toBe(400);
    expect(
      (await call('/records_account/connect', { ...startBody, token: 'forbidden' })).status,
    ).toBe(400);
    expect((await call('/records_account/connect')).status).toBe(405);
  });
});
