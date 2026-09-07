import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CatalogConnector } from '@noodle-borg/compiler';
import type { ConnectorCall } from '@noodle-borg/runtime';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCustomerVerifierFactory,
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';
import {
  type CustomerTlsBackends,
  createCustomerRouteConnector,
  startCustomerTlsBackends,
} from './customer-routing-acceptance-fixture.js';

const ACCEPT = 'application/json, text/event-stream';
const HEADERS = {
  'content-type': 'application/json',
  accept: ACCEPT,
  'mcp-protocol-version': '2025-11-25',
};
const ISSUER = 'https://customer-idp.noodleseed.dev';
const AUDIENCE = 'customer-records-api';
const ROUTE_A = 'https://tenant-a.api.noodleseed.dev/v1';
const ROUTE_B = 'https://tenant-b.api.noodleseed.dev/v2';
const ROUTED_CATALOG = {
  id: 'customer_records',
  version: '1.0.0',
  kind: 'catalog',
  operations: {
    list_records: {
      type: 'read',
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: {
          marker: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['marker', 'path'],
        additionalProperties: false,
      },
    },
    archive_records: {
      type: 'action',
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: {
          marker: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['marker', 'path'],
        additionalProperties: false,
      },
    },
  },
  customerRouting: {
    directEndpoint: 'customer_api',
    endpoints: {
      customer_api: { allowedHttpsHostSuffixes: ['api.noodleseed.dev'] },
    },
    operationEndpoints: {
      archive_records: ['customer_api'],
      list_records: ['customer_api'],
    },
    operationActionEndpoints: {
      archive_records: ['customer_api'],
      list_records: [],
    },
  },
} as const satisfies CatalogConnector;

const MANIFEST = JSON.stringify({
  manifestVersion: '2',
  server: {
    name: 'customer_records',
    version: '1.0.0',
    title: 'Customer Records',
    interactions: { confirmationFallback: 'host' },
    auth: {
      issuer: ISSUER,
      audience: AUDIENCE,
      claims: {
        roles: 'permissions.roles',
        scopes: 'permissions.scopes',
      },
      routing: {
        endpoints: {
          customer_api: { claim: 'tenant.api_base_url' },
        },
      },
    },
  },
  connectors: {
    records: { id: 'customer_records', version: '1.0.0' },
  },
  tools: [
    {
      name: 'list_records',
      description: 'List customer records.',
      authorization: {
        requiredScopes: ['records.read'],
        allowedRoles: ['support'],
      },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      fulfilment: { use: 'records.list_records', args: {} },
    },
    {
      name: 'archive_records',
      description: 'Archive customer records after confirmation.',
      authorization: {
        requiredScopes: ['records.write'],
        allowedRoles: ['support'],
      },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        confirm: true,
      },
      fulfilment: { use: 'records.archive_records', args: {} },
    },
  ],
});

let service: Server | undefined;
let serviceBase: string;
let endpoint: string;
let backends: CustomerTlsBackends | undefined;
let privateKey: CryptoKey | Uint8Array;
let jwks: unknown;
let connectorCalls: ConnectorCall[];
let logs: unknown[];
let rpcId = 0;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'customer-route-key', alg: 'RS256' }],
  };
  backends = await startCustomerTlsBackends();
  const activeBackends = backends;
  connectorCalls = [];
  logs = [];
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner-sub', email: 'owner@noodleseed.com' },
  });
  const registry = new ServerRegistry(new InMemoryArtifactStore(), undefined, undefined, {
    customerVerifierFactory: createCustomerVerifierFactory({
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url === `${ISSUER}/.well-known/openid-configuration`) {
          return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks.json` });
        }
        if (url === `${ISSUER}/jwks.json`) return Response.json(jwks);
        return new Response('not found', { status: 404 });
      },
    }),
  });
  const handler = createServiceHandler(registry, {
    controlPlaneStore: controlPlane,
    deployGate: {
      authorize: () =>
        Promise.resolve({
          ok: true,
          identity: {
            subject: 'owner-sub',
            email: 'owner@noodleseed.com',
            superAdmin: true,
          },
        }),
    },
    authServerIssuer: 'https://platform-as.noodleseed.dev',
    logger: {
      debug: (message, fields) => logs.push({ message, fields }),
      info: (message, fields) => logs.push({ message, fields }),
      warn: (message, fields) => logs.push({ message, fields }),
      error: (message, fields) => logs.push({ message, fields }),
    },
  });
  // Service composition seeds the builtin catalog; install the test platform connector afterward.
  registry.setPlatformConnectors({
    catalog: [ROUTED_CATALOG],
    connectors: [
      createCustomerRouteConnector({
        routes: {
          [ROUTE_A]: activeBackends.a.origin,
          [ROUTE_B]: activeBackends.b.origin,
        },
        // The connector trusts this exact test certificate; no process-global TLS bypass is used.
        certificate: activeBackends.certificate,
        calls: connectorCalls,
      }),
    ],
  });
  service = createServer(handler);
  const activeService = service;
  await new Promise<void>((resolve) => activeService.listen(0, '127.0.0.1', resolve));
  serviceBase = `http://127.0.0.1:${(activeService.address() as AddressInfo).port}`;

  const deployed = await fetch(`${serviceBase}/v1/orgs/acme/apps/records/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
    body: JSON.stringify({ manifest: MANIFEST, accessMode: 'customers', serverVersion: '1' }),
  });
  const body = (await deployed.json()) as { readonly url?: string; readonly errors?: unknown };
  expect(deployed.status, JSON.stringify(body)).toBe(201);
  if (body.url === undefined) throw new Error('customer routing deployment returned no URL');
  endpoint = body.url;
});

beforeEach(() => {
  const activeBackends = requireBackends();
  connectorCalls.length = 0;
  activeBackends.a.calls.length = 0;
  activeBackends.b.calls.length = 0;
  logs.length = 0;
});

afterAll(async () => {
  if (service !== undefined) {
    await new Promise<void>((resolve, reject) =>
      service?.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await backends?.close();
});

describe('authenticated customer endpoint acceptance', () => {
  it('routes the same authorized read tool to two customer-specific TLS backends', async () => {
    const activeBackends = requireBackends();
    const tokenA = await signCustomerToken('customer-a', ROUTE_A);
    const tokenB = await signCustomerToken('customer-b', ROUTE_B);

    const [listedA, listedB] = await Promise.all([listTools(tokenA), listTools(tokenB)]);
    expect(toolNames(listedA)).toEqual(['list_records']);
    expect(toolNames(listedB)).toEqual(['list_records']);
    expect(listedA.result).toEqual(listedB.result);

    const resultA = await callTool(tokenA);
    const resultB = await callTool(tokenB);
    expect(resultA).toEqual({
      marker: 'tenant-a',
      path: '/v1/records',
    });
    expect(resultB).toEqual({
      marker: 'tenant-b',
      path: '/v2/records',
    });

    expect(activeBackends.a.calls).toEqual([{ method: 'GET', path: '/v1/records' }]);
    expect(activeBackends.b.calls).toEqual([{ method: 'GET', path: '/v2/records' }]);
    expect(connectorCalls.map((call) => call.route?.baseUrl)).toEqual([ROUTE_A, ROUTE_B]);
    expect(connectorCalls.map((call) => call.caller)).toEqual([
      expect.objectContaining({
        subject: 'customer-a',
        roles: ['support'],
        scopes: ['records.read'],
      }),
      expect.objectContaining({
        subject: 'customer-b',
        roles: ['support'],
        scopes: ['records.read'],
      }),
    ]);
    expect(connectorCalls.every((call) => call.credential.token === '')).toBe(true);
    expect(JSON.stringify(connectorCalls.map((call) => call.caller))).not.toContain(
      'api.noodleseed.dev',
    );
    const exposed = JSON.stringify({ listedA, listedB, resultA, resultB, logs });
    for (const forbidden of [tokenA, tokenB, ROUTE_A, ROUTE_B, 'customer_api', 'fingerprint']) {
      expect(exposed).not.toContain(forbidden);
    }
  });

  it('keeps discovery route-independent and fails unavailable routes before connector egress', async () => {
    const activeBackends = requireBackends();
    const failures = [
      { label: 'missing', route: undefined },
      { label: 'malformed', route: ` ${ROUTE_A}` },
      { label: 'disallowed', route: 'https://tenant-a.attacker.example/private-route' },
    ] as const;

    for (const failure of failures) {
      const token = await signCustomerToken(`customer-${failure.label}`, failure.route);
      const listed = await listTools(token);
      expect(toolNames(listed)).toEqual(['list_records']);

      const response = await callToolResponse(token);
      expect(response).toMatchObject({
        result: {
          content: [{ type: 'text', text: 'Customer connector route is unavailable.' }],
          structuredContent: {
            error: { code: 'connector_route_unavailable' },
          },
          isError: true,
        },
      });

      const exposed = JSON.stringify({ response, logs });
      for (const forbidden of [
        token,
        failure.route,
        ROUTE_A,
        ROUTE_B,
        'customer_api',
        'tenant.api_base_url',
        'allowedHttpsHostSuffixes',
        'fingerprint',
      ]) {
        if (forbidden !== undefined) expect(exposed).not.toContain(forbidden);
      }
    }

    const insufficient = await signCustomerToken('customer-viewer', ROUTE_A, {
      roles: ['viewer'],
      scopes: [],
    });
    expect(toolNames(await listTools(insufficient))).toEqual([]);
    expect(connectorCalls).toEqual([]);
    expect(activeBackends.a.calls).toEqual([]);
    expect(activeBackends.b.calls).toEqual([]);
  });

  it('executes a host-confirmed routed action against each caller TLS backend without route leakage', async () => {
    const activeBackends = requireBackends();
    const authorization = {
      roles: ['support'],
      scopes: ['records.read', 'records.write'],
    } as const;
    const tokenA = await signCustomerToken('customer-action-a', ROUTE_A, authorization);
    const tokenB = await signCustomerToken('customer-action-b', ROUTE_B, authorization);

    const [listedA, listedB] = await Promise.all([listTools(tokenA), listTools(tokenB)]);
    expect(toolNames(listedA)).toEqual(['list_records', 'archive_records']);
    expect(listedA.result).toEqual(listedB.result);

    const resultA = await callTool(tokenA, 'archive_records');
    const resultB = await callTool(tokenB, 'archive_records');
    expect(resultA).toEqual({ marker: 'tenant-a', path: '/v1/archive' });
    expect(resultB).toEqual({ marker: 'tenant-b', path: '/v2/archive' });
    expect(activeBackends.a.calls).toEqual([{ method: 'POST', path: '/v1/archive' }]);
    expect(activeBackends.b.calls).toEqual([{ method: 'POST', path: '/v2/archive' }]);

    const exposed = JSON.stringify({ listedA, listedB, resultA, resultB, logs });
    for (const forbidden of [tokenA, tokenB, ROUTE_A, ROUTE_B, 'customer_api', 'fingerprint']) {
      expect(exposed).not.toContain(forbidden);
    }
  });
});

async function signCustomerToken(
  subject: string,
  route: string | undefined,
  authorization: {
    readonly roles: readonly string[];
    readonly scopes: readonly string[];
  } = { roles: ['support'], scopes: ['records.read'] },
): Promise<string> {
  return new SignJWT({
    permissions: authorization,
    ...(route === undefined ? {} : { tenant: { api_base_url: route } }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'customer-route-key' })
    .setIssuer(ISSUER)
    .setSubject(subject)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function listTools(token: string): Promise<Record<string, unknown>> {
  return mcp(token, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/list',
  });
}

async function callTool(token: string, toolName = 'list_records'): Promise<unknown> {
  const response = await callToolResponse(token, toolName);
  return (response.result as { readonly structuredContent?: unknown }).structuredContent;
}

function callToolResponse(
  token: string,
  toolName = 'list_records',
): Promise<Record<string, unknown>> {
  return mcp(token, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name: toolName, arguments: {} },
  });
}

async function mcp(token: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

function toolNames(body: Record<string, unknown>): string[] {
  const result = body.result as { readonly tools?: readonly { readonly name: string }[] };
  return result.tools?.map((tool) => tool.name) ?? [];
}

function requireBackends(): CustomerTlsBackends {
  if (backends === undefined) throw new Error('customer TLS backends are not running');
  return backends;
}
