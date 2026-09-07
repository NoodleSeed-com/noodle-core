import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { AuditEventInput, AuditSink } from '@noodle-borg/module';
import { exportJWK, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createOAuthApp } from '../src/oauth/app.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { digestClientSecret } from '../src/oauth/service-principal-credentials.js';
import {
  resolveServicePrincipalResource,
  type ServicePrincipalResourceRouting,
} from '../src/oauth/service-principal-resource.js';
import {
  InMemoryServicePrincipalStore,
  type ServicePrincipalRuntime,
} from '../src/oauth/service-principal-store.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import type { ServerRegistry } from '../src/registry.js';
import { raw } from './oauth-http-test-helpers.js';

const NOW_MS = Date.parse('2026-08-03T12:00:00.000Z');
const ISSUER = 'https://cloud.noodleseed.dev';
const PUBLIC_RESOURCE = 'https://arez.cloud.noodleseed.dev/todoist/mcp';
const LEGACY_RESOURCE = `${ISSUER}/o/acme/todoist/mcp`;
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789';
const ROUTING: ServicePrincipalResourceRouting = {
  legacyOrigin: ISSUER,
  allowedBaseDomains: ['cloud.noodleseed.dev'],
  resolveTenant: async (ref) =>
    ref.mcpSubdomain === 'arez'
      ? {
          org: 'acme',
          app: ref.app,
          env: ref.env,
          ...(ref.serverVersion === undefined ? {} : { serverVersion: ref.serverVersion }),
        }
      : undefined,
};

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('service-principal MCP resource resolution', () => {
  it.each([
    [LEGACY_RESOURCE, { org: 'acme', app: 'todoist', env: 'prod' }],
    [
      `${ISSUER}/o/acme/todoist/v2_0/mcp`,
      { org: 'acme', app: 'todoist', env: 'prod', serverVersion: '2.0' },
    ],
    [`${ISSUER}/o/acme/todoist/staging/mcp`, { org: 'acme', app: 'todoist', env: 'staging' }],
    [PUBLIC_RESOURCE, { org: 'acme', app: 'todoist', env: 'prod' }],
    [
      'https://arez.cloud.noodleseed.dev/todoist/v2_0/mcp',
      { org: 'acme', app: 'todoist', env: 'prod', serverVersion: '2.0' },
    ],
    [
      'https://arez.cloud.noodleseed.dev/todoist/env/staging/mcp',
      { org: 'acme', app: 'todoist', env: 'staging' },
    ],
  ] as const)('accepts an exact currently served resource: %s', async (resource, tenant) => {
    const registry = registryFor(resource);

    await expect(resolveServicePrincipalResource(resource, registry, ROUTING)).resolves.toEqual({
      resource,
      tenant,
      deploymentId: 'dep_serving',
    });
  });

  it.each([
    `${PUBLIC_RESOURCE}?query=1`,
    `${PUBLIC_RESOURCE}#fragment`,
    'https://AREZ.cloud.noodleseed.dev/todoist/mcp',
    'https://arez.cloud.noodleseed.dev:443/todoist/mcp',
    'https://arez.other.example/todoist/mcp',
    'http://arez.cloud.noodleseed.dev/todoist/mcp',
    'https://cloud.noodleseed.dev/o/other/todoist/mcp',
    'https://cloud.noodleseed.dev/o/acme/missing/mcp',
    'https://cloud.noodleseed.dev/o/acme/todoist/v9/mcp',
  ])('rejects a non-canonical, wrong, or non-serving resource: %s', async (resource) => {
    await expect(
      resolveServicePrincipalResource(resource, registryFor(), ROUTING),
    ).resolves.toBeUndefined();
  });
});

describe('service-principal client_credentials token endpoint', () => {
  it('issues a ten-minute exact-resource service token with the full grant ceiling', async () => {
    const fixture = await tokenFixture();
    const response = await postToken(
      fixture.url,
      {
        grant_type: 'client_credentials',
        resource: PUBLIC_RESOURCE,
      },
      fixture.basic,
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const body = JSON.parse(response.text) as Record<string, unknown>;
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'todos.read todos.write',
    });
    expect(body).not.toHaveProperty('refresh_token');

    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await fixture.signer.verifierKey(),
    });
    const verified = await verify(String(body.access_token), PUBLIC_RESOURCE);
    expect(verified).toEqual({
      caller: expect.objectContaining({
        subject: fixture.principalId,
        identityKind: 'service',
        oauthClientId: fixture.principalId,
        scopes: ['todos.read', 'todos.write'],
        roles: [],
      }),
      servicePrincipal: {
        grantId: fixture.grantId,
        credentialId: fixture.credentialId,
      },
    });
    expect(fixture.audit.events).toEqual([
      expect.objectContaining({
        eventType: 'service_principal.token.issued',
        org: 'acme',
        app: 'todoist',
        env: 'prod',
        actorSubject: fixture.principalId,
        details: {
          principalId: fixture.principalId,
          grantId: fixture.grantId,
          credentialId: fixture.credentialId,
        },
      }),
    ]);
  });

  it('normalizes an allowed scope subset and never exceeds the grant ceiling', async () => {
    const fixture = await tokenFixture();
    const allowed = await postToken(
      fixture.url,
      {
        grant_type: 'client_credentials',
        resource: PUBLIC_RESOURCE,
        scope: 'todos.write',
      },
      fixture.basic,
    );
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.text)).toMatchObject({ scope: 'todos.write' });

    for (const scope of [
      'admin',
      'todos.read todos.read',
      'x'.repeat(129),
      Array.from({ length: 65 }, (_, index) => `s${index}`).join(' '),
    ]) {
      const denied = await postToken(
        fixture.url,
        {
          grant_type: 'client_credentials',
          resource: PUBLIC_RESOURCE,
          scope,
        },
        fixture.basic,
      );
      expect(denied.status).toBe(400);
      expect(JSON.parse(denied.text)).toEqual({
        error: 'invalid_scope',
        error_description: 'requested scope is invalid',
      });
    }
  });

  it.each([
    [{ grant_type: 'client_credentials' }, 'invalid_request'],
    [
      { grant_type: 'client_credentials', resource: [PUBLIC_RESOURCE, PUBLIC_RESOURCE] },
      'invalid_request',
    ],
    [
      { grant_type: 'client_credentials', resource: `${PUBLIC_RESOURCE}?wrong=1` },
      'invalid_target',
    ],
    [
      {
        grant_type: 'client_credentials',
        resource: 'https://other.cloud.noodleseed.dev/todoist/mcp',
      },
      'invalid_target',
    ],
    [
      {
        grant_type: 'client_credentials',
        resource: 'https://acme.cloud.noodleseed.dev/missing/mcp',
      },
      'invalid_target',
    ],
  ] as const)('rejects invalid resource input without issuing a token', async (fields, error) => {
    const fixture = await tokenFixture();
    const response = await postToken(fixture.url, fields, fixture.basic);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error });
    expect(fixture.audit.events).toEqual([]);
  });

  it('fails closed after principal, grant, or credential revocation', async () => {
    const cases = ['principal', 'grant', 'credential'] as const;
    for (const target of cases) {
      const fixture = await tokenFixture();
      if (target === 'principal') {
        await fixture.store.revokePrincipal({
          principalId: fixture.principalId,
          org: 'acme',
          actorSubject: 'human-1',
        });
      } else if (target === 'grant') {
        await fixture.store.revokeGrant({
          principalId: fixture.principalId,
          grantId: fixture.grantId,
          org: 'acme',
          actorSubject: 'human-1',
        });
      } else {
        await fixture.store.revokeCredential({
          principalId: fixture.principalId,
          credentialId: fixture.credentialId,
          org: 'acme',
          actorSubject: 'human-1',
        });
      }
      const response = await postToken(
        fixture.url,
        {
          grant_type: 'client_credentials',
          resource: PUBLIC_RESOURCE,
        },
        fixture.basic,
      );
      expect(response.status).toBe(target === 'grant' ? 400 : 401);
      expect(JSON.parse(response.text)).toMatchObject({
        error: target === 'grant' ? 'invalid_target' : 'invalid_client',
      });
    }
  });

  it('atomically accepts a private_key_jwt assertion once under concurrency', async () => {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicJwk = { ...(await exportJWK(keyPair.publicKey)), alg: 'RS256' };
    const fixture = await tokenFixture({ publicJwk });
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(fixture.principalId)
      .setSubject(fixture.principalId)
      .setAudience(ISSUER)
      .setIssuedAt(NOW_MS / 1000)
      .setExpirationTime(NOW_MS / 1000 + 300)
      .setJti('one-assertion')
      .sign(keyPair.privateKey);
    const fields = {
      grant_type: 'client_credentials',
      resource: PUBLIC_RESOURCE,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    };

    const concurrent = await Promise.all([
      postToken(fixture.url, fields),
      postToken(fixture.url, fields),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 401]);
    expect((await postToken(fixture.url, fields)).status).toBe(401);
    expect(fixture.audit.events).toHaveLength(1);
  });

  it('leaves every non-client-credentials grant on the existing SDK provider path', async () => {
    const fixture = await tokenFixture();
    const response = await postToken(fixture.url, {
      grant_type: 'refresh_token',
      refresh_token: 'unknown',
      resource: PUBLIC_RESOURCE,
      client_id: 'existing-public-client',
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_client' });
  });
});

interface TokenFixture {
  readonly url: string;
  readonly basic?: string;
  readonly store: InMemoryServicePrincipalStore;
  readonly signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;
  readonly principalId: string;
  readonly grantId: string;
  readonly credentialId: string;
  readonly audit: RecordingAuditSink;
}

async function tokenFixture(
  options: { readonly publicJwk?: Record<string, unknown> } = {},
): Promise<TokenFixture> {
  const store = new InMemoryServicePrincipalStore({ now: () => new Date(NOW_MS) });
  const principal = await store.createPrincipal({
    org: 'acme',
    name: 'nightly',
    actorSubject: 'human-1',
  });
  const grant = await store.createGrant({
    principalId: principal.principalId,
    org: 'acme',
    app: 'todoist',
    environment: 'prod',
    scopes: ['todos.write', 'todos.read'],
    actorSubject: 'human-1',
  });
  const credential =
    options.publicJwk === undefined
      ? await store.createCredential({
          principalId: principal.principalId,
          org: 'acme',
          actorSubject: 'human-1',
          kind: 'client_secret',
          label: 'primary',
          secretDigest: digestClientSecret(SECRET),
        })
      : await store.createCredential({
          principalId: principal.principalId,
          org: 'acme',
          actorSubject: 'human-1',
          kind: 'public_jwk',
          label: 'primary',
          algorithm: 'RS256',
          publicJwk: options.publicJwk,
        });
  const signer = await createStaticSigningKeyProvider();
  const provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store: new InMemoryOAuthStore(),
    signer,
    now: () => NOW_MS,
  });
  const audit = new RecordingAuditSink();
  const runtime: ServicePrincipalRuntime = { ready: true, store };
  const server = createServer(
    createOAuthApp(provider, {
      servicePrincipals: {
        runtime,
        registry: () => registryFor(PUBLIC_RESOURCE),
        routing: ROUTING,
        audit,
      },
    }),
  );
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing test address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    ...(options.publicJwk === undefined
      ? { basic: `Basic ${Buffer.from(`${principal.principalId}:${SECRET}`).toString('base64')}` }
      : {}),
    store,
    signer,
    principalId: principal.principalId,
    grantId: grant.grantId,
    credentialId: credential.credentialId,
    audit,
  };
}

function postToken(
  baseUrl: string,
  fields: Record<string, string | readonly string[]>,
  authorization?: string,
) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) params.append(name, item);
  }
  return raw('POST', `${baseUrl}/token`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: params.toString(),
  });
}

function registryFor(servingResource?: string): ServerRegistry {
  const serving = servingResource === undefined ? undefined : tenantFor(servingResource);
  return {
    getActiveByTenant: async (tenant: { org: string; app: string; env: string }) =>
      serving !== undefined && serving.serverVersion === undefined && sameTenant(serving, tenant)
        ? ({ deploymentId: 'dep_serving' } as never)
        : undefined,
    getActiveByTenantVersion: async (
      tenant: { org: string; app: string; env: string },
      serverVersion: string,
    ) =>
      serving !== undefined &&
      serving.serverVersion === serverVersion &&
      sameTenant(serving, tenant)
        ? ({ deploymentId: 'dep_serving' } as never)
        : undefined,
  } as ServerRegistry;
}

function tenantFor(resource: string) {
  const url = new URL(resource);
  const legacy = url.hostname === 'cloud.noodleseed.dev';
  const segments = url.pathname.split('/').filter(Boolean);
  if (legacy) {
    const version = segments.at(-2)?.startsWith('v')
      ? segments.at(-2)?.slice(1).replaceAll('_', '.')
      : undefined;
    return {
      org: segments[1] ?? '',
      app: segments[2] ?? '',
      env: segments.length === (version === undefined ? 5 : 6) ? (segments[3] ?? 'prod') : 'prod',
      ...(version === undefined ? {} : { serverVersion: version }),
    };
  }
  const version = segments.at(-2)?.startsWith('v')
    ? segments.at(-2)?.slice(1).replaceAll('_', '.')
    : undefined;
  return {
    org: url.hostname.split('.')[0] === 'arez' ? 'acme' : (url.hostname.split('.')[0] ?? ''),
    app: segments[0] ?? '',
    env: segments[1] === 'env' ? (segments[2] ?? '') : 'prod',
    ...(version === undefined ? {} : { serverVersion: version }),
  };
}

function sameTenant(
  left: { org: string; app: string; env: string },
  right: { org: string; app: string; env: string },
) {
  return left.org === right.org && left.app === right.app && left.env === right.env;
}

class RecordingAuditSink implements AuditSink {
  readonly events: AuditEventInput[] = [];

  emit(event: AuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }
}
