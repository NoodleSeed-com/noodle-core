import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import { SERVED_MCP_PROTOCOL_VERSIONS, type ServedArtifact } from '@noodle-borg/protocol';
import {
  type Connector,
  type ConnectorCall,
  type ExecuteDeps,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as transport from '../src/index.js';
import { createMcpRouter, type ServedTarget } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(
  here,
  '..',
  '..',
  'compiler',
  'fixtures',
  'valid',
  'minimal.resolved.artifact.json',
);

const getOrderSig: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { order: { type: 'object' } },
    additionalProperties: false,
  },
};

function deps(): ExecuteDeps {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: { signature: getOrderSig, handler: (args) => ({ order: { id: args.id } }) },
  });
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'svc' }),
  };
}

function target(): ServedArtifact {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  return { artifact, deps: deps() };
}

function targetWithConnector(connector: Connector): ServedArtifact {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  return {
    artifact,
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    },
  };
}

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
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

let http: Server;
let base: string;
const registry = new Map<string, ServedTarget>();

beforeEach(async () => {
  registry.clear();
  registry.set('alpha', { served: target() });
  registry.set('beta', { served: target() });
  // The resolver is async (ADR 0036); this in-memory map resolves synchronously, wrapped in a Promise.
  http = createServer(createMcpRouter((id) => Promise.resolve(registry.get(id))));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function initialize(serverId: string): Promise<Response> {
  return fetch(`${base}/${serverId}/mcp`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(INIT),
  });
}

describe('createMcpRouter (multi-tenant /{serverId}/mcp)', () => {
  it('routes to the addressed server', async () => {
    const res = await initialize('alpha');
    expect(res.status).toBe(200);
    expect((await res.json()).result.protocolVersion).toBe('2025-11-25');
  });

  it('serves each registered server independently', async () => {
    expect((await initialize('alpha')).status).toBe(200);
    expect((await initialize('beta')).status).toBe(200);
  });

  it('serves one origin-wide modern version set for sibling apps', async () => {
    const discover = (serverId: string) =>
      fetch(`${base}/${serverId}/mcp`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'server/discover',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'origin-cache-test', version: '1' },
            },
          },
        }),
      });
    const [alpha, beta] = await Promise.all([discover('alpha'), discover('beta')]);
    const alphaBody = await alpha.json();
    const betaBody = await beta.json();
    expect(alphaBody.result.supportedVersions).toEqual([...SERVED_MCP_PROTOCOL_VERSIONS]);
    expect(betaBody.result.supportedVersions).toEqual(alphaBody.result.supportedVersions);
  });

  it('returns 404 for an unknown server id', async () => {
    const res = await initialize('ghost');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed percent-encoded server id', async () => {
    const res = await fetch(`${base}/bad%ZZ/mcp`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a path that is not /{id}/mcp', async () => {
    const res = await fetch(`${base}/alpha`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(404);
  });

  it('reuses the request pipeline: GET -> 405', async () => {
    const res = await fetch(`${base}/alpha/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
  });

  it('runs a real tools/call on the addressed server', async () => {
    const res = await fetch(`${base}/beta/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_order', arguments: { order_id: 'A1' } },
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result.isError).toBe(false);
  });
});

describe('createMcpRouter — versioned tenant paths', () => {
  it('routes prod version paths as exact server versions', async () => {
    const seen: unknown[] = [];
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        tenantLookup: async (ref) => {
          seen.push(ref);
          return { served: target() };
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/o/acme/app/v2_0_6/mcp`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(200);
      expect(seen).toEqual([{ org: 'acme', app: 'app', env: 'prod', serverVersion: '2.0.6' }]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('routes env version paths without confusing prod /v1 with an env slug', async () => {
    const seen: unknown[] = [];
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        tenantLookup: async (ref) => {
          seen.push(ref);
          return { served: target() };
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${port}/o/acme/app/v1/mcp`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(INIT),
      });
      await fetch(`http://127.0.0.1:${port}/o/acme/app/staging/v1/mcp`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(INIT),
      });
      await fetch(`http://127.0.0.1:${port}/o/acme/app/dev/mcp`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(INIT),
      });
      const invalidVersion = await fetch(`http://127.0.0.1:${port}/o/acme/app/vteam/mcp`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(INIT),
      });
      expect(invalidVersion.status).toBe(404);
      expect(seen).toEqual([
        { org: 'acme', app: 'app', env: 'prod', serverVersion: '1' },
        { org: 'acme', app: 'app', env: 'staging', serverVersion: '1' },
        { org: 'acme', app: 'app', env: 'dev' },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('passes the versioned MCP URL as the token resource', async () => {
    const resources: string[] = [];
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        tenantLookup: async () => ({
          served: target(),
          accessMode: 'owner-only',
          ownerSubject: 'owner-sub',
        }),
        verifyOwnerToken: async (token, resource) => {
          resources.push(resource);
          return token === 'tok-v1' && resource.endsWith('/o/acme/app/v1/mcp')
            ? { caller: { subject: 'owner-sub' } }
            : null;
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const v1 = `http://127.0.0.1:${port}/o/acme/app/v1/mcp`;
      const v2 = `http://127.0.0.1:${port}/o/acme/app/v2_0_0/mcp`;
      expect(
        (
          await fetch(v1, {
            method: 'POST',
            headers: { ...JSON_HEADERS, authorization: 'Bearer tok-v1' },
            body: JSON.stringify(INIT),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(v2, {
            method: 'POST',
            headers: { ...JSON_HEADERS, authorization: 'Bearer tok-v1' },
            body: JSON.stringify(INIT),
          })
        ).status,
      ).toBe(401);
      expect(resources).toEqual([v1, v2]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});

describe('createMcpRouter — trusted MCP-subdomain edge routing', () => {
  it('routes by X-App-Host when the edge token matches', async () => {
    const seen: unknown[] = [];
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        publicTenantRouting: {
          allowedBaseDomains: ['cloud.noodleseed.dev'],
          edgeToken: 'edge-secret',
          resolveTenant: async (ref) => ({
            org: 'arez-internal',
            app: ref.app,
            env: ref.env,
            ...(ref.serverVersion !== undefined ? { serverVersion: ref.serverVersion } : {}),
          }),
        },
        tenantLookup: async (ref) => {
          seen.push(ref);
          return { served: target() };
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/todoist/v1/mcp`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'x-app-host': 'https://arez.cloud.noodleseed.dev/todoist/v1/mcp',
          'x-noodle-edge-token': 'edge-secret',
        },
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(200);
      expect(seen).toEqual([
        { org: 'arez-internal', app: 'todoist', env: 'prod', serverVersion: '1' },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('fails closed when X-App-Host is present without the matching edge token', async () => {
    const seen: unknown[] = [];
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        publicTenantRouting: {
          allowedBaseDomains: ['cloud.noodleseed.dev'],
          edgeToken: 'edge-secret',
          resolveTenant: async () => {
            throw new Error('claim resolution must not run before edge authentication');
          },
        },
        tenantLookup: async (ref) => {
          seen.push(ref);
          return { served: target() };
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/todoist/v1/mcp`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'x-app-host': 'https://saad-apps.cloud.noodleseed.dev/todoist/v1/mcp',
          'x-noodle-edge-token': 'wrong',
        },
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(403);
      expect(seen).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('uses the public subdomain MCP URL for OAuth resource binding and challenges', async () => {
    const resources: string[] = [];
    const resource = 'https://saad-apps.cloud.noodleseed.dev/todoist/v1/mcp';
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        publicTenantRouting: {
          allowedBaseDomains: ['cloud.noodleseed.dev'],
          edgeToken: 'edge-secret',
          resolveTenant: async (ref) => ({
            org: 'arez-internal',
            app: ref.app,
            env: ref.env,
            ...(ref.serverVersion !== undefined ? { serverVersion: ref.serverVersion } : {}),
          }),
        },
        tenantLookup: async () => ({
          served: target(),
          accessMode: 'owner-only',
          ownerSubject: 'owner-sub',
        }),
        verifyOwnerToken: async (token, checkedResource) => {
          resources.push(checkedResource);
          return token === 'tok-v1' && checkedResource === resource
            ? { caller: { subject: 'owner-sub' } }
            : null;
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const headers = {
      ...JSON_HEADERS,
      'x-app-host': resource,
      'x-noodle-edge-token': 'edge-secret',
    };
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/todoist/v1/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(INIT),
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://saad-apps.cloud.noodleseed.dev/.well-known/oauth-protected-resource/todoist/v1/mcp"',
      );
      const authorized = await fetch(`http://127.0.0.1:${port}/todoist/v1/mcp`, {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer tok-v1' },
        body: JSON.stringify(INIT),
      });
      expect(authorized.status).toBe(200);
      expect(resources).toEqual([resource]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('returns a generic 404 before tenant lookup for an unknown or retired subdomain', async () => {
    let tenantLookups = 0;
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        publicTenantRouting: {
          allowedBaseDomains: ['cloud.noodleseed.dev'],
          edgeToken: 'edge-secret',
          resolveTenant: async () => undefined,
        },
        tenantLookup: async () => {
          tenantLookups += 1;
          return { served: target() };
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/todoist/v1/mcp`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'x-app-host': 'https://retired.cloud.noodleseed.dev/todoist/v1/mcp',
          'x-noodle-edge-token': 'edge-secret',
        },
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { message: 'not found' } });
      expect(tenantLookups).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('rejects the reserved local label before claim resolution', async () => {
    let claimLookups = 0;
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        publicTenantRouting: {
          allowedBaseDomains: ['cloud.noodleseed.dev'],
          edgeToken: 'edge-secret',
          resolveTenant: async () => {
            claimLookups += 1;
            return undefined;
          },
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/todoist/v1/mcp`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'x-app-host': 'https://local.cloud.noodleseed.dev/todoist/v1/mcp',
          'x-noodle-edge-token': 'edge-secret',
        },
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(404);
      expect(claimLookups).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });

  it('resolves the claim on every request instead of caching a subdomain mapping', async () => {
    let claimLookups = 0;
    const seen: unknown[] = [];
    const server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        publicTenantRouting: {
          allowedBaseDomains: ['cloud.noodleseed.dev'],
          edgeToken: 'edge-secret',
          resolveTenant: async (ref) => {
            claimLookups += 1;
            if (claimLookups === 2) return undefined;
            return { org: 'arez-internal', app: ref.app, env: ref.env };
          },
        },
        tenantLookup: async (ref) => {
          seen.push(ref);
          return { served: target() };
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const request = () =>
      fetch(`http://127.0.0.1:${port}/todoist/mcp`, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          'x-app-host': 'https://arez.cloud.noodleseed.dev/todoist/mcp',
          'x-noodle-edge-token': 'edge-secret',
        },
        body: JSON.stringify(INIT),
      });
    try {
      expect((await request()).status).toBe(200);
      expect((await request()).status).toBe(404);
      expect(claimLookups).toBe(2);
      expect(seen).toEqual([{ org: 'arez-internal', app: 'todoist', env: 'prod' }]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});

describe('createMcpRouter — identity-only access surface', () => {
  it('does not export caller-key helpers', () => {
    expect('mintCallerKey' in transport).toBe(false);
    expect('hashCallerKey' in transport).toBe(false);
    expect('verifyCallerKey' in transport).toBe(false);
  });

  it('leaves loopback/dev targets open when no identity mode is configured', async () => {
    expect((await initialize('alpha')).status).toBe(200);
  });
});

describe('createMcpRouter — customer identity boundary', () => {
  it('does not fall back to the platform verifier when a customers target has no verifier', async () => {
    let platformVerifierCalls = 0;

    const response = await requestWithIdentityTarget(
      {
        served: target(),
        accessMode: 'customers',
      },
      'platform-token',
      async () => {
        platformVerifierCalls++;
        return { caller: { subject: 'platform-sub', identityKind: 'platform' } };
      },
    );

    expect(response.status).toBe(401);
    expect(platformVerifierCalls).toBe(0);
  });

  it('rejects a platform-classified identity returned by a miswired customer verifier', async () => {
    const response = await requestWithIdentityTarget(
      {
        served: target(),
        accessMode: 'customers',
        authentication: {
          kind: 'customer',
          verifyToken: async () => ({
            caller: { subject: 'platform-sub', identityKind: 'platform' },
          }),
        },
      },
      'platform-token',
    );

    expect(response.status).toBe(401);
  });

  it('admits a customer-classified identity returned by the target verifier', async () => {
    const response = await requestWithIdentityTarget(
      {
        served: target(),
        accessMode: 'customers',
        authentication: {
          kind: 'customer',
          verifyToken: async () => ({
            caller: { subject: 'customer-sub', identityKind: 'customer' },
          }),
        },
      },
      'customer-token',
    );

    expect(response.status).toBe(200);
  });

  it('preserves the global platform verifier for authenticated access', async () => {
    const response = await requestWithIdentityTarget(
      {
        served: target(),
        accessMode: 'authenticated',
      },
      'platform-token',
      async () => ({ caller: { subject: 'platform-sub', identityKind: 'platform' } }),
    );

    expect(response.status).toBe(200);
  });
});

describe('createMcpRouter — async resolver failure → 500 (ADR 0036)', () => {
  it('returns a generic 500 when the resolver rejects, leaking no part of the thrown error', async () => {
    // The lazy resolver may throw (store/compile/decrypt failure). Its message can carry sensitive detail;
    // the front-door must surface a generic transport error and never echo it (no-leak invariant).
    const SECRET_IN_ERROR = 'do-not-leak-resolver-secret-name';
    const server = createServer(
      createMcpRouter(() => Promise.reject(new Error(`recompile failed: ${SECRET_IN_ERROR}`))),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/whatever/mcp`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(INIT),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(SECRET_IN_ERROR); // the thrown message never reaches the wire
      expect(JSON.parse(text).error.message).toBe('internal error'); // generic transport-level error
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});

async function requestWithIdentityTarget(
  servedTarget: ServedTarget,
  token: string,
  verifyOwnerToken?: NonNullable<Parameters<typeof createMcpRouter>[1]>['verifyOwnerToken'],
): Promise<Response> {
  const server = createServer(
    createMcpRouter(() => Promise.resolve(servedTarget), {
      ...(verifyOwnerToken !== undefined ? { verifyOwnerToken } : {}),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/customer/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify(INIT),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('createMcpRouter — owner-only end-user auth (OA-1)', () => {
  const OWNER = 'owner-subject-1';
  const ownerCalls: ConnectorCall[] = [];
  const ownerConnector: Connector = {
    id: 'acme_orders',
    version: '1.2.0',
    signature: () => getOrderSig,
    invoke: async (call) => {
      ownerCalls.push(call);
      return { order: { id: call.args.id } };
    },
  };
  // Stub verifier: maps opaque test tokens to a verified subject; anything else is an invalid token.
  const verifyOwnerToken = (
    token: string,
  ): Promise<{
    caller: { subject: string; locale?: string; timeZone?: string };
  } | null> =>
    Promise.resolve(
      token === 'tok-owner'
        ? { caller: { subject: OWNER, locale: 'en-GB', timeZone: 'Europe/London' } }
        : token === 'tok-other'
          ? { caller: { subject: 'intruder-9' } }
          : null,
    );

  async function start(opts: { verifier?: boolean; ownerSubject?: string | null } = {}) {
    ownerCalls.length = 0;
    const reg = new Map<string, ServedTarget>();
    const ownerSubject = opts.ownerSubject === undefined ? OWNER : opts.ownerSubject;
    reg.set('priv', {
      served: targetWithConnector(ownerConnector),
      accessMode: 'owner-only',
      ...(ownerSubject !== null ? { ownerSubject } : {}),
    });
    const server = createServer(
      createMcpRouter(
        (id) => Promise.resolve(reg.get(id)),
        opts.verifier === false ? {} : { verifyOwnerToken },
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/priv/mcp`,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  const post = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(INIT),
    });

  it('rejects a request with no token (401 + resource_metadata challenge)', async () => {
    const s = await start();
    try {
      const res = await post(s.url);
      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge).toMatch(/Bearer/);
      // The challenge points at the protected-resource-metadata URL for this resource (RFC 9728).
      expect(challenge).toMatch(
        /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/priv\/mcp"/,
      );
    } finally {
      await s.close();
    }
  });

  it('accepts the owner token', async () => {
    const s = await start();
    try {
      expect((await post(s.url, { authorization: 'Bearer tok-owner' })).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('retains verified locale and timezone for owner-only tool execution', async () => {
    const s = await start();
    try {
      const response = await fetch(s.url, {
        method: 'POST',
        headers: {
          ...JSON_HEADERS,
          authorization: 'Bearer tok-owner',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_order', arguments: { order_id: 'A1' } },
        }),
      });
      expect(response.status).toBe(200);
      expect(ownerCalls[0]?.caller).toEqual({
        subject: OWNER,
        locale: 'en-GB',
        timeZone: 'Europe/London',
      });
    } finally {
      await s.close();
    }
  });

  it('forbids a valid token that is not the owner (403)', async () => {
    const s = await start();
    try {
      expect((await post(s.url, { authorization: 'Bearer tok-other' })).status).toBe(403);
    } finally {
      await s.close();
    }
  });

  it('rejects an invalid token (401)', async () => {
    const s = await start();
    try {
      expect((await post(s.url, { authorization: 'Bearer garbage' })).status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('fails closed when no verifier is configured (401)', async () => {
    const s = await start({ verifier: false });
    try {
      expect((await post(s.url, { authorization: 'Bearer tok-owner' })).status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('fails closed when no owner subject is recorded (401)', async () => {
    const s = await start({ ownerSubject: null });
    try {
      expect((await post(s.url, { authorization: 'Bearer tok-owner' })).status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('checks method before auth (GET on an owner-only server is still 405)', async () => {
    const s = await start();
    try {
      expect((await fetch(s.url, { method: 'GET' })).status).toBe(405);
    } finally {
      await s.close();
    }
  });
});

describe('createMcpRouter — authenticated first-party access', () => {
  const calls: ConnectorCall[] = [];
  const connector: Connector = {
    id: 'acme_orders',
    version: '1.2.0',
    signature: () => getOrderSig,
    invoke: async (call) => {
      calls.push(call);
      return { order: { id: call.args.id, subject: call.caller?.subject } };
    },
  };
  const verifyOwnerToken = (
    token: string,
  ): Promise<{ caller: { subject: string; email?: string } } | null> =>
    Promise.resolve(
      token === 'tok-alice'
        ? { caller: { subject: 'alice-sub', email: 'alice@example.com' } }
        : token === 'tok-bob'
          ? { caller: { subject: 'bob-sub' } }
          : null,
    );

  async function start(opts: { verifier?: boolean } = {}) {
    calls.length = 0;
    const reg = new Map<string, ServedTarget>();
    reg.set('first-party', {
      served: targetWithConnector(connector),
      accessMode: 'authenticated',
    });
    const server = createServer(
      createMcpRouter(
        (id) => Promise.resolve(reg.get(id)),
        opts.verifier === false ? {} : { verifyOwnerToken },
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/first-party/mcp`,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  const post = (
    url: string,
    body: unknown = INIT,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(body),
    });

  it('rejects a request with no token (401 + resource_metadata challenge)', async () => {
    const s = await start();
    try {
      const res = await post(s.url);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(
        /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/first-party\/mcp"/,
      );
    } finally {
      await s.close();
    }
  });

  it('rejects an invalid token (401)', async () => {
    const s = await start();
    try {
      expect((await post(s.url, INIT, { authorization: 'Bearer garbage' })).status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('accepts any verified identity without owner or org authorization', async () => {
    const s = await start();
    try {
      expect((await post(s.url, INIT, { authorization: 'Bearer tok-bob' })).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('threads verified subject and email into connector calls through HTTP', async () => {
    const s = await start();
    try {
      const res = await post(
        s.url,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'get_order', arguments: { order_id: 'A1' } },
        },
        { authorization: 'Bearer tok-alice', 'mcp-protocol-version': '2025-11-25' },
      );
      expect(res.status).toBe(200);
      expect(calls[0]?.caller).toEqual({ subject: 'alice-sub', email: 'alice@example.com' });
    } finally {
      await s.close();
    }
  });

  it('fails closed when no verifier is configured (401)', async () => {
    const s = await start({ verifier: false });
    try {
      expect((await post(s.url, INIT, { authorization: 'Bearer tok-alice' })).status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('checks method before auth (GET is still 405)', async () => {
    const s = await start();
    try {
      expect((await fetch(s.url, { method: 'GET' })).status).toBe(405);
    } finally {
      await s.close();
    }
  });
});

describe('createMcpRouter — public and mixed consumer access', () => {
  const calls: ConnectorCall[] = [];
  const connector: Connector = {
    id: 'acme_orders',
    version: '1.2.0',
    signature: () => getOrderSig,
    invoke: async (call) => {
      calls.push(call);
      return { order: { id: call.args.id, subject: call.caller?.subject ?? null } };
    },
  };
  const verifyOwnerToken = (
    token: string,
  ): Promise<{ caller: { subject: string; email?: string } } | null> =>
    Promise.resolve(
      token === 'tok-user' ? { caller: { subject: 'user-sub', email: 'user@example.com' } } : null,
    );

  async function start(accessMode: 'public' | 'mixed') {
    calls.length = 0;
    const reg = new Map<string, ServedTarget>();
    reg.set('consumer', {
      served: targetWithConnector(connector),
      accessMode,
    });
    const server = createServer(
      createMcpRouter((id) => Promise.resolve(reg.get(id)), { verifyOwnerToken }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/consumer/mcp`,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  const post = (
    url: string,
    body: unknown = INIT,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify(body),
    });

  const callTool = (url: string, headers: Record<string, string> = {}): Promise<Response> =>
    post(
      url,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'get_order', arguments: { order_id: 'A1' } },
      },
      { ...headers, 'mcp-protocol-version': '2025-11-25' },
    );

  it('serves public endpoints anonymously without an auth challenge', async () => {
    const s = await start('public');
    try {
      const res = await post(s.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('www-authenticate')).toBeNull();
      await callTool(s.url);
      expect(calls[0]?.caller).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it('serves mixed endpoints anonymously when no token is sent', async () => {
    const s = await start('mixed');
    try {
      expect((await post(s.url)).status).toBe(200);
      await callTool(s.url);
      expect(calls[0]?.caller).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it('threads caller claims for mixed endpoints when a valid token is sent', async () => {
    const s = await start('mixed');
    try {
      expect((await callTool(s.url, { authorization: 'Bearer tok-user' })).status).toBe(200);
      expect(calls[0]?.caller).toEqual({ subject: 'user-sub', email: 'user@example.com' });
    } finally {
      await s.close();
    }
  });

  it('rejects invalid mixed tokens with 401', async () => {
    const s = await start('mixed');
    try {
      const res = await post(s.url, INIT, { authorization: 'Bearer bad' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
    } finally {
      await s.close();
    }
  });

  it('keeps method ordering before optional mixed auth', async () => {
    const s = await start('mixed');
    try {
      expect((await fetch(s.url, { method: 'GET' })).status).toBe(405);
    } finally {
      await s.close();
    }
  });
});
