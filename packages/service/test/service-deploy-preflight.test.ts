import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bearerToken,
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const MANIFEST = `
manifestVersion: "1"
server:
  name: first_deploy
  version: 1.0.0
  title: First Deploy
connectors:
  api:
    id: api
    version: 1.0.0
tools:
  - name: status
    description: Read status.
    inputSchema:
      type: object
      additionalProperties: false
    outputSchema:
      type: object
      properties:
        ok: { type: boolean }
      required: [ok]
      additionalProperties: false
    fulfilment:
      use: api.status
      args: {}
`;

const CONNECTORS = `
connectors:
  - id: api
    version: 1.0.0
    kind: custom
    http:
      baseUrl: \${env.API_BASE_URL}
      allowedOrigins:
        - https://api.example.com
      auth:
        kind: bearer
        secret: API_TOKEN
    operations:
      status:
        type: read
        method: GET
        path: /status
        input:
          type: object
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: boolean }
          required: [ok]
          additionalProperties: false
        response:
          ok: true
`;

const SERVER_CONFIG_MANIFEST = `
manifestVersion: "1"
server:
  name: assistant_config
  version: 1.0.0
  title: Assistant config
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    allowedOrigins: [https://app.example.com]
tools:
  - name: status
    description: Read status.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        ok: true
`;

const MANAGED_ORIGIN_MANIFEST = `
manifestVersion: "2"
server:
  name: reusable_store
  version: 1.0.0
  title: Reusable Store
handoff:
  allowedDomains: ["\${env.STORE_ORIGIN}"]
tools:
  - name: status
    description: Read status.
    annotations: { readOnlyHint: true }
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        ok: true
`;

const OWNER = {
  subject: 'owner-sub',
  email: 'owner@example.com',
  superAdmin: false,
} as const;
const OUTSIDER = {
  subject: 'outsider-sub',
  email: 'outsider@example.com',
  superAdmin: false,
} as const;

let server: Server;
let base: string;
let artifacts: InMemoryArtifactStore;
let audit: InMemoryAuditStore;
let config: InMemoryConfigStore;
let registry: ServerRegistry;
let controlPlane: InMemoryControlPlaneStore;

beforeEach(async () => {
  artifacts = new InMemoryArtifactStore();
  audit = new InMemoryAuditStore();
  config = new InMemoryConfigStore();
  registry = new ServerRegistry(artifacts, undefined, config);
  controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: OWNER.subject, email: OWNER.email },
  });
  server = createServer(
    createServiceHandler(registry, {
      audit,
      configStore: config,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize(req) {
          const token = bearerToken(req);
          if (token === 'owner') return { ok: true, identity: OWNER };
          if (token === 'outsider') return { ok: true, identity: OUTSIDER };
          if (token === 'admin') {
            return {
              ok: true,
              identity: { subject: 'admin-sub', email: 'admin@example.com', superAdmin: true },
            };
          }
          return { ok: false, status: 401, message: 'sign in required' };
        },
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function targetPath(app = 'support', env = 'prod'): string {
  return `/v1/orgs/acme/apps/${app}/envs/${env}`;
}

function body(): string {
  return JSON.stringify({
    manifest: MANIFEST,
    connectors: CONNECTORS,
    accessMode: 'owner-only',
    serverVersion: '1',
    deploymentSource: 'cli',
  });
}

function request(
  action: 'deploy/preflight' | 'deploy',
  options: { token?: string; app?: string; env?: string; requestBody?: string } = {},
): Promise<Response> {
  const requestBody = options.requestBody ?? body();
  const app = options.app ?? 'support';
  const env = options.env ?? 'prod';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
  };
  if (action === 'deploy') {
    headers['idempotency-key'] = deployKey('acme', app, env, requestBody);
  }
  return fetch(`${base}${targetPath(app, env)}/${action}`, {
    method: 'POST',
    headers,
    body: requestBody,
  });
}

function deployKey(org: string, app: string, env: string, requestBody: string): string {
  return `sha256:${createHash('sha256')
    .update(`${org}\n${app}\n${env}\n${requestBody}`)
    .digest('hex')}`;
}

describe('first-deploy preflight', () => {
  it('returns the server checking deadline while retaining admission until late work settles', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const check = vi.spyOn(registry, 'preflightDeploy').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { ok: true };
    });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const pending = request('deploy/preflight', { token: 'owner' });
    await entered.promise;
    try {
      const deadline = timers.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
      expect(deadline).toBeTypeOf('function');
      if (typeof deadline === 'function') deadline();
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({
        code: 'deploy_preflight_timeout',
        phase: 'checks',
      });
      expect((await request('deploy/preflight', { token: 'owner' })).status).toBe(503);
      release.resolve();
      await vi.waitFor(async () => {
        expect(await audit.list({ org: 'acme', eventType: 'deploy.preflight.checked' })).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({
              ready: true,
              deadlineExceeded: true,
              clientDisconnected: false,
            }),
          }),
        ]);
      });
    } finally {
      release.resolve();
      await pending;
      timers.mockRestore();
      check.mockRestore();
    }
  });

  it('bounds concurrent preflight work while liveness remains available', async () => {
    await setRequiredConfig('prod');
    expect(
      await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, MANIFEST, {
        connectors: CONNECTORS,
        actor: OWNER,
        accessMode: 'public',
        serverVersion: '1',
      }),
    ).toMatchObject({ ok: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = registry.preflightDeploy.bind(registry);
    const check = vi.spyOn(registry, 'preflightDeploy').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const first = request('deploy/preflight', { token: 'owner' });
    await entered.promise;
    const fallback = setTimeout(() => release.resolve(), 1000);
    try {
      const second = await request('deploy/preflight', { token: 'owner' });
      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('5');
      expect(await second.json()).toMatchObject({
        code: 'deploy_preflight_busy',
        phase: 'admission',
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const discovery = await fetch(`${base}/o/acme/support/v1/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(discovery.status).toBe(200);
      expect(await discovery.text()).toContain('"name":"status"');
    } finally {
      clearTimeout(fallback);
      release.resolve();
      await first;
      check.mockRestore();
    }
    expect((await request('deploy/preflight', { token: 'owner' })).status).toBe(200);
  });

  it('correlates checks completed after the client disconnected', async () => {
    const requestId = '486c54ce-4c1d-4e61-8aee-3bfd357c75df';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const check = vi.spyOn(registry, 'preflightDeploy').mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { ok: true };
    });
    const controller = new AbortController();
    const disconnected = Promise.withResolvers<void>();
    server.once('request', (_req, res) => res.once('close', () => disconnected.resolve()));
    const pending = fetch(`${base}${targetPath()}/deploy/preflight`, {
      method: 'POST',
      body: body(),
      signal: controller.signal,
      headers: {
        authorization: 'Bearer owner',
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
    }).catch(() => undefined);
    await entered.promise;
    controller.abort();
    await pending;
    await disconnected.promise;
    release.resolve();
    try {
      await vi.waitFor(async () => {
        expect(await audit.list({ org: 'acme', eventType: 'deploy.preflight.checked' })).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({
              requestId,
              ready: true,
              clientDisconnected: true,
              elapsedMs: expect.any(Number),
            }),
          }),
        ]);
      });
    } finally {
      release.resolve();
      check.mockRestore();
    }
  });

  it('distinguishes authentication and organization access before target inspection', async () => {
    const check = vi.spyOn(registry, 'preflightDeploy');
    const resolveConfig = vi.spyOn(config, 'resolveConfigValues');
    expect((await request('deploy/preflight')).status).toBe(401);

    const forbidden = await request('deploy/preflight', { token: 'outsider' });
    expect(forbidden.status).toBe(403);

    const missingOrg = await fetch(
      `${base}/v1/orgs/missing/apps/support/envs/prod/deploy/preflight`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin',
          'content-type': 'application/json',
        },
        body: body(),
      },
    );
    expect(missingOrg.status).toBe(404);
    await expect(missingOrg.json()).resolves.toMatchObject({ code: 'organization_not_found' });
    expect(check).not.toHaveBeenCalled();
    expect(resolveConfig).not.toHaveBeenCalled();
  });

  it('returns the complete missing-config checklist without creating an app or environment', async () => {
    await config.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
      name: 'UNRELATED_SECRET',
      value: 'must-never-appear',
    });

    const response = await request('deploy/preflight', { token: 'owner' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ready: false,
      ownerSubject: 'owner-sub',
      target: {
        org: 'acme',
        app: 'support',
        env: 'prod',
        appState: 'will-create',
        environmentState: 'will-create',
      },
      config: {
        ready: false,
        missingSecrets: ['API_TOKEN'],
        missingVariables: ['API_BASE_URL'],
      },
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'missing_secret', path: 'secrets.API_TOKEN' }),
        expect.objectContaining({
          code: 'missing_variable',
          path: 'variables.API_BASE_URL',
        }),
      ]),
    });
    expect(await artifacts.loadAll()).toHaveLength(0);
    expect(await registry.getApp('acme', 'support')).toBeUndefined();
    expect(await registry.getEnvironment('acme', 'support', 'prod')).toBeUndefined();
    expect(JSON.stringify(await audit.list({ org: 'acme' }))).not.toContain('must-never-appear');
  });

  it('returns every missing server secret and variable in one preflight response', async () => {
    const response = await request('deploy/preflight', {
      token: 'owner',
      requestBody: JSON.stringify({
        manifest: SERVER_CONFIG_MANIFEST,
        accessMode: 'owner-only',
        serverVersion: '1',
        deploymentSource: 'cli',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      config: {
        ready: false,
        missingSecrets: ['ASSISTANT_MODEL_API_KEY'],
        missingVariables: ['ASSISTANT_MODEL', 'ASSISTANT_MODEL_BASE_URL'],
      },
      errors: [
        expect.objectContaining({
          code: 'missing_secret',
          path: 'secrets.ASSISTANT_MODEL_API_KEY',
        }),
        expect.objectContaining({
          code: 'missing_variable',
          path: 'variables.ASSISTANT_MODEL_BASE_URL',
        }),
        expect.objectContaining({
          code: 'missing_variable',
          path: 'variables.ASSISTANT_MODEL',
        }),
      ],
    });
  });

  it('keeps an unconfigured origin as one actionable config blocker, preserving interactive repair', async () => {
    const response = await request('deploy/preflight', {
      token: 'owner',
      requestBody: JSON.stringify({ manifest: MANAGED_ORIGIN_MANIFEST, accessMode: 'owner-only' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      config: { ready: false, missingSecrets: [], missingVariables: ['STORE_ORIGIN'] },
      errors: [
        expect.objectContaining({ code: 'missing_variable', path: 'variables.STORE_ORIGIN' }),
      ],
    });
  });

  it('aggregates config, managed-origin, capability and customer-auth blockers without exposing an artifact', async () => {
    await config.setConfigValue({
      kind: 'variable',
      scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
      name: 'STORE_ORIGIN',
      value: 'https://example.com/must-never-appear',
    });
    const manifest = `${MANIFEST.replace('manifestVersion: "1"', 'manifestVersion: "2"')}
requires:
  audit: true
handoff:
  allowedDomains: ["\${env.STORE_ORIGIN}"]
`;
    const response = await request('deploy/preflight', {
      token: 'owner',
      requestBody: JSON.stringify({ manifest, connectors: CONNECTORS, accessMode: 'customers' }),
    });
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({
      ready: false,
      config: { ready: false, missingSecrets: ['API_TOKEN'], missingVariables: ['API_BASE_URL'] },
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'missing_secret', path: 'secrets.API_TOKEN' }),
        expect.objectContaining({ code: 'missing_variable', path: 'variables.API_BASE_URL' }),
        expect.objectContaining({ code: 'invalid_shape', path: 'handoff.allowedDomains.0' }),
        expect.objectContaining({ code: 'missing_capability', path: 'requires.audit' }),
        expect.objectContaining({ code: 'server_auth_required', path: 'server.auth' }),
      ]),
    });
    expect(report.errors).toHaveLength(5);
    const result = await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, manifest, {
      actor: OWNER,
      connectors: CONNECTORS,
      accessMode: 'customers',
    });
    expect(result).toEqual({ ok: false, errors: report.errors });
    expect(JSON.stringify([report, result, await audit.list({ org: 'acme' })])).not.toContain(
      'must-never-appear',
    );
    expect(report).not.toHaveProperty('compiledArtifact');
    expect(await artifacts.loadAll()).toEqual([]);
    expect(await registry.getApp('acme', 'support')).toBeUndefined();
    expect(await registry.getEnvironment('acme', 'support', 'prod')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('retains independent option errors when the manifest cannot compile', async () => {
    const result = await registry.preflightDeploy(
      { org: 'acme', app: 'support', env: 'prod' },
      'manifestVersion: [invalid',
      { actor: OWNER, accessMode: 'customers', orgMembershipSources: [] },
    );
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'membership_sources_empty' }),
        expect.objectContaining({ code: 'membership_sources_requires_org_members' }),
      ]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(2);
    expect(await artifacts.loadAll()).toEqual([]);
  });

  it('reports every CSP fault alongside missing configuration', async () => {
    const response = await request('deploy/preflight', {
      token: 'owner',
      requestBody: JSON.stringify({
        manifest: `${MANIFEST}\nwidgets:\n  - name: view\n    csp:\n      connectDomains: [api.example.com]\n      resourceDomains: [cdn.example.com]\n`,
        connectors: CONNECTORS,
        accessMode: 'owner-only',
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_widget_csp',
          path: 'widgets.0.csp.connectDomains.0',
        }),
        expect.objectContaining({
          code: 'invalid_widget_csp',
          path: 'widgets.0.csp.resourceDomains.0',
        }),
        expect.objectContaining({ code: 'missing_secret', path: 'secrets.API_TOKEN' }),
        expect.objectContaining({ code: 'missing_variable', path: 'variables.API_BASE_URL' }),
      ]),
    });
    expect(await artifacts.loadAll()).toEqual([]);
  });

  it('keeps a public user-context conflict visible alongside independent configuration errors', async () => {
    const response = await request('deploy/preflight', {
      token: 'owner',
      requestBody: JSON.stringify({
        manifest: MANIFEST.replace('args: {}', 'args: { actor: "${user.subject}" }'),
        connectors: CONNECTORS,
        accessMode: 'public',
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'public_user_context_conflict', path: 'accessMode' }),
        expect.objectContaining({ code: 'missing_secret', path: 'secrets.API_TOKEN' }),
        expect.objectContaining({ code: 'missing_variable', path: 'variables.API_BASE_URL' }),
      ]),
    });
    expect(await artifacts.loadAll()).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it('binds an operator-managed exact origin before serving a reusable app', async () => {
    const scope = { level: 'env', org: 'acme', app: 'shopify', env: 'prod' } as const;
    await config.setConfigValue({
      kind: 'variable',
      scope,
      name: 'STORE_ORIGIN',
      value: 'https://merchant.myshopify.com',
    });
    const requestBody = JSON.stringify({
      manifest: MANAGED_ORIGIN_MANIFEST,
      accessMode: 'owner-only',
      serverVersion: '1',
      deploymentSource: 'cli',
    });

    const response = await request('deploy', {
      token: 'owner',
      app: 'shopify',
      requestBody,
    });
    expect(response.status).toBe(201);
    const active = await registry.getActiveByTenant({ org: 'acme', app: 'shopify', env: 'prod' });
    expect(active?.served.artifact.server.handoff?.allowedDomains).toEqual([
      'https://merchant.myshopify.com',
    ]);
    expect(JSON.stringify(active?.served.artifact)).not.toContain('${env.STORE_ORIGIN}');
  });

  it('accepts environment config before the first deploy materializes the app and environment', async () => {
    expect(await registry.getApp('acme', 'support')).toBeUndefined();
    expect(await registry.getEnvironment('acme', 'support', 'prod')).toBeUndefined();

    for (const [kind, name, value] of [
      ['secrets', 'API_TOKEN', 'secret-value'],
      ['variables', 'API_BASE_URL', 'https://api.example.com'],
    ] as const) {
      const response = await fetch(`${base}${targetPath()}/${kind}/${name}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer owner',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ value }),
      });
      expect(response.status).toBe(200);
    }

    expect(await registry.getApp('acme', 'support')).toBeUndefined();
    expect(await registry.getEnvironment('acme', 'support', 'prod')).toBeUndefined();
    const preflight = await request('deploy/preflight', { token: 'owner' });
    expect(preflight.status).toBe(200);
    await expect(preflight.json()).resolves.toMatchObject({
      ready: true,
      config: { ready: true, missingSecrets: [], missingVariables: [] },
    });
    const resolveConfigValues = vi.spyOn(config, 'resolveConfigValues');
    expect((await request('deploy', { token: 'owner' })).status).toBe(201);
    expect(resolveConfigValues.mock.calls.map(([kind]) => kind).sort()).toEqual([
      'secret',
      'variable',
    ]);
    expect(await registry.getApp('acme', 'support')).toBeDefined();
    expect(await registry.getEnvironment('acme', 'support', 'prod')).toBeDefined();
    expect(await artifacts.loadAll()).toHaveLength(1);
  });

  it('reports an existing app and a missing environment as a valid create-on-deploy target', async () => {
    await setRequiredConfig('prod');
    expect((await request('deploy', { token: 'owner' })).status).toBe(201);

    await setRequiredConfig('staging');
    const response = await request('deploy/preflight', {
      token: 'owner',
      env: 'staging',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ready: true,
      target: {
        appState: 'existing',
        environmentState: 'will-create',
      },
      config: {
        ready: true,
        missingSecrets: [],
        missingVariables: [],
      },
    });
    expect(await registry.getEnvironment('acme', 'support', 'staging')).toBeUndefined();
  });

  it('replays the same deploy key without creating another app, environment, or deployment', async () => {
    await setRequiredConfig('prod');

    const first = await request('deploy', { token: 'owner' });
    const second = await request('deploy', { token: 'owner' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { deploymentId: string };
    const secondBody = (await second.json()) as { deploymentId: string };
    expect(secondBody.deploymentId).toBe(firstBody.deploymentId);
    expect(await artifacts.loadAll()).toHaveLength(1);
    expect((await registry.listApps('acme')).apps).toHaveLength(1);
    expect(await registry.listEnvironments('acme', 'support')).toHaveLength(1);
  });

  it('rejects reusing one idempotency key with a different request', async () => {
    await setRequiredConfig('prod');
    const requestBody = body();
    const key = deployKey('acme', 'support', 'prod', requestBody);
    const first = await fetch(`${base}${targetPath()}/deploy`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer owner',
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: requestBody,
    });
    expect(first.status).toBe(201);

    const changedBody = JSON.stringify({
      ...JSON.parse(requestBody),
      manifest: `${MANIFEST}\n# changed request`,
    });
    const replay = await fetch(`${base}${targetPath()}/deploy`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer owner',
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: changedBody,
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: 'idempotency_conflict' });
    expect(await artifacts.loadAll()).toHaveLength(1);
  });
});

async function setRequiredConfig(env: string): Promise<void> {
  const scope = { level: 'env', org: 'acme', app: 'support', env } as const;
  await config.setConfigValue({
    kind: 'secret',
    scope,
    name: 'API_TOKEN',
    value: 'secret-value',
  });
  await config.setConfigValue({
    kind: 'variable',
    scope,
    name: 'API_BASE_URL',
    value: 'https://api.example.com',
  });
}
