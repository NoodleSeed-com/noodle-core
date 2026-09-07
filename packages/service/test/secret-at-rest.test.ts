import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryConfigStore, InMemoryControlPlaneStore, serveService } from '../src/index.js';

const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'tok-do-not-leak-7777';

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const OWNER_TOKEN = 'OWNER';
const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${OWNER_TOKEN}` });

const MANIFEST = `
manifestVersion: "1"
server:
  name: httpbin
  version: 1.0.0
  title: Httpbin
connectors:
  httpbin:
    id: httpbin
    version: 1.0.0
tools:
  - name: whoami
    description: Echo the attached bearer token.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      use: httpbin.whoami
      args: {}
`;

function connectorsYaml(url: string): string {
  return `
connectors:
  - id: httpbin
    version: 1.0.0
    http:
      baseUrl: ${url}
      allowedOrigins: [ ${url} ]
      auth: { kind: bearer, secret: httpbin_token }
    operations:
      whoami:
        type: read
        method: GET
        path: /bearer
        output:
          type: object
          properties:
            authenticated: { type: boolean }
            token: { type: string }
          additionalProperties: false
        response:
          authenticated: \${response.authenticated}
          token: \${response.token}
`;
}

let backing: Server;
let backingUrl: string;
let dirs: string[] = [];

beforeEach(async () => {
  // Echo the bearer token (as httpbin.org/bearer does) so we can prove the decrypted secret reached it.
  backing = createServer((req, res) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!match) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ authenticated: true, token: match[1] }));
  });
  await new Promise<void>((resolve) => backing.listen(0, '127.0.0.1', resolve));
  backingUrl = `http://127.0.0.1:${(backing.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => backing.close((e) => (e ? reject(e) : resolve())));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function tmpDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-secret-'));
  dirs.push(dir);
  return dir;
}

async function serviceOptions(configStore?: InMemoryConfigStore) {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  return {
    controlPlaneStore: controlPlane,
    deployGate: {
      authorize: () =>
        Promise.resolve({
          ok: true as const,
          identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
        }),
    },
    verifyOwnerToken: (token: string) =>
      Promise.resolve(token === OWNER_TOKEN ? { caller: { subject: 'owner-sub' } } : null),
    authServerIssuer: 'https://as.noodle.test',
    ...(configStore !== undefined ? { configStore } : {}),
  };
}

function deploy(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/orgs/acme/apps/secret/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      manifest: MANIFEST,
      connectors: connectorsYaml(backingUrl),
    }),
  });
}
function initialize(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...authHeaders() },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
}
function callWhoami(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25', ...authHeaders() },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }),
  });
}

describe('secret-at-rest (Slice 26)', () => {
  it('persists deploy records without connector secret values', async () => {
    const dataDir = await tmpDataDir();
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'secret', env: 'prod' },
      name: 'httpbin_token',
      value: SECRET,
    });
    const svc = await serveService({
      port: 0,
      dataDir,
      secretMasterKey: MASTER_KEY,
      ...(await serviceOptions(configStore)),
    });
    let deploymentId = '';
    try {
      const dep = await (await deploy(svc.url)).json();
      expect(dep.ok).toBe(true);
      deploymentId = dep.deploymentId;
    } finally {
      await svc.close();
    }
    const raw = await readFile(join(dataDir, 'deployments', `${deploymentId}.json`), 'utf8');
    expect(raw).not.toContain(SECRET);
    const record = JSON.parse(raw);
    expect(record.secrets).toEqual({ enc: 'none', values: {} });
  });

  it('resolves managed config after restart and the secret reaches the backend', async () => {
    const dataDir = await tmpDataDir();
    const configStore = new InMemoryConfigStore();
    await configStore.setConfigValue({
      kind: 'secret',
      scope: { level: 'env', org: 'acme', app: 'secret', env: 'prod' },
      name: 'httpbin_token',
      value: SECRET,
    });
    const first = await serveService({
      port: 0,
      dataDir,
      secretMasterKey: MASTER_KEY,
      ...(await serviceOptions(configStore)),
    });
    try {
      await (await deploy(first.url)).json();
    } finally {
      await first.close();
    }

    const second = await serveService({
      port: 0,
      dataDir,
      secretMasterKey: MASTER_KEY,
      ...(await serviceOptions(configStore)),
    });
    try {
      const callUrl = `${second.url}/o/acme/secret/mcp`;
      await initialize(callUrl);
      const body = await (await callWhoami(callUrl)).json();
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent).toEqual({ authenticated: true, token: SECRET });
    } finally {
      await second.close();
    }
  });

  it('picks up managed secret updates without redeploy', async () => {
    const dataDir = await tmpDataDir();
    const configStore = new InMemoryConfigStore();
    const scope = { level: 'env' as const, org: 'acme', app: 'secret', env: 'prod' };
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'httpbin_token',
      value: SECRET,
    });
    const svc = await serveService({
      port: 0,
      dataDir,
      secretMasterKey: MASTER_KEY,
      ...(await serviceOptions(configStore)),
    });
    try {
      const dep = await (await deploy(svc.url)).json();
      await initialize(dep.url);
      await configStore.setConfigValue({
        kind: 'secret',
        scope,
        name: 'httpbin_token',
        value: 'rotated-token',
      });
      const body = await (await callWhoami(dep.url)).json();
      expect(body.result.structuredContent).toEqual({
        authenticated: true,
        token: 'rotated-token',
      });
    } finally {
      await svc.close();
    }
  });

  it('fails closed at boot: a data dir without a master key refuses to start', async () => {
    const dataDir = await tmpDataDir();
    await expect(serveService({ port: 0, dataDir })).rejects.toThrow(/master-key custodian/);
  });
});
