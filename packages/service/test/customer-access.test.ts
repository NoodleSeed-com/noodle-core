import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ControlPlaneAuthResult,
  createServiceHandler,
  type DeployAuthGate,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type TenantAuthConfig,
} from '../src/index.js';

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const ISSUER = 'https://tenant-idp.example';

const CUSTOMER_MANIFEST = `
manifestVersion: "1"
server:
  name: customer_app
  version: 1.0.0
  title: Customer App
  auth:
    issuer: ${ISSUER}
    audience: customer-audience
tools:
  - name: whoami
    description: Show the verified customer.
    authorization:
      requiredScopes: [tickets.write, read, tickets.write]
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: user
          map:
            subject: \${user.subject}
            email: \${user.email}
      output:
        subject: \${steps.user.subject}
        email: \${steps.user.email}
`;

const NO_AUTH_MANIFEST = CUSTOMER_MANIFEST.replace(/ {2}auth:[\s\S]*?tools:/, 'tools:');

const BRIDGE_MANIFEST = `
manifestVersion: "1"
server:
  name: bridged_customer_app
  version: 1.0.0
  title: Bridged Customer App
  auth:
    kind: bridge
    provider: custom
    verifyUrl: https://app.example.com/.well-known/noodle/verify
    user:
      id: sub
      email: email
      tenant: org_id
      roles: roles
tools:
  - name: whoami
    description: Show the verified customer.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: user
          map:
            subject: \${user.subject}
            email: \${user.email}
      output:
        subject: \${steps.user.subject}
        email: \${steps.user.email}
`;

const FIREBASE_MANIFEST = `
manifestVersion: "1"
server:
  name: firebase_customer_app
  version: 1.0.0
  title: Firebase Customer App
  auth:
    kind: bridge
    provider: firebase
    projectId: noodleseed-prod
    apiKey: firebase-public-web-api-key
    authDomain: noodleseed-prod.firebaseapp.com
    user:
      id: sub
      email: email
tools:
  - name: whoami
    description: Show the verified customer.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: user
          map:
            subject: \${user.subject}
            email: \${user.email}
      output:
        subject: \${steps.user.subject}
        email: \${steps.user.email}
`;

let server: Server;
let base: string;
let registry: ServerRegistry;
let seenAuth: TenantAuthConfig | undefined;

beforeEach(async () => {
  seenAuth = undefined;
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@example.com',
    role: 'owner',
  });
  registry = new ServerRegistry(new InMemoryArtifactStore(), undefined, undefined, {
    customerVerifierFactory: (auth) => {
      seenAuth = auth;
      return async (token, resource) =>
        token === 'tenant-token' && resource === `${base}/o/acme/customer/mcp`
          ? {
              caller: {
                subject: 'cust-sub',
                email: 'cust@example.com',
                scopes: ['read', 'tickets.write'],
                audience: auth.audience,
                identityKind: 'customer' as const,
              },
            }
          : null;
    },
  });
  server = createServer(
    createServiceHandler(registry, {
      controlPlaneStore: controlPlane,
      deployGate: gate(),
      verifyOwnerToken: (token) =>
        Promise.resolve(
          token === 'platform-token'
            ? { caller: { subject: 'owner-sub' } }
            : token === 'bridge-token'
              ? {
                  caller: {
                    subject: 'cust-sub',
                    email: 'cust@example.com',
                    scopes: ['read'],
                  },
                }
              : null,
        ),
      authServerIssuer: 'https://platform-as.example',
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

describe('tenant customer access (B13)', () => {
  it('requires server.auth for customers deployments and serves tenant-verified callers only', async () => {
    const missing = await deploy(NO_AUTH_MANIFEST, 'customers');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'server_auth_required' })],
    });

    const deployed = await deploy(CUSTOMER_MANIFEST, 'customers');
    expect(deployed.status).toBe(201);
    expect(seenAuth).toEqual({ issuer: ISSUER, audience: 'customer-audience' });

    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/o/acme/customer/mcp`);
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({
      authorization_servers: [ISSUER],
      scopes_supported: ['read', 'tickets.write'],
    });

    expect((await initialize()).status).toBe(401);
    expect((await initialize('platform-token')).status).toBe(401);

    const ok = await callWhoami('tenant-token');
    expect(ok).toMatchObject({
      subject: 'cust-sub',
      email: 'cust@example.com',
    });
  });

  it('rejects switching an existing deployment to customers when server.auth is absent', async () => {
    const deployed = await deploy(NO_AUTH_MANIFEST, 'owner-only');
    expect(deployed.status).toBe(201);

    const updated = await fetch(`${base}/v1/orgs/acme/apps/customer/envs/prod/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ accessMode: 'customers' }),
    });

    expect(updated.status).toBe(409);
    expect(await updated.json()).toEqual({
      error: 'Customer access requires server authentication.',
      code: 'server_auth_required',
    });
    await expect(
      registry.activeDeployProvenance({ org: 'acme', app: 'customer', env: 'prod' }),
    ).resolves.toMatchObject({
      accessMode: 'owner-only',
    });
  });

  it('advertises the platform authorization server for custom bridge auth but fails closed until bridge issuance is configured', async () => {
    const deployed = await deploy(BRIDGE_MANIFEST, 'customers');
    const deployedBody = await deployed.clone().json();
    expect(deployed.status, JSON.stringify(deployedBody)).toBe(201);
    expect(seenAuth).toMatchObject({ kind: 'bridge', provider: 'custom' });

    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/o/acme/customer/mcp`);
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({
      authorization_servers: ['https://platform-as.example'],
    });

    expect((await initialize()).status).toBe(401);
    expect((await initialize('platform-token')).status).toBe(401);
    expect((await initialize('bridge-token')).status).toBe(401);
  });

  it('accepts Firebase bridge auth config for customer deployments and still fails closed without Firebase verifier setup', async () => {
    const deployed = await deploy(FIREBASE_MANIFEST, 'customers');
    const deployedBody = await deployed.clone().json();
    expect(deployed.status, JSON.stringify(deployedBody)).toBe(201);
    expect(seenAuth).toMatchObject({
      kind: 'bridge',
      provider: 'firebase',
      projectId: 'noodleseed-prod',
      apiKey: 'firebase-public-web-api-key',
      authDomain: 'noodleseed-prod.firebaseapp.com',
    });

    const prm = await fetch(`${base}/.well-known/oauth-protected-resource/o/acme/customer/mcp`);
    expect(prm.status).toBe(200);
    expect(await prm.json()).toMatchObject({
      authorization_servers: ['https://platform-as.example'],
    });

    expect((await initialize('platform-token')).status).toBe(401);
  });

  it('fails closed for customer endpoints when no customer verifier factory is installed', async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.addOrgMember({
      org: 'acme',
      subject: 'owner-sub',
      email: 'owner@example.com',
      role: 'owner',
    });
    registry = new ServerRegistry(new InMemoryArtifactStore());
    server = createServer(
      createServiceHandler(registry, {
        controlPlaneStore: controlPlane,
        deployGate: gate(),
        verifyOwnerToken: (token) =>
          Promise.resolve(token === 'platform-token' ? { caller: { subject: 'owner-sub' } } : null),
        authServerIssuer: 'https://platform-as.example',
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const deployed = await deploy(CUSTOMER_MANIFEST, 'customers');
    expect(deployed.status).toBe(201);

    expect((await initialize('platform-token')).status).toBe(401);
    expect((await initialize('tenant-token')).status).toBe(401);
  });
});

function gate(): DeployAuthGate {
  return {
    authorize(): ControlPlaneAuthResult {
      return {
        ok: true,
        identity: {
          subject: 'owner-sub',
          email: 'owner@example.com',
          superAdmin: false,
        },
      };
    },
  };
}

function deploy(manifest: string, accessMode: string): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/customer/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ manifest, accessMode }),
  });
}

function initialize(token?: string): Promise<Response> {
  return mcp(
    {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    },
    token,
  );
}

async function callWhoami(token: string): Promise<Record<string, unknown>> {
  const res = await mcp(
    {
      jsonrpc: '2.0',
      id: 'whoami',
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    },
    token,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.result.structuredContent as Record<string, unknown>;
}

function mcp(body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/o/acme/customer/mcp`, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      'mcp-protocol-version': '2025-11-25',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
