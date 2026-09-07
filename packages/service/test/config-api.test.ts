import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bearerToken,
  createServiceHandler,
  type DeployAuthGate,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
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
const HTTPBIN = readFileSync(join(here, 'fixtures', 'httpbin', 'manifest.yaml'), 'utf8');
const HTTPBIN_CONNECTORS = readFileSync(
  join(here, 'fixtures', 'httpbin', 'connectors.yaml'),
  'utf8',
);
const NEEDS_VARIABLE = `
manifestVersion: "1"
server:
  name: needs_variable
  version: 1.0.0
  title: Needs Variable
connectors:
  api:
    id: api
    version: 1.0.0
tools:
  - name: search
    description: Search.
    inputSchema:
      type: object
    outputSchema:
      type: object
    fulfilment:
      steps:
        - id: searched
          use: api.search
          args:
            q: hello
      output:
        ok: \${steps.searched.ok}
`;
const NEEDS_VARIABLE_CONNECTORS = `
connectors:
  - id: api
    version: 1.0.0
    http:
      baseUrl: \${env.API_BASE_URL}
      allowedOrigins:
        - https://api.example.com
    operations:
      search:
        type: read
        method: POST
        path: /search
        input:
          type: object
          properties:
            q: { type: string }
          required: [q]
          additionalProperties: false
        request:
          q: \${args.q}
          region: \${env.REGION}
        response:
          ok: true
        output:
          type: object
          properties:
            ok: { type: boolean }
          additionalProperties: false
`;
const NEEDS_AUTH_VARIABLE = `
manifestVersion: "1"
server:
  name: needs_auth_variable
  version: 1.0.0
  title: Needs Auth Variable
connectors:
  graph:
    id: graph
    version: 1.0.0
tools:
  - name: me
    description: Me.
    inputSchema:
      type: object
    outputSchema:
      type: object
    fulfilment:
      steps:
        - id: me
          use: graph.me
          args: {}
      output:
        ok: true
`;
const NEEDS_AUTH_VARIABLE_CONNECTORS = `
connectors:
  - id: graph
    version: 1.0.0
    http:
      baseUrl: https://graph.microsoft.com/v1.0
      allowedOrigins:
        - https://graph.microsoft.com
        - https://login.microsoftonline.com
      auth:
        kind: delegatedOAuth
        provider: microsoft
        tokenUrl: https://login.microsoftonline.com/\${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token
        clientId: \${env.MICROSOFT_CLIENT_ID}
        clientSecret: MS_CLIENT_SECRET
    operations:
      me:
        type: read
        method: GET
        path: /me
        output:
          type: object
          properties:
            ok: { type: boolean }
          additionalProperties: false
`;

const MEMBER = { subject: 'member-sub', email: 'member@noodleseed.com', superAdmin: false };
const OWNER = { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: false };
const OUTSIDER = { subject: 'outsider-sub', email: 'outsider@noodleseed.com', superAdmin: false };
const OTHER_ORG_MEMBER = {
  subject: 'other-org-sub',
  email: 'other@noodleseed.com',
  superAdmin: false,
};
const SUPPORT_ADMIN = {
  subject: 'support-admin-sub',
  email: 'admin@noodleseed.com',
  superAdmin: true,
};

const gate: DeployAuthGate = {
  authorize(req) {
    const token = bearerToken(req);
    if (token === 'member') return { ok: true, identity: MEMBER };
    if (token === 'owner') return { ok: true, identity: OWNER };
    if (token === 'outsider') return { ok: true, identity: OUTSIDER };
    if (token === 'other-org') return { ok: true, identity: OTHER_ORG_MEMBER };
    if (token === 'support-admin') return { ok: true, identity: SUPPORT_ADMIN };
    return { ok: false, status: 401, message: 'missing bearer token' };
  },
};

let http: Server;
let base: string;
let configStore: InMemoryConfigStore;
let controlPlane: InMemoryControlPlaneStore;
let registry: ServerRegistry;

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: MEMBER.subject,
    email: MEMBER.email,
    role: 'developer',
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: OWNER.subject,
    email: OWNER.email,
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'globex',
    subject: OTHER_ORG_MEMBER.subject,
    email: OTHER_ORG_MEMBER.email,
    role: 'developer',
  });
  configStore = new InMemoryConfigStore();
  registry = new ServerRegistry(undefined, undefined, configStore);
  http = createServer(
    createServiceHandler(registry, {
      deployGate: gate,
      controlPlaneStore: controlPlane,
      configStore,
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer member',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function apiAs(token: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

describe('managed config API', () => {
  it('projects effective configuration with live capabilities and environment metadata', async () => {
    expect(
      await registry.deploy({ org: 'acme', app: 'support', env: 'release' }, HELLO, {
        actor: MEMBER,
        accessMode: 'owner-only',
      }),
    ).toMatchObject({ ok: true });
    expect(await registry.setProductionEnvironment('acme', 'support', 'release')).toMatchObject({
      productionEnvironment: 'release',
      changed: false,
    });

    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'org', org: 'acme' },
      name: 'TOKEN',
      value: 'org-token',
    });
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'app', org: 'acme', app: 'support' },
      name: 'TOKEN',
      value: 'app-token',
    });
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'release' },
      name: 'TOKEN',
      value: 'release-token',
    });
    await configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'org', org: 'acme' },
      name: 'REGION',
      value: 'us',
    });
    await configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'app', org: 'acme', app: 'support' },
      name: 'REGION',
      value: 'eu',
    });

    const secrets = await api('/v1/orgs/acme/apps/support/envs/release/secrets?view=effective');
    expect(secrets.status).toBe(200);
    const secretBody = await secrets.json();
    expect(secretBody).toMatchObject({
      kind: 'secret',
      environment: { id: 'release', name: 'release', isProduction: true },
      capabilities: { canManage: true, canReveal: false },
      entries: [
        {
          name: 'TOKEN',
          source: {
            kind: 'environment',
            organizationId: 'acme',
            appId: 'support',
            environmentId: 'release',
            environmentName: 'release',
            isProduction: true,
          },
          fallbackSource: { kind: 'app', organizationId: 'acme', appId: 'support' },
        },
      ],
    });
    expect(secretBody.entries[0]).not.toHaveProperty('value');

    const variables = await api('/v1/orgs/acme/apps/support/envs/release/variables?view=effective');
    expect(variables.status).toBe(200);
    expect(await variables.json()).toMatchObject({
      kind: 'variable',
      entries: [
        {
          name: 'REGION',
          source: { kind: 'app', organizationId: 'acme', appId: 'support' },
          fallbackSource: { kind: 'organization', organizationId: 'acme' },
          value: 'eu',
        },
      ],
    });

    expect(
      (await apiAs('owner', '/v1/orgs/acme/apps/support/envs/release/secrets?view=effective'))
        .status,
    ).toBe(200);
    const owner = await apiAs(
      'owner',
      '/v1/orgs/acme/apps/support/envs/release/secrets?view=effective',
    );
    expect((await owner.json()).capabilities).toEqual({ canManage: true, canReveal: true });
  });

  it('denies outsiders, cross-tenant members, and support admins from effective configuration', async () => {
    expect(
      await registry.deploy({ org: 'acme', app: 'support', env: 'release' }, HELLO, {
        actor: MEMBER,
        accessMode: 'owner-only',
      }),
    ).toMatchObject({ ok: true });
    await configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'release' },
      name: 'ADMIN_ONLY_VALUE',
      value: 'support-admin-must-not-read',
    });
    const path = '/v1/orgs/acme/apps/support/envs/release/variables?view=effective';

    expect((await apiAs('outsider', path)).status).toBe(403);
    expect((await apiAs('other-org', path)).status).toBe(403);
    const supportAdmin = await apiAs('support-admin', path);
    expect(supportAdmin.status).toBe(403);
    expect(await supportAdmin.text()).not.toContain('support-admin-must-not-read');
  });

  it('keeps the app fallback after deleting an environment override from the effective read', async () => {
    expect(
      await registry.deploy({ org: 'acme', app: 'support', env: 'release' }, HELLO, {
        actor: MEMBER,
        accessMode: 'owner-only',
      }),
    ).toMatchObject({ ok: true });
    const root = '/v1/orgs/acme/apps/support/envs/release/variables/REGION';
    expect(
      (
        await api('/v1/orgs/acme/variables/REGION', {
          method: 'PUT',
          body: JSON.stringify({ value: 'us' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api('/v1/orgs/acme/apps/support/variables/REGION', {
          method: 'PUT',
          body: JSON.stringify({ value: 'eu' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(root, {
          method: 'PUT',
          body: JSON.stringify({ value: 'apac' }),
        })
      ).status,
    ).toBe(200);

    const effectivePath = '/v1/orgs/acme/apps/support/envs/release/variables?view=effective';
    expect(await (await api(effectivePath)).json()).toMatchObject({
      entries: [
        {
          name: 'REGION',
          source: expect.objectContaining({ kind: 'environment' }),
          fallbackSource: { kind: 'app', organizationId: 'acme', appId: 'support' },
          value: 'apac',
        },
      ],
    });

    expect((await api(root, { method: 'DELETE' })).status).toBe(204);
    expect(await (await api(effectivePath)).json()).toMatchObject({
      entries: [
        {
          name: 'REGION',
          source: { kind: 'app', organizationId: 'acme', appId: 'support' },
          fallbackSource: { kind: 'organization', organizationId: 'acme' },
          value: 'eu',
        },
      ],
    });
  });

  it('sets, lists, resolves, and deletes secret metadata without returning secret values', async () => {
    const set = await api('/v1/orgs/acme/secrets/TOKEN', {
      method: 'PUT',
      body: JSON.stringify({ value: 'org-token' }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).not.toHaveProperty('value.value');

    await api('/v1/orgs/acme/apps/support/secrets/TOKEN', {
      method: 'PUT',
      body: JSON.stringify({ value: 'app-token' }),
    });
    await api('/v1/orgs/acme/apps/support/envs/prod/secrets/TOKEN', {
      method: 'PUT',
      body: JSON.stringify({ value: 'env-token' }),
    });

    const list = await api('/v1/orgs/acme/apps/support/envs/prod/secrets');
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(JSON.stringify(listed)).not.toContain('env-token');
    expect(listed.values).toEqual([expect.objectContaining({ kind: 'secret', name: 'TOKEN' })]);
    expect(listed.values[0]).not.toHaveProperty('value');

    expect(
      await configStore.resolveConfigValues('secret', {
        level: 'env',
        org: 'acme',
        app: 'support',
        env: 'prod',
      }),
    ).toEqual({ TOKEN: 'env-token' });

    const deleted = await api('/v1/orgs/acme/apps/support/envs/prod/secrets/TOKEN', {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    expect(
      await configStore.resolveConfigValues('secret', {
        level: 'env',
        org: 'acme',
        app: 'support',
        env: 'prod',
      }),
    ).toEqual({ TOKEN: 'app-token' });
  });

  it('returns variable values and enforces org membership', async () => {
    const outsider = await fetch(`${base}/v1/orgs/acme/variables/REGION`, {
      method: 'PUT',
      headers: { authorization: 'Bearer outsider', 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'us' }),
    });
    expect(outsider.status).toBe(403);

    expect(
      (
        await api('/v1/orgs/acme/variables/REGION', {
          method: 'PUT',
          body: JSON.stringify({ value: 'us' }),
        })
      ).status,
    ).toBe(200);
    const list = await api('/v1/orgs/acme/variables');
    expect(list.status).toBe(200);
    expect((await list.json()).values).toEqual([
      expect.objectContaining({ kind: 'variable', name: 'REGION', value: 'us' }),
    ]);
  });

  it('rejects malformed names and deploy-body secret snapshots', async () => {
    const malformed = await api('/v1/orgs/acme/secrets/bad-name', {
      method: 'PUT',
      body: JSON.stringify({ value: 'x' }),
    });
    expect(malformed.status).toBe(400);

    const deploy = await api('/v1/orgs/acme/apps/hello/envs/prod/deploy', {
      method: 'POST',
      body: JSON.stringify({ manifest: HELLO, secrets: { TOKEN: 'x' } }),
    });
    expect(deploy.status).toBe(400);
    expect((await deploy.json()).error).toMatch(/secrets.*no longer accepted/i);
  });

  it('fails deploy closed when connector secret refs are unresolved', async () => {
    const missing = await api('/v1/orgs/acme/apps/httpbin/envs/prod/deploy', {
      method: 'POST',
      body: JSON.stringify({ manifest: HTTPBIN, connectors: HTTPBIN_CONNECTORS }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'missing_secret',
          path: 'secrets.httpbin_token',
        }),
      ],
    });

    await api('/v1/orgs/acme/apps/httpbin/envs/prod/secrets/httpbin_token', {
      method: 'PUT',
      body: JSON.stringify({ value: 'tok' }),
    });
    const ok = await api('/v1/orgs/acme/apps/httpbin/envs/prod/deploy', {
      method: 'POST',
      body: JSON.stringify({ manifest: HTTPBIN, connectors: HTTPBIN_CONNECTORS }),
    });
    expect(ok.status).toBe(201);
  });

  it('fails deploy closed when managed variable refs are unresolved', async () => {
    const missing = await api('/v1/orgs/acme/apps/needs-variable/envs/prod/deploy', {
      method: 'POST',
      body: JSON.stringify({ manifest: NEEDS_VARIABLE, connectors: NEEDS_VARIABLE_CONNECTORS }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'missing_variable',
          path: 'variables.API_BASE_URL',
        }),
        expect.objectContaining({
          code: 'missing_variable',
          path: 'variables.REGION',
        }),
      ],
    });

    await api('/v1/orgs/acme/apps/needs-variable/envs/prod/variables/API_BASE_URL', {
      method: 'PUT',
      body: JSON.stringify({ value: 'https://api.example.com' }),
    });
    await api('/v1/orgs/acme/apps/needs-variable/envs/prod/variables/REGION', {
      method: 'PUT',
      body: JSON.stringify({ value: 'us' }),
    });
    const ok = await api('/v1/orgs/acme/apps/needs-variable/envs/prod/deploy', {
      method: 'POST',
      body: JSON.stringify({ manifest: NEEDS_VARIABLE, connectors: NEEDS_VARIABLE_CONNECTORS }),
    });
    expect(ok.status).toBe(201);
  });

  it('fails deploy closed when managed auth variable refs are unresolved', async () => {
    await api('/v1/orgs/acme/apps/needs-auth-variable/envs/prod/secrets/MS_CLIENT_SECRET', {
      method: 'PUT',
      body: JSON.stringify({ value: 'client-secret' }),
    });

    const missing = await api('/v1/orgs/acme/apps/needs-auth-variable/envs/prod/deploy', {
      method: 'POST',
      body: JSON.stringify({
        manifest: NEEDS_AUTH_VARIABLE,
        connectors: NEEDS_AUTH_VARIABLE_CONNECTORS,
      }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'missing_variable',
          path: 'variables.MICROSOFT_CLIENT_ID',
        }),
        expect.objectContaining({
          code: 'missing_variable',
          path: 'variables.MICROSOFT_TENANT_ID',
        }),
      ],
    });

    await api('/v1/orgs/acme/apps/needs-auth-variable/envs/prod/variables/MICROSOFT_CLIENT_ID', {
      method: 'PUT',
      body: JSON.stringify({ value: 'client-id' }),
    });
    await api('/v1/orgs/acme/apps/needs-auth-variable/envs/prod/variables/MICROSOFT_TENANT_ID', {
      method: 'PUT',
      body: JSON.stringify({ value: 'tenant' }),
    });
    const ok = await api('/v1/orgs/acme/apps/needs-auth-variable/envs/prod/deploy', {
      method: 'POST',
      body: JSON.stringify({
        manifest: NEEDS_AUTH_VARIABLE,
        connectors: NEEDS_AUTH_VARIABLE_CONNECTORS,
      }),
    });
    expect(ok.status).toBe(201);
  });
});
