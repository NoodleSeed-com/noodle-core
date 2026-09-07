import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PUBLIC_RECORD_ADMISSION_DEFAULTS } from '@noodle-borg/admission-limits/portable';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnonymousConsumerLimiter, createAdmissionGate } from '../src/admission.js';
import {
  createServiceHandler,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };

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
      properties:
        name: { type: string }
      required: [name]
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

const USER_MANIFEST = `
manifestVersion: "1"
server:
  name: user_app
  version: 1.0.0
  title: User App
tools:
  - name: whoami
    description: Return caller identity.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        subject: \${user.subject}
        email: \${user.email ?? "anonymous"}
`;

let http: Server;
let base: string;
let audit: InMemoryAuditStore;

beforeEach(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  audit = new InMemoryAuditStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });
  http = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@acme.test', superAdmin: false },
          }),
      },
      audit,
      verifyOwnerToken: (token) =>
        Promise.resolve(
          token === 'user-token'
            ? { caller: { subject: 'user-sub', email: 'user@example.test' } }
            : null,
        ),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

describe('consumer access modes (B11)', () => {
  it('deploys public endpoints and serves them without a token or PRM challenge', async () => {
    const deployed = await deploy('public-app', 'public');
    expect(deployed.accessMode).toBe('public');
    const res = await initialize(deployed.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('deploys mixed endpoints with anonymous, valid-token, and invalid-token behavior', async () => {
    const deployed = await deploy('mixed-app', 'mixed');
    expect(deployed.accessMode).toBe('mixed');

    expect((await initialize(deployed.url)).status).toBe(200);
    expect((await initialize(deployed.url, 'user-token')).status).toBe(200);

    const invalid = await initialize(deployed.url, 'bad-token');
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('allows access updates to public, mixed, and authenticated', async () => {
    const deployed = await deploy('update-app', 'owner-only');
    await expect(updateAccess('update-app', 'public')).resolves.toMatchObject({
      status: 200,
      accessMode: 'public',
    });
    await expect(updateAccess('update-app', 'mixed')).resolves.toMatchObject({
      status: 200,
      accessMode: 'mixed',
    });
    await expect(updateAccess('update-app', 'authenticated')).resolves.toMatchObject({
      status: 200,
      accessMode: 'authenticated',
    });
    expect(deployed.accessMode).toBe('owner-only');
  });

  it('allows repeated anonymous public tools/call debugging beyond the former hourly cap', async () => {
    const deployed = await deploy('limited-app', 'public');
    for (let i = 0; i < 70; i++) {
      expect((await callTool(deployed.url, i)).status).toBe(200);
    }
  });

  it('keeps the anonymous bound, identity separation, denial audit and hourly recovery', async () => {
    let now = 0;
    const gate = createAdmissionGate(new AnonymousConsumerLimiter(() => new Date(now)), audit);
    const context = {
      routeId: 'acme/limited-app/prod@1',
      org: 'acme',
      app: 'limited-app',
      env: 'prod',
      accessMode: 'public' as const,
      method: 'tools/call',
      category: 'execute' as const,
      name: 'greet',
      remoteAddress: '192.0.2.1',
    };
    for (let i = 0; i < PUBLIC_RECORD_ADMISSION_DEFAULTS.networkPerHour; i++) {
      expect(await gate(context)).toEqual({ allow: true });
    }
    expect(await gate(context)).toEqual({ allow: false, reason: 'quota_exceeded', status: 429 });

    const [event] = await audit.list({ org: 'acme', eventType: 'tool.call.denied' });
    expect(event).toMatchObject({
      eventType: 'tool.call.denied',
      org: 'acme',
      app: 'limited-app',
      env: 'prod',
      decision: 'deny',
      status: '429',
      reasonCode: 'quota_exceeded',
      details: {
        method: 'tools/call',
        category: 'execute',
        name: 'greet',
        routeId: 'acme/limited-app/prod@1',
      },
    });
    expect(await gate({ ...context, subject: 'signed-in' })).toEqual({ allow: true });
    expect(await gate({ ...context, method: 'tools/list', category: 'discovery' })).toEqual({
      allow: true,
    });
    expect(await gate({ ...context, routeId: 'acme/another-app/prod@1' })).toEqual({ allow: true });
    now = 60 * 60 * 1000;
    expect(await gate(context)).toEqual({ allow: true });
  });

  it('rejects user-root manifests for public deploys but allows them for mixed', async () => {
    const publicRes = await deployRaw('user-public', 'public', USER_MANIFEST);
    expect(publicRes.status).toBe(400);
    expect(await publicRes.text()).toContain('public access mode cannot reference ${user}');

    const mixedRes = await deployRaw('user-mixed', 'mixed', USER_MANIFEST);
    expect(mixedRes.status).toBe(201);
  });
});

async function deploy(
  app: string,
  accessMode: string,
): Promise<{ url: string; accessMode: string }> {
  const res = await deployRaw(app, accessMode, HELLO);
  expect(res.status).toBe(201);
  return (await res.json()) as { url: string; accessMode: string };
}

function deployRaw(app: string, accessMode: string, manifest: string): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/${app}/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest, accessMode }),
  });
}

async function initialize(url: string, token?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
}

async function callTool(url: string, id: number): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `call-${id}`,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'Ada' } },
    }),
  });
}

async function updateAccess(
  app: string,
  accessMode: string,
): Promise<{ status: number; accessMode?: string }> {
  const res = await fetch(`${base}/v1/orgs/acme/apps/${app}/envs/prod/access`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessMode }),
  });
  const body = (await res.json()) as { deployment?: { accessMode?: string } };
  return {
    status: res.status,
    ...(body.deployment?.accessMode ? { accessMode: body.deployment.accessMode } : {}),
  };
}
