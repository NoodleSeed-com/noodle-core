import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStaticSigningKeyProvider, mintAccessToken } from '@noodle-borg/auth';
import { GoogleWorkloadControlPlaneGate } from '@noodle-borg/control-plane/portable';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  serveService,
} from '../src/index.js';
import { pkce } from './oauth-http-test-helpers.js';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet someone.
    inputSchema:
      type: object
      properties:
        name:
          type: string
      required:
        - name
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

function helloManifest(message: string): string {
  return HELLO.replace('Hello, ${input.name}!', `${message}, \${input.name}!`);
}

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_TOKEN = 'OWNER';
const NO_AUTH = '__NO_AUTH__';

function tenantDeployUrl(baseUrl: string, app = 'hello', env = 'prod'): string {
  return `${baseUrl}/v1/orgs/acme/apps/${app}/envs/${env}/deploy`;
}

function authHeaders(key: string | undefined): Record<string, string> {
  if (key === NO_AUTH) return {};
  return { authorization: `Bearer ${OWNER_TOKEN}` };
}

function initialize(url: string, key?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...authHeaders(key) },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
}

function callGreet(url: string, name: string, key?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...authHeaders(key) },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name } },
    }),
  });
}

describe('internal alpha control-plane endpoints', () => {
  const verifier: GoogleIdTokenVerifier = {
    verify: (token, audience) => {
      if (audience !== 'google-client' || token !== 'admin-token') throw new Error('bad token');
      return Promise.resolve({ subject: 'admin-sub', email: 'admin@noodleseed.com' });
    },
  };

  async function startAuthenticated() {
    const logger = { debug() {}, info: vi.fn(), warn() {}, error() {} };
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrg({ slug: 'acme' });
    const server = createServer(
      createServiceHandler(new ServerRegistry(), {
        logger,
        controlPlaneStore: controlPlane,
        controlPlaneGoogleClientId: 'google-client',
        deployGate: new GoogleControlPlaneGate({
          audience: 'google-client',
          admins: ['admin@noodleseed.com'],
          verifier,
        }),
        verifyOwnerToken: (token) =>
          Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'admin-sub' } } : null),
        authServerIssuer: 'https://as.noodle.test',
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      logger,
      base: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  const auth = { authorization: 'Bearer admin-token' };

  it('advertises service-backed Google login metadata', async () => {
    const s = await startAuthenticated();
    try {
      const res = await fetch(`${s.base}/v1/auth/google`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        googleClientId: 'google-client',
        allowedEmailDomain: '@noodleseed.com',
        authType: 'google-oauth-pkce',
      });
    } finally {
      await s.close();
    }
  });

  it('advertises self-hosted OAuth login and accepts service-minted control-plane tokens', async () => {
    const signer = await createStaticSigningKeyProvider();
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.addOrgMember({
      org: 'acme',
      subject: 'sub-1',
      email: 'dev@noodleseed.com',
      role: 'owner',
    });
    const s = await serveService({
      port: 0,
      publicBaseUrl: 'https://svc.example',
      controlPlaneStore: controlPlane,
      oauth: {
        issuer: 'https://svc.example',
        signer,
        google: {
          authorizationUrl: (state) =>
            `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
          exchange: () => Promise.resolve({ subject: 'sub-1', email: 'dev@noodleseed.com' }),
        },
        allowedEmailDomain: '@noodleseed.com',
      },
    });
    try {
      const metadata = await fetch(`${s.url}/v1/auth/google`);
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({
        ok: true,
        googleClientId: null,
        authType: 'noodle-oauth-pkce',
        authorizationServerIssuer: 'https://svc.example',
        controlPlaneResource: 'https://svc.example',
      });

      const redirectUri = 'https://chatgpt.com/connector/oauth/callback';
      const registration = await fetch(`${s.url}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Noodle Developer Plugin',
          application_type: 'web',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      });
      expect(registration.status).toBe(201);
      const clientId = ((await registration.json()) as { client_id: string }).client_id;
      const developerPkce = pkce();
      const developerResource = 'https://svc.example/developer/cli';
      const authorizeUrl = new URL(`${s.url}/authorize`);
      authorizeUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: developerPkce.challenge,
        code_challenge_method: 'S256',
        resource: developerResource,
      }).toString();
      const authorization = await fetch(authorizeUrl, { redirect: 'manual' });
      expect(authorization.status).toBe(302);
      const state = new URL(authorization.headers.get('location') as string).searchParams.get(
        'state',
      );
      const callback = await fetch(
        `${s.url}/oauth/google/callback?code=google-code&state=${encodeURIComponent(state as string)}`,
      );
      expect(callback.status).toBe(200);
      const selectionPage = await callback.text();
      expect(selectionPage).toContain('name="grant_token"');
      expect(selectionPage).toContain('name="decision" value="approve"');
      expect(selectionPage).not.toContain('name="org"');
      expect(selectionPage).not.toContain('name="environment"');
      const grantToken = /name="grant_token" value="([^"]+)"/.exec(selectionPage)?.[1];
      expect(grantToken).toBeTruthy();
      const grantDecision = await fetch(`${s.url}/oauth/developer-grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_token: grantToken as string,
          decision: 'approve',
        }),
        redirect: 'manual',
      });
      expect(grantDecision.status).toBe(302);
      const code = new URL(grantDecision.headers.get('location') as string).searchParams.get(
        'code',
      );
      const developerTokenResponse = await fetch(`${s.url}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code as string,
          code_verifier: developerPkce.verifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          resource: developerResource,
        }),
      });
      expect(developerTokenResponse.status).toBe(200);
      const developerToken = (await developerTokenResponse.json()).access_token as string;
      const developerDeploy = await fetch(
        `${s.url}/v1/orgs/acme/apps/plugin-built/envs/dev/deploy`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${developerToken}`,
          },
          body: JSON.stringify({ manifest: HELLO, accessMode: 'org-members' }),
        },
      );
      expect(developerDeploy.status).toBe(201);
      const productionDeploy = await fetch(
        `${s.url}/v1/orgs/acme/apps/plugin-built/envs/prod/deploy`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${developerToken}`,
          },
          body: JSON.stringify({ manifest: HELLO, accessMode: 'org-members' }),
        },
      );
      expect(productionDeploy.status).toBe(201);

      const forbiddenOwnerSelection = await fetch(
        `${s.url}/v1/orgs/acme/apps/plugin-built-owner/envs/dev/deploy`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${developerToken}`,
          },
          body: JSON.stringify({
            manifest: HELLO,
            accessMode: 'owner-only',
            ownerSubject: 'oauth-human',
          }),
        },
      );
      expect(forbiddenOwnerSelection.status).toBe(403);

      const token = await mintAccessToken(
        signer,
        {
          issuer: 'https://svc.example',
          subject: 'sub-1',
          email: 'dev@noodleseed.com',
          // The OAuth SDK parses `resource=https://svc.example` as a URL and passes `.href`,
          // which canonicalizes a pathless origin to `https://svc.example/`.
          audience: 'https://svc.example/',
        },
        3600,
      );
      const whoami = await fetch(`${s.url}/v1/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(whoami.status).toBe(200);
      expect(await whoami.json()).toMatchObject({
        identity: {
          subject: 'sub-1',
          email: 'dev@noodleseed.com',
          superAdmin: false,
        },
        orgs: [{ slug: 'acme' }],
      });
    } finally {
      await s.close();
    }
  });

  it('lists identity deployments and does not expose key-management routes', async () => {
    const s = await startAuthenticated();
    try {
      const depRes = await fetch(tenantDeployUrl(s.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ manifest: HELLO }),
      });
      expect(depRes.status).toBe(201);
      const dep = await depRes.json();
      const list = await fetch(`${s.base}/v1/orgs/acme/deployments?app=hello&env=prod`, {
        headers: auth,
      });
      expect(list.status).toBe(200);
      expect((await list.json()).deployments[0]).toMatchObject({
        deploymentId: dep.deploymentId,
        active: true,
        accessMode: 'owner-only',
      });

      const keys = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/keys`, {
        headers: auth,
      });
      expect(keys.status).toBe(404);

      const rotated = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/keys/rotate`, {
        method: 'POST',
        headers: auth,
      });
      expect(rotated.status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('returns active deployment status without secret material', async () => {
    const s = await startAuthenticated();
    try {
      const depRes = await fetch(tenantDeployUrl(s.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ manifest: HELLO, serverVersion: '1' }),
      });
      expect(depRes.status).toBe(201);
      const dep = await depRes.json();
      expect(dep.serverVersion).toBe('1');
      expect(dep.url).toBe(`${s.base}/o/acme/hello/v1/mcp`);
      expect(dep.defaultUrl).toBe(`${s.base}/o/acme/hello/mcp`);

      const status = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/status`, {
        headers: auth,
      });
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(body).toMatchObject({
        ok: true,
        target: { org: 'acme', app: 'hello', env: 'prod' },
        deployment: {
          deploymentId: dep.deploymentId,
          serverVersion: '1',
          endpointUrl: dep.url,
          active: true,
          accessMode: 'owner-only',
          serverName: 'hello',
          createdByEmail: 'admin@noodleseed.com',
        },
        health: { state: 'ready' },
        config: { ok: true, missingSecrets: [] },
      });
      expect(JSON.stringify(body)).not.toContain('OWNER');
    } finally {
      await s.close();
    }
  });

  it('returns exact versioned deployment status while default status tracks the highest version', async () => {
    const s = await startAuthenticated();
    try {
      const first = await (
        await fetch(tenantDeployUrl(s.base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ manifest: helloManifest('Hello'), serverVersion: '1' }),
        })
      ).json();
      const second = await (
        await fetch(tenantDeployUrl(s.base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ manifest: helloManifest('Goodbye'), serverVersion: '2.0.0' }),
        })
      ).json();

      const defaultStatus = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/status`, {
        headers: auth,
      });
      expect(defaultStatus.status).toBe(200);
      expect((await defaultStatus.json()).deployment).toMatchObject({
        deploymentId: second.deploymentId,
        serverVersion: '2.0.0',
        endpointUrl: second.url,
      });

      const exactStatus = await fetch(
        `${s.base}/v1/orgs/acme/apps/hello/envs/prod/status?version=1`,
        { headers: auth },
      );
      expect(exactStatus.status).toBe(200);
      expect((await exactStatus.json()).deployment).toMatchObject({
        deploymentId: first.deploymentId,
        serverVersion: '1',
        endpointUrl: first.url,
      });

      const access = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ accessMode: 'authenticated', serverVersion: '1' }),
      });
      expect(access.status).toBe(200);
      expect((await access.json()).deployment).toMatchObject({
        deploymentId: first.deploymentId,
        serverVersion: '1',
        accessMode: 'authenticated',
      });

      const v1AfterAccess = await fetch(
        `${s.base}/v1/orgs/acme/apps/hello/envs/prod/status?version=1`,
        { headers: auth },
      );
      expect((await v1AfterAccess.json()).deployment.accessMode).toBe('authenticated');
      const defaultAfterAccess = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/status`, {
        headers: auth,
      });
      expect((await defaultAfterAccess.json()).deployment).toMatchObject({
        deploymentId: second.deploymentId,
        serverVersion: '2.0.0',
        accessMode: 'owner-only',
      });
    } finally {
      await s.close();
    }
  });

  it('reports missing managed secrets in deployment status after config changes', async () => {
    const s = await startAuthenticated();
    try {
      await fetch(`${s.base}/v1/orgs/acme/apps/needs-secret/envs/prod/secrets/api_token`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ value: 'SECRET_VALUE' }),
      });
      const connectors = `
connectors:
  - id: svc
    version: 1.0.0
    http:
      baseUrl: http://127.0.0.1:1
      allowedOrigins: [ http://127.0.0.1:1 ]
      auth: { kind: bearer, secret: api_token }
    operations:
      ping:
        type: read
        method: GET
        path: /ping
        output: {}
        response: {}
`;
      const depRes = await fetch(tenantDeployUrl(s.base, 'needs-secret'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ manifest: HELLO, connectors }),
      });
      expect(depRes.status).toBe(201);
      await fetch(`${s.base}/v1/orgs/acme/apps/needs-secret/envs/prod/secrets/api_token`, {
        method: 'DELETE',
        headers: auth,
      });

      const status = await fetch(`${s.base}/v1/orgs/acme/apps/needs-secret/envs/prod/status`, {
        headers: auth,
      });
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(body.config).toEqual({ ok: false, missingSecrets: ['api_token'] });
      expect(JSON.stringify(body)).not.toContain('SECRET_VALUE');
    } finally {
      await s.close();
    }
  });

  it('updates active deployment access through an authenticated tenant API', async () => {
    const s = await startAuthenticated();
    try {
      const dep = await (
        await fetch(tenantDeployUrl(s.base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ manifest: HELLO }),
        })
      ).json();

      const access = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ accessMode: 'org-members' }),
      });
      expect(access.status).toBe(200);
      expect(await access.json()).toMatchObject({
        ok: true,
        target: { org: 'acme', app: 'hello', env: 'prod' },
        deployment: { deploymentId: dep.deploymentId, accessMode: 'org-members' },
      });

      const status = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/status`, {
        headers: auth,
      });
      expect((await status.json()).deployment.accessMode).toBe('org-members');
    } finally {
      await s.close();
    }
  });

  it('rolls back the active tenant deployment without changing the endpoint URL', async () => {
    const s = await startAuthenticated();
    try {
      const first = await (
        await fetch(tenantDeployUrl(s.base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ manifest: helloManifest('Hello') }),
        })
      ).json();
      const second = await (
        await fetch(tenantDeployUrl(s.base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ manifest: helloManifest('Goodbye') }),
        })
      ).json();
      expect(second.url).toBe(first.url);
      expect(await (await callGreet(second.url, 'Ada')).json()).toMatchObject({
        result: { structuredContent: { message: 'Goodbye, Ada!' } },
      });

      const rollback = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ deploymentId: first.deploymentId, reason: 'bad deploy' }),
      });
      expect(rollback.status).toBe(200);
      expect(await rollback.json()).toMatchObject({
        ok: true,
        target: { org: 'acme', app: 'hello', env: 'prod' },
        rollback: {
          deploymentId: first.deploymentId,
          previousDeploymentId: second.deploymentId,
          alreadyActive: false,
          endpointUrl: first.url,
          accessMode: 'owner-only',
          previousAccessMode: 'owner-only',
        },
      });
      expect(await (await callGreet(first.url, 'Ada')).json()).toMatchObject({
        result: { structuredContent: { message: 'Hello, Ada!' } },
      });
    } finally {
      await s.close();
    }
  });

  it('rejects unauthenticated status and access update requests', async () => {
    const s = await startAuthenticated();
    try {
      const status = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/status`);
      expect(status.status).toBe(401);
      const access = await fetch(`${s.base}/v1/orgs/acme/apps/hello/envs/prod/access`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessMode: 'org-members' }),
      });
      expect(access.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('emits safe admission events for MCP requests', async () => {
    const s = await startAuthenticated();
    try {
      const dep = await (
        await fetch(tenantDeployUrl(s.base), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ manifest: HELLO }),
        })
      ).json();
      expect((await initialize(dep.url)).status).toBe(200);
      expect(s.logger.info).toHaveBeenCalledWith(
        'mcp.admission',
        expect.objectContaining({
          routeId: 'acme/hello/prod@1',
          method: 'initialize',
          category: 'protocol',
          serverVersion: '1',
          decision: 'allow',
        }),
      );
    } finally {
      await s.close();
    }
  });
});

describe('Google control-plane auth and org membership', () => {
  const verifier: GoogleIdTokenVerifier = {
    verify: async (token: string) => {
      if (token === 'owner') return { subject: 'sub-owner', email: 'owner@noodleseed.com' };
      if (token === 'dev') return { subject: 'sub-dev', email: 'dev@noodleseed.com' };
      if (token === 'admin') return { subject: 'sub-admin', email: 'admin@noodleseed.com' };
      if (token === 'outsider') return { subject: 'sub-out', email: 'person@example.com' };
      throw new Error('bad token');
    },
  };

  async function listenControlPlane(
    options: { signupMode?: 'public'; workload?: boolean } = {},
  ): Promise<{
    url: string;
    artifacts: InMemoryArtifactStore;
    registry: ServerRegistry;
    audit: InMemoryAuditStore;
    store: InMemoryControlPlaneStore;
    close: () => Promise<void>;
  }> {
    const store = new InMemoryControlPlaneStore();
    const artifacts = new InMemoryArtifactStore();
    const audit = new InMemoryAuditStore();
    const registry = new ServerRegistry(artifacts);
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
      createServiceHandler(registry, {
        audit,
        controlPlaneStore: store,
        deployGate: options.workload
          ? new GoogleWorkloadControlPlaneGate({
              audience: 'client-id',
              subjects: ['109876543210987654321'],
              admins: [],
              verifier: {
                verify: async () => ({
                  subject: '109876543210987654321',
                  email: 'release@example.iam.gserviceaccount.com',
                }),
              },
            })
          : new GoogleControlPlaneGate({
              audience: 'client-id',
              admins: ['admin@noodleseed.com'],
              verifier,
              ...(options.signupMode === undefined ? {} : { signupMode: options.signupMode }),
            }),
        ...(options.signupMode === undefined ? {} : { controlPlaneSignupMode: options.signupMode }),
      }),
    );
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      artifacts,
      registry,
      audit,
      store,
      close: () =>
        new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  function deployWith(baseUrl: string, token?: string, org = 'acme'): Promise<Response> {
    return fetch(`${baseUrl}/v1/orgs/${org}/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ manifest: HELLO }),
    });
  }

  it('returns a bounded identity-only whoami projection without loading organization state', async () => {
    const srv = await listenControlPlane({ signupMode: 'public' });
    const listOrgs = vi.spyOn(srv.store, 'listOrgs');
    const listOrgsForSubject = vi.spyOn(srv.store, 'listOrgsForSubject');
    const provisionPersonalWorkspace = vi.spyOn(srv.store, 'provisionPersonalWorkspace');
    try {
      for (const [token, identity] of [
        ['owner', { subject: 'sub-owner', email: 'owner@noodleseed.com', superAdmin: false }],
        ['admin', { subject: 'sub-admin', email: 'admin@noodleseed.com', superAdmin: true }],
      ] as const) {
        const response = await fetch(`${srv.url}/v1/whoami?scope=identity`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toStrictEqual({ ok: true, data: { identity } });
      }
      expect(listOrgs).not.toHaveBeenCalled();
      expect(listOrgsForSubject).not.toHaveBeenCalled();
      expect(provisionPersonalWorkspace).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });

  it('authenticates identity-only whoami and rejects every ambiguous scope', async () => {
    const srv = await listenControlPlane();
    try {
      const unauthenticated = await fetch(`${srv.url}/v1/whoami?scope=identity`);
      await unauthenticated.text();
      expect(unauthenticated.status).toBe(401);

      for (const query of [
        'scope=',
        'scope=organizations',
        'scope=identity%2Corganizations',
        'scope=identity&scope=identity',
        'scope=identity&scope=organizations',
      ]) {
        const response = await fetch(`${srv.url}/v1/whoami?${query}`, {
          headers: { authorization: 'Bearer owner' },
        });
        await response.text();
        expect(response.status, query).toBe(400);
      }
    } finally {
      await srv.close();
    }
  });

  it('keeps verified workload provenance internal in both whoami projections', async () => {
    const srv = await listenControlPlane({ workload: true });
    try {
      for (const suffix of ['', '?scope=identity']) {
        const response = await fetch(`${srv.url}/v1/whoami${suffix}`, {
          headers: { authorization: 'Bearer workload' },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(suffix ? body.data.identity : body.identity).toEqual({
          subject: '109876543210987654321',
          email: 'release@example.iam.gserviceaccount.com',
          superAdmin: false,
        });
      }
    } finally {
      await srv.close();
    }
  });

  it('keeps the default whoami response byte- and shape-compatible', async () => {
    const srv = await listenControlPlane();
    try {
      const response = await fetch(`${srv.url}/v1/whoami`, {
        headers: { authorization: 'Bearer owner' },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(
        JSON.stringify({
          ok: true,
          identity: {
            subject: 'sub-owner',
            email: 'owner@noodleseed.com',
            superAdmin: false,
          },
          orgs: [await srv.store.getOrg('acme')],
        }),
      );
    } finally {
      await srv.close();
    }
  });

  it('returns 401 for missing/invalid Google credentials and 403 for disallowed domains', async () => {
    const srv = await listenControlPlane();
    try {
      expect((await deployWith(srv.url)).status).toBe(401);
      expect((await deployWith(srv.url, 'bad')).status).toBe(401);
      expect((await deployWith(srv.url, 'outsider')).status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it('requires explicit org membership for deploy and records the deployer identity', async () => {
    const srv = await listenControlPlane();
    try {
      expect((await deployWith(srv.url, 'owner', 'other')).status).toBe(403);
      const res = await deployWith(srv.url, 'owner');
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.ok).toBe(true);
      const record = await srv.artifacts.get(body.deploymentId);
      expect(record?.createdBySubject).toBe('sub-owner');
      expect(record?.createdByEmail).toBe('owner@noodleseed.com');
    } finally {
      await srv.close();
    }
  });

  it('lets members bind only themselves while owners and superadmins may bind another subject', async () => {
    const srv = await listenControlPlane();
    try {
      const omitted = await fetch(`${srv.url}/v1/orgs/acme/apps/member-omitted/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
        body: JSON.stringify({ manifest: HELLO }),
      });
      expect(omitted.status).toBe(201);
      await expect(omitted.json()).resolves.toMatchObject({ ownerSubject: 'sub-dev' });

      const self = await fetch(`${srv.url}/v1/orgs/acme/apps/member-self/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
        body: JSON.stringify({
          manifest: HELLO,
          accessMode: 'owner-only',
          ownerSubject: 'sub-dev',
        }),
      });
      expect(self.status).toBe(201);
      await expect(self.json()).resolves.toMatchObject({ ownerSubject: 'sub-dev' });

      const deploySpy = vi.spyOn(srv.registry, 'deploy');
      const denied = await fetch(`${srv.url}/v1/orgs/acme/apps/member-other/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
        body: JSON.stringify({
          manifest: HELLO,
          accessMode: 'owner-only',
          ownerSubject: 'oauth-human',
        }),
      });
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({
        code: 'deployment_owner_authorization_required',
      });
      expect(deploySpy).not.toHaveBeenCalled();
      await expect(srv.registry.getApp('acme', 'member-other')).resolves.toBeUndefined();
      expect(
        (await srv.audit.list({ org: 'acme', eventType: 'deploy.accepted' })).some(
          (event) => event.app === 'member-other',
        ),
      ).toBe(false);

      for (const [token, app] of [
        ['owner', 'owner-transfer'],
        ['admin', 'admin-transfer'],
      ] as const) {
        const privileged = await fetch(`${srv.url}/v1/orgs/acme/apps/${app}/envs/prod/deploy`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            manifest: HELLO,
            accessMode: 'owner-only',
            ownerSubject: 'oauth-human',
          }),
        });
        expect(privileged.status).toBe(201);
        await expect(privileged.json()).resolves.toMatchObject({ ownerSubject: 'oauth-human' });
      }
    } finally {
      await srv.close();
    }
  });

  it('authorizes and echoes the same effective owner before deploy preflight compilation', async () => {
    const srv = await listenControlPlane();
    try {
      const preflightSpy = vi.spyOn(srv.registry, 'preflightDeploy');
      const denied = await fetch(
        `${srv.url}/v1/orgs/acme/apps/preflight-denied/envs/prod/deploy/preflight`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
          body: JSON.stringify({
            manifest: HELLO,
            accessMode: 'owner-only',
            ownerSubject: 'oauth-human',
          }),
        },
      );
      expect(denied.status).toBe(403);
      expect(preflightSpy).not.toHaveBeenCalled();
      expect(
        (await srv.audit.list({ org: 'acme', eventType: 'deploy.preflight.checked' })).some(
          (event) => event.app === 'preflight-denied',
        ),
      ).toBe(false);

      const memberSelf = await fetch(
        `${srv.url}/v1/orgs/acme/apps/preflight-self/envs/prod/deploy/preflight`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
          body: JSON.stringify({ manifest: HELLO }),
        },
      );
      expect(memberSelf.status).toBe(200);
      await expect(memberSelf.json()).resolves.toMatchObject({ ownerSubject: 'sub-dev' });

      const ownerTransfer = await fetch(
        `${srv.url}/v1/orgs/acme/apps/preflight-owner/envs/prod/deploy/preflight`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
          body: JSON.stringify({
            manifest: HELLO,
            accessMode: 'owner-only',
            ownerSubject: 'oauth-human',
          }),
        },
      );
      expect(ownerTransfer.status).toBe(200);
      await expect(ownerTransfer.json()).resolves.toMatchObject({ ownerSubject: 'oauth-human' });
    } finally {
      await srv.close();
    }
  });

  it('lets super-admins create orgs and manage members; non-admins cannot', async () => {
    const srv = await listenControlPlane();
    try {
      const denied = await fetch(`${srv.url}/v1/orgs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
        body: JSON.stringify({ slug: 'beta' }),
      });
      expect(denied.status).toBe(403);

      const created = await fetch(`${srv.url}/v1/orgs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
        body: JSON.stringify({ slug: 'beta', displayName: 'Beta' }),
      });
      expect(created.status).toBe(201);
      expect((await created.json()).org.slug).toBe('beta');

      const creatorMembership = await fetch(`${srv.url}/v1/orgs/beta/members`, {
        headers: { authorization: 'Bearer admin' },
      });
      expect(creatorMembership.status).toBe(200);
      expect((await creatorMembership.json()).members).toEqual([
        expect.objectContaining({
          subject: 'sub-admin',
          email: 'admin@noodleseed.com',
          role: 'owner',
        }),
      ]);

      const member = await fetch(`${srv.url}/v1/orgs/beta/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
        body: JSON.stringify({
          subject: 'sub-owner',
          email: 'owner@noodleseed.com',
          role: 'developer',
        }),
      });
      expect(member.status).toBe(201);
      expect((await member.json()).member.role).toBe('developer');

      expect((await deployWith(srv.url, 'owner', 'beta')).status).toBe(201);

      const whoami = await fetch(`${srv.url}/v1/whoami`, {
        headers: { authorization: 'Bearer owner' },
      });
      const who = await whoami.json();
      expect(who.orgs.map((org: { slug: string }) => org.slug).sort()).toEqual(['acme', 'beta']);

      const removed = await fetch(`${srv.url}/v1/orgs/beta/members/sub-owner`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer admin' },
      });
      expect(removed.status).toBe(204);
      expect((await deployWith(srv.url, 'owner', 'beta')).status).toBe(403);
    } finally {
      await srv.close();
    }
  });

  it('requires org owner role for rollback', async () => {
    const srv = await listenControlPlane();
    try {
      const first = await (await deployWith(srv.url, 'owner')).json();
      const second = await fetch(`${srv.url}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
        body: JSON.stringify({ manifest: helloManifest('Goodbye') }),
      });
      expect(second.status).toBe(201);

      const developer = await fetch(`${srv.url}/v1/orgs/acme/apps/hello/envs/prod/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
        body: JSON.stringify({ deploymentId: first.deploymentId }),
      });
      expect(developer.status).toBe(403);

      const owner = await fetch(`${srv.url}/v1/orgs/acme/apps/hello/envs/prod/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
        body: JSON.stringify({ deploymentId: first.deploymentId }),
      });
      expect(owner.status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
