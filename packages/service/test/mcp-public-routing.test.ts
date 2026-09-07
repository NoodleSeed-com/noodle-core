import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
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
      properties:
        name:
          type: string
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

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_SUBJECT = 'google-owner-sub';
const ISSUER = 'https://as.noodle.test';

const googleVerifier: GoogleIdTokenVerifier = {
  verify: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
};

const verifyOwnerToken = (token: string): Promise<{ caller: { subject: string } } | null> =>
  Promise.resolve(token === 'OWNER' ? { caller: { subject: OWNER_SUBJECT } } : null);

let http: Server;
let base: string;
let logs: unknown[];
let currentNow: Date;
let controlPlane: InMemoryControlPlaneStore;

beforeEach(async () => {
  logs = [];
  currentNow = new Date('2026-08-11T00:00:00.000Z');
  controlPlane = new InMemoryControlPlaneStore({ now: () => currentNow });
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' },
  });
  await controlPlane.changeMcpSubdomain({
    org: 'acme',
    mcpSubdomain: 'arez',
    idempotencyKey: 'routing-setup-key',
    actor: { subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' },
  });
  const gate = new GoogleControlPlaneGate({
    audience: 'test-client-id',
    admins: [],
    verifier: googleVerifier,
  });
  http = createServer(
    createServiceHandler(new ServerRegistry(), {
      deployGate: gate,
      controlPlaneStore: controlPlane,
      clock: () => currentNow,
      verifyOwnerToken,
      authServerIssuer: ISSUER,
      logger: {
        debug: () => undefined,
        info: (message, fields) => logs.push({ message, fields }),
        warn: (message, fields) => logs.push({ message, fields }),
        error: (message, fields) => logs.push({ message, fields }),
      },
      publicBaseUrl: 'https://cloud.noodleseed.dev',
      mcpPublicRouting: {
        publicBaseDomain: 'cloud.noodleseed.dev',
        edgeToken: 'edge-secret',
      },
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function deployPrivate(): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/priv/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer google-id-token' },
    body: JSON.stringify({ manifest: HELLO, accessMode: 'owner-only', serverVersion: '1' }),
  });
}

const INIT = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
};

describe('public MCP-subdomain routing', () => {
  it('returns public subdomain URLs from deploy responses', async () => {
    const res = await deployPrivate();
    expect(res.status, JSON.stringify(logs)).toBe(201);
    const json = await res.json();
    expect(json.url).toBe('https://arez.cloud.noodleseed.dev/priv/v1/mcp');
    expect(json.defaultUrl).toBe('https://arez.cloud.noodleseed.dev/priv/mcp');
  });

  it('uses the active claim across status and resource-read endpoint projections', async () => {
    const deployed = await deployPrivate();
    expect(deployed.status, JSON.stringify(logs)).toBe(201);
    const deployment = await deployed.json();
    const expected = 'https://arez.cloud.noodleseed.dev/priv/v1/mcp';
    const headers = { authorization: 'Bearer google-id-token' };

    const status = await fetch(`${base}/v1/orgs/acme/apps/priv/envs/prod/status`, { headers });
    expect(status.status).toBe(200);
    expect((await status.json()).deployment.endpointUrl).toBe(expected);

    const apps = await fetch(`${base}/v1/orgs/acme/apps`, { headers });
    expect(apps.status).toBe(200);
    expect((await apps.json()).data.apps[0].latest.endpointUrl).toBe(expected);

    const envs = await fetch(`${base}/v1/orgs/acme/apps/priv/envs`, { headers });
    expect(envs.status).toBe(200);
    expect((await envs.json()).data.envs[0].latest.endpointUrl).toBe(expected);

    const deployments = await fetch(`${base}/v1/orgs/acme/deployments`, { headers });
    expect(deployments.status).toBe(200);
    expect((await deployments.json()).deployments[0].endpointUrl).toBe(expected);

    const item = await fetch(`${base}/v1/orgs/acme/deployments/${deployment.deploymentId}`, {
      headers,
    });
    expect(item.status).toBe(200);
    expect((await item.json()).data.endpointUrl).toBe(expected);
  });

  it('reads the active claim again for every generated public URL', async () => {
    expect((await deployPrivate()).status, JSON.stringify(logs)).toBe(201);
    currentNow = new Date('2026-09-10T00:00:00.000Z');
    expect((await changeSubdomain('arez-renamed', 'routing-rename-key')).status).toBe(200);
    const status = await fetch(`${base}/v1/orgs/acme/apps/priv/envs/prod/status`, {
      headers: { authorization: 'Bearer google-id-token' },
    });
    expect(status.status).toBe(200);
    expect((await status.json()).deployment.endpointUrl).toBe(
      'https://arez-renamed.cloud.noodleseed.dev/priv/v1/mcp',
    );
  });

  it('retires the old MCP and metadata hosts while preserving the legacy org path', async () => {
    expect((await deployPrivate()).status, JSON.stringify(logs)).toBe(201);
    currentNow = new Date('2026-09-10T00:00:00.000Z');
    const changed = await changeSubdomain('arez-renamed', 'routing-cutover-key');
    expect(changed.status).toBe(200);

    const oldResource = 'https://arez.cloud.noodleseed.dev/priv/v1/mcp';
    const newResource = 'https://arez-renamed.cloud.noodleseed.dev/priv/v1/mcp';
    expect((await mcpOnHost(oldResource)).status).toBe(404);
    expect((await mcpOnHost(newResource)).status).toBe(200);
    expect((await metadataOnHost(oldResource)).status).toBe(404);
    const newMetadata = await metadataOnHost(newResource);
    expect(newMetadata.status).toBe(200);
    expect((await newMetadata.json()).resource).toBe(newResource);

    const legacy = await fetch(`${base}/o/acme/priv/v1/mcp`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        authorization: 'Bearer OWNER',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify(INIT),
    });
    expect(legacy.status).toBe(200);
  });

  it('serves protected-resource metadata for trusted subdomain resources', async () => {
    expect((await deployPrivate()).status, JSON.stringify(logs)).toBe(201);
    const resource = 'https://arez.cloud.noodleseed.dev/priv/v1/mcp';
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/priv/v1/mcp`, {
      headers: {
        'x-app-host': resource,
        'x-noodle-edge-token': 'edge-secret',
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.resource).toBe(resource);
    expect(json.authorization_servers).toEqual([ISSUER]);
  });

  it('routes trusted subdomain MCP calls and rejects bad edge tokens', async () => {
    expect((await deployPrivate()).status, JSON.stringify(logs)).toBe(201);
    const resource = 'https://arez.cloud.noodleseed.dev/priv/v1/mcp';
    const ok = await fetch(`${base}/priv/v1/mcp`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        authorization: 'Bearer OWNER',
        'mcp-protocol-version': '2025-11-25',
        'x-app-host': resource,
        'x-noodle-edge-token': 'edge-secret',
      },
      body: JSON.stringify(INIT),
    });
    expect(ok.status, JSON.stringify(logs)).toBe(200);

    const forbidden = await fetch(`${base}/priv/v1/mcp`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        authorization: 'Bearer OWNER',
        'mcp-protocol-version': '2025-11-25',
        'x-app-host': resource,
        'x-noodle-edge-token': 'wrong',
      },
      body: JSON.stringify(INIT),
    });
    expect(forbidden.status).toBe(403);
  });

  it('does not route the immutable org slug after its MCP subdomain differs', async () => {
    expect((await deployPrivate()).status, JSON.stringify(logs)).toBe(201);
    const res = await fetch(`${base}/priv/v1/mcp`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        authorization: 'Bearer OWNER',
        'mcp-protocol-version': '2025-11-25',
        'x-app-host': 'https://acme.cloud.noodleseed.dev/priv/v1/mcp',
        'x-noodle-edge-token': 'edge-secret',
      },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for the reserved local label across MCP and protected metadata', async () => {
    const resource = 'https://local.cloud.noodleseed.dev/priv/v1/mcp';
    const headers = {
      'x-app-host': resource,
      'x-noodle-edge-token': 'edge-secret',
    };
    const mcp = await fetch(`${base}/priv/v1/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(INIT),
    });
    expect(mcp.status).toBe(404);

    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/priv/v1/mcp`, {
      headers,
    });
    expect(metadata.status).toBe(404);
  });
});

function changeSubdomain(mcpSubdomain: string, idempotencyKey: string): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/mcp-subdomain`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer google-id-token',
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ mcpSubdomain, acknowledgeOldUrlsStopWorking: true }),
  });
}

function mcpOnHost(resource: string): Promise<Response> {
  return fetch(`${base}/priv/v1/mcp`, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      authorization: 'Bearer OWNER',
      'mcp-protocol-version': '2025-11-25',
      'x-app-host': resource,
      'x-noodle-edge-token': 'edge-secret',
    },
    body: JSON.stringify(INIT),
  });
}

function metadataOnHost(resource: string): Promise<Response> {
  return fetch(`${base}/.well-known/oauth-protected-resource/priv/v1/mcp`, {
    headers: { 'x-app-host': resource, 'x-noodle-edge-token': 'edge-secret' },
  });
}
