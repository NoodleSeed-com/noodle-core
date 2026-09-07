import { createServer, type Server } from 'node:http';
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

let http: Server;
let base: string;
let backing: Server;
let backingUrl: string;
let configStore: InMemoryConfigStore;

beforeEach(async () => {
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
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  // Echo the auth headers the request arrived with, so a deployed tool can surface what was attached.
  backing = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        authorization: req.headers.authorization ?? null,
        apiKey: req.headers['x-api-key'] ?? null,
      }),
    );
  });
  await new Promise<void>((resolve) => backing.listen(0, '127.0.0.1', resolve));
  backingUrl = `http://127.0.0.1:${(backing.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
  await new Promise<void>((resolve, reject) => backing.close((e) => (e ? reject(e) : resolve())));
});

async function deployWith(body: Record<string, unknown>): Promise<Response> {
  const { secrets, ...deployBody } = body;
  if (typeof secrets === 'object' && secrets !== null && !Array.isArray(secrets)) {
    for (const [name, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      await configStore.setConfigValue({
        kind: 'secret',
        scope: { level: 'env', org: 'acme', app: 'auth', env: 'prod' },
        name,
        value,
      });
    }
  }
  return fetch(`${base}/v1/orgs/acme/apps/auth/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deployBody),
  });
}

async function deployOk(body: Record<string, unknown>): Promise<{ url: string }> {
  const res = await deployWith(body);
  const json = await res.json();
  if (!json.ok) throw new Error(`deploy failed: ${JSON.stringify(json)}`);
  await fetch(json.url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  return { url: json.url as string };
}

async function call(url: string, name: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      'mcp-protocol-version': '2025-11-25',
      authorization: `Bearer ${OWNER_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  });
  return (await res.json()).result.structuredContent;
}

/** A single-tool manifest whose tool `t` calls `<alias>.echo` with no args. */
function manifest(serverName: string, alias: string): string {
  return `
manifestVersion: "1"
server: { name: ${serverName}, version: 1.0.0, title: T }
connectors:
  ${alias}: { id: ${alias}, version: 1.0.0 }
tools:
  - name: t
    description: echo.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { use: ${alias}.echo, args: {} }
`;
}

/** A connector `alias` with one `echo` op (GET) carrying the given auth block + response mapping. */
function connector(alias: string, authBlock: string, responseField: string): string {
  return `
connectors:
  - id: ${alias}
    version: 1.0.0
    http:
      baseUrl: ${backingUrl}
      allowedOrigins: [ ${backingUrl} ]
      auth: ${authBlock}
    operations:
      echo:
        type: read
        method: GET
        path: /echo
        output: { type: object, properties: { ${responseField}: { type: string } }, additionalProperties: false }
        response: { ${responseField}: "\${response.${responseField}}" }
`;
}

describe('deploy service — secret/auth scenarios', () => {
  it('attaches an apiKey header end to end', async () => {
    const { url } = await deployOk({
      manifest: manifest('apikey', 'svc'),
      connectors: connector('svc', '{ kind: apiKey, header: X-API-Key, secret: k }', 'apiKey'),
      secrets: { k: 'key-123' },
    });
    expect(await call(url, 't')).toEqual({ apiKey: 'key-123' });
  });

  it('resolves a connector-default bearer and a per-op apiKey override in one deploy', async () => {
    const connectors = `
connectors:
  - id: svc
    version: 1.0.0
    http:
      baseUrl: ${backingUrl}
      allowedOrigins: [ ${backingUrl} ]
      auth: { kind: bearer, secret: default_token }
    operations:
      via_default:
        type: read
        method: GET
        path: /echo
        output: { type: object, properties: { authorization: { type: string } }, additionalProperties: false }
        response: { authorization: "\${response.authorization}" }
      via_override:
        type: read
        method: GET
        path: /echo
        auth: { kind: apiKey, header: X-API-Key, secret: special_key }
        output: { type: object, properties: { apiKey: { type: string } }, additionalProperties: false }
        response: { apiKey: "\${response.apiKey}" }
`;
    const mani = `
manifestVersion: "1"
server: { name: mixed, version: 1.0.0, title: T }
connectors:
  svc: { id: svc, version: 1.0.0 }
tools:
  - name: t_default
    description: d.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { use: svc.via_default, args: {} }
  - name: t_override
    description: o.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { use: svc.via_override, args: {} }
`;
    const { url } = await deployOk({
      manifest: mani,
      connectors,
      secrets: { default_token: 'A', special_key: 'B' },
    });
    expect(await call(url, 't_default')).toEqual({ authorization: 'Bearer A' });
    expect(await call(url, 't_override')).toEqual({ apiKey: 'B' });
  });

  it('fails closed naming the per-op secret when only the connector default is supplied', async () => {
    const connectors = `
connectors:
  - id: svc
    version: 1.0.0
    http:
      baseUrl: ${backingUrl}
      allowedOrigins: [ ${backingUrl} ]
      auth: { kind: bearer, secret: default_token }
    operations:
      echo:
        type: read
        method: GET
        path: /echo
        auth: { kind: apiKey, header: X-API-Key, secret: special_key }
        output: { type: object, properties: { apiKey: { type: string } }, additionalProperties: false }
        response: { apiKey: "\${response.apiKey}" }
`;
    const res = await deployWith({
      manifest: manifest('failclosed', 'svc'),
      connectors,
      secrets: { default_token: 'A' }, // special_key missing
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].code).toBe('missing_secret');
    expect(body.errors[0].path).toBe('secrets.special_key');
  });

  it('succeeds and ignores extra/unused secrets', async () => {
    const { url } = await deployOk({
      manifest: manifest('extra', 'svc'),
      connectors: connector('svc', '{ kind: bearer, secret: k }', 'authorization'),
      secrets: { k: 'tok', unused: 'whatever', another_unused: 'x' },
    });
    expect(await call(url, 't')).toEqual({ authorization: 'Bearer tok' });
  });

  it('lets two connectors share one secret reference', async () => {
    const connectors = `
connectors:
  - id: a
    version: 1.0.0
    http: { baseUrl: ${backingUrl}, allowedOrigins: [ ${backingUrl} ], auth: { kind: bearer, secret: shared } }
    operations:
      echo: { type: read, method: GET, path: /echo, output: { type: object, properties: { authorization: { type: string } }, additionalProperties: false }, response: { authorization: "\${response.authorization}" } }
  - id: b
    version: 1.0.0
    http: { baseUrl: ${backingUrl}, allowedOrigins: [ ${backingUrl} ], auth: { kind: bearer, secret: shared } }
    operations:
      echo: { type: read, method: GET, path: /echo, output: { type: object, properties: { authorization: { type: string } }, additionalProperties: false }, response: { authorization: "\${response.authorization}" } }
`;
    const mani = `
manifestVersion: "1"
server: { name: shared, version: 1.0.0, title: T }
connectors:
  a: { id: a, version: 1.0.0 }
  b: { id: b, version: 1.0.0 }
tools:
  - name: ta
    description: a.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { use: a.echo, args: {} }
  - name: tb
    description: b.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { use: b.echo, args: {} }
`;
    const { url } = await deployOk({ manifest: mani, connectors, secrets: { shared: 'S' } });
    expect(await call(url, 'ta')).toEqual({ authorization: 'Bearer S' });
    expect(await call(url, 'tb')).toEqual({ authorization: 'Bearer S' });
  });

  it('carries a realistic API-key value verbatim into the header', async () => {
    const value = 'sk-Test_123.ABC-xyz=';
    const { url } = await deployOk({
      manifest: manifest('special', 'svc'),
      connectors: connector('svc', '{ kind: bearer, secret: k }', 'authorization'),
      secrets: { k: value },
    });
    expect(await call(url, 't')).toEqual({ authorization: `Bearer ${value}` });
  });

  it('rejects malformed secrets (array, number, nested-object value)', async () => {
    const conn = connector('svc', '{ kind: bearer, secret: k }', 'authorization');
    for (const secrets of [[], 123, { k: { nested: 'x' } }, { k: 123 }]) {
      const res = await deployWith({ manifest: manifest('m', 'svc'), connectors: conn, secrets });
      expect(res.status).toBe(400);
    }
  });

  it('never echoes a secret value in the deploy response body', async () => {
    const secret = 'super-secret-zzz';
    const res = await deployWith({
      manifest: manifest('noleak', 'svc'),
      connectors: connector('svc', '{ kind: bearer, secret: k }', 'authorization'),
      secrets: { k: secret },
    });
    const text = await res.text();
    expect(res.status).toBe(201);
    expect(text).not.toContain(secret);
  });
});
