import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryConfigStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_TOKEN = 'OWNER';

const MANIFEST = `
manifestVersion: "1"
server:
  name: oauth2_demo
  version: 1.0.0
  title: OAuth2 Demo
connectors:
  api:
    id: oauth_api
    version: 1.0.0
tools:
  - name: fetch_item
    description: Fetch the protected item.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      use: api.fetch_item
      args: {}
`;

let backing: Server;
let backingBase: string;
let http: Server;
let base: string;
let configStore: InMemoryConfigStore;
let tokenRequests: Array<{ auth?: string; body: string }> = [];
let apiAuths: string[] = [];

beforeEach(async () => {
  tokenRequests = [];
  apiAuths = [];
  backing = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/token') {
      const body = await readBody(req);
      tokenRequests.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: `access-${tokenRequests.length}`,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      return;
    }
    // Non-standard, HeyMate-shaped token endpoint: JSON body { clientID, clientSecret } -> { accessToken }.
    if (req.method === 'POST' && req.url === '/v1/ext/auth/token') {
      const body = await readBody(req);
      tokenRequests.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accessToken: `custom-${tokenRequests.length}`, expiresIn: 3600 }));
      return;
    }
    if (req.method === 'GET' && req.url === '/item') {
      apiAuths.push(req.headers.authorization ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ seen: req.headers.authorization ?? '' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => backing.listen(0, '127.0.0.1', resolve));
  backingBase = `http://127.0.0.1:${(backing.address() as AddressInfo).port}`;

  configStore = new InMemoryConfigStore();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  http = createServer(
    createServiceHandler(new ServerRegistry(undefined, undefined, configStore), {
      configStore,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@example.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(
          token === OWNER_TOKEN
            ? { caller: { subject: 'owner-sub', email: 'owner@example.com' } }
            : null,
        ),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    backing.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('OAuth2 client-credentials connector auth (B10)', () => {
  it('exchanges managed client secrets with client_secret_basic and caches access tokens', async () => {
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'oauth2', env: 'prod' },
      name: 'API_CLIENT_SECRET',
      value: 'client-secret',
    });
    const dep = await deploy(connectors({ authMethod: 'client_secret_basic' }));
    expect(dep.ok).toBe(true);

    await initialize(dep.url);
    const first = await call(dep.url);
    const second = await call(dep.url);
    expect(first).toEqual({ seen: 'Bearer access-1' });
    expect(second).toEqual({ seen: 'Bearer access-1' });
    expect(apiAuths).toEqual(['Bearer access-1', 'Bearer access-1']);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.auth).toBe(
      `Basic ${Buffer.from('client-a:client-secret').toString('base64')}`,
    );
    expect(new URLSearchParams(tokenRequests[0]?.body).get('grant_type')).toBe(
      'client_credentials',
    );
    expect(new URLSearchParams(tokenRequests[0]?.body).get('scope')).toBe('read write');
    expect(new URLSearchParams(tokenRequests[0]?.body).get('audience')).toBe(
      'https://api.example.com',
    );
  });

  it('supports client_secret_post', async () => {
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'oauth2', env: 'prod' },
      name: 'API_CLIENT_SECRET',
      value: 'client-secret',
    });
    const dep = await deploy(connectors({ authMethod: 'client_secret_post' }));
    expect(dep.ok).toBe(true);

    await initialize(dep.url);
    expect(await call(dep.url)).toEqual({ seen: 'Bearer access-1' });
    expect(tokenRequests[0]?.auth).toBeUndefined();
    const params = new URLSearchParams(tokenRequests[0]?.body);
    expect(params.get('client_id')).toBe('client-a');
    expect(params.get('client_secret')).toBe('client-secret');
  });

  it('exchanges a non-standard token endpoint via the custom profile and caches the token', async () => {
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'oauth2', env: 'prod' },
      name: 'API_CLIENT_SECRET',
      value: 'client-secret',
    });
    const dep = await deploy(connectorsCustom());
    expect(dep.ok).toBe(true);

    await initialize(dep.url);
    const first = await call(dep.url);
    const second = await call(dep.url);
    // Broker fetched a fresh token, injected it as a bearer header, and reused it (cached until expiry).
    expect(first).toEqual({ seen: 'Bearer custom-1' });
    expect(second).toEqual({ seen: 'Bearer custom-1' });
    expect(apiAuths).toEqual(['Bearer custom-1', 'Bearer custom-1']);
    expect(tokenRequests).toHaveLength(1);
    // Credentials were sent as a JSON body under the declared custom field names, not the RFC form grant.
    expect(tokenRequests[0]?.auth).toBeUndefined();
    expect(JSON.parse(tokenRequests[0]?.body ?? '{}')).toEqual({
      clientID: 'client-a',
      clientSecret: 'client-secret',
    });
  });

  it('fails deploy closed when the OAuth client secret is missing', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/oauth2/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: MANIFEST,
        connectors: connectors({ authMethod: 'client_secret_basic' }),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({ code: 'missing_secret', path: 'secrets.API_CLIENT_SECRET' }),
      ],
    });
    expect(tokenRequests).toHaveLength(0);
  });
});

async function deploy(connectorsYaml: string): Promise<{ ok: boolean; url: string }> {
  const res = await fetch(`${base}/v1/orgs/acme/apps/oauth2/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: MANIFEST, connectors: connectorsYaml }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { ok: boolean; url: string };
}

async function call(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      'mcp-protocol-version': '2025-11-25',
      authorization: `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `call-${Math.random()}`,
      method: 'tools/call',
      params: { name: 'fetch_item', arguments: {} },
    }),
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(body.result.isError).toBe(false);
  return body.result.structuredContent;
}

async function initialize(url: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
  expect(res.status).toBe(200);
}

function connectors(input: { authMethod: 'client_secret_basic' | 'client_secret_post' }): string {
  return `
connectors:
  - id: oauth_api
    version: 1.0.0
    http:
      baseUrl: ${backingBase}
      allowedOrigins:
        - ${backingBase}
      auth:
        kind: clientCredentials
        tokenUrl: ${backingBase}/oauth/token
        clientId: client-a
        clientSecret: API_CLIENT_SECRET
        scopes: [read, write]
        audience: https://api.example.com
        authMethod: ${input.authMethod}
    operations:
      fetch_item:
        type: read
        method: GET
        path: /item
        output:
          type: object
          properties:
            seen: { type: string }
          additionalProperties: false
        response:
          seen: \${response.seen}
`;
}

function connectorsCustom(): string {
  return `
connectors:
  - id: oauth_api
    version: 1.0.0
    http:
      baseUrl: ${backingBase}
      allowedOrigins:
        - ${backingBase}
      auth:
        kind: clientCredentials
        profile: custom
        tokenUrl: ${backingBase}/v1/ext/auth/token
        clientId: client-a
        clientSecret: API_CLIENT_SECRET
        custom:
          requestFormat: json
          clientIdField: clientID
          clientSecretField: clientSecret
          tokenResponsePath: accessToken
          expirySource: [jwt, expiresIn, expiresAt]
    operations:
      fetch_item:
        type: read
        method: GET
        path: /item
        output:
          type: object
          properties:
            seen: { type: string }
          additionalProperties: false
        response:
          seen: \${response.seen}
`;
}

function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk as Buffer));
  return new Promise((resolve) =>
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))),
  );
}
