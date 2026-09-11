import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { CatalogConnector } from '@noodle-borg/compiler';
import type { ConnectorCall, CredentialRequest } from '@noodle-borg/runtime';
import { exportJWK, generateKeyPair, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import {
  createCustomerVerifierFactory,
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';
import { InMemoryConfigStore, resolveConfigScope } from '../src/store.js';
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

let registry: ServerRegistry;
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
  registry = new ServerRegistry(new InMemoryArtifactStore(), undefined, undefined, {
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
    expect(
      connectorCalls.every((call) => 'token' in call.credential && call.credential.token === ''),
    ).toBe(true);
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

describe.each([
  { mode: 'mixed', era: '2025-11-25' },
  { mode: 'mixed', era: '2026-07-28' },
  { mode: 'customers', era: '2025-11-25' },
  { mode: 'customers', era: '2026-07-28' },
] as const)('verified customer to delegated business API ($mode / $era)', ({ mode, era }) => {
  let resource: string;
  let deploymentId: string;
  let app: string;
  let brokerRequests: CredentialRequest[];
  let exchangeAssertions: JWTPayload[];
  let exchangedTokens: string[];
  let tokenEndpoint: ReturnType<typeof vi.fn<typeof fetch>>;
  const grants = { roles: ['support'], scopes: ['records.read', 'records.write'] };

  beforeAll(async () => {
    app = 'records';
    const version = String((mode === 'mixed' ? 2 : 4) + (era === '2026-07-28' ? 1 : 0));
    const manifest = JSON.parse(MANIFEST);
    manifest.tools.unshift({
      name: 'help',
      description: 'Public Help',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      fulfilment: { steps: [], output: { message: 'Help is available' } },
    });
    const response = await fetch(`${serviceBase}/v1/orgs/acme/apps/${app}/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
      body: JSON.stringify({
        manifest: JSON.stringify(manifest),
        accessMode: mode,
        serverVersion: version,
      }),
    });
    const deployed = await response.json();
    expect(response.status, JSON.stringify(deployed)).toBe(201);
    expect(deployed.authentication).toBe('customer');
    resource = deployed.url;
    deploymentId = deployed.deploymentId;
  });

  beforeEach(async () => {
    brokerRequests = [];
    exchangeAssertions = [];
    exchangedTokens = [];
    const signer = await createStaticSigningKeyProvider();
    const scope = resolveConfigScope({ org: 'acme', app, env: 'prod' });
    const store = new InMemoryConfigStore();
    await store.setConfigValue({
      kind: 'secret',
      scope,
      name: 'DELEGATED_SECRET',
      value: 'test-exchange-secret',
    });
    tokenEndpoint = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://exchange.noodleseed.test/token');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('scope')).toBe('records:read records:write');
      const { payload } = await jwtVerify(
        form.get('subject_token') ?? '',
        await signer.verifierKey(),
        { issuer: 'https://platform.noodleseed.test', audience: 'customer-business-api' },
      );
      exchangeAssertions.push(payload);
      const token = `issued-${payload.sub}-${exchangeAssertions.length}`;
      exchangedTokens.push(token);
      return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 900 });
    });
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'customer_records',
          connectorVersion: '1.0.0',
          authKind: 'delegatedTokenExchange',
          customerEndpoint: 'customer_api',
          secretRef: 'DELEGATED_SECRET',
          tokenExchange: {
            tokenUrl: 'https://exchange.noodleseed.test/token',
            clientId: 'route-test',
            authMethod: 'client_secret_basic',
            audience: 'customer-business-api',
            scopes: ['records:read', 'records:write'],
          },
        },
      ],
      store,
      scope,
      {
        delegatedExchange: {
          issuer: 'https://platform.noodleseed.test',
          signer,
          tenant: `acme/${app}/prod`,
          deployment: deploymentId,
        },
        fetchImpl: tokenEndpoint,
      },
    );
    const target = await registry.get(deploymentId);
    if (!target) throw new Error('compiled target missing');
    // Test-only real broker composition: the existing pinned TLS connector has a catalog binding.
    // Production registry binding construction is separately proved by local-devtools-delegated-exchange.
    Object.assign(target.served.deps, {
      broker: {
        getCredential: (request: CredentialRequest) => {
          brokerRequests.push(request);
          return broker.getCredential(request);
        },
      },
    });
  });

  function request(name: string, token?: string, args: Record<string, unknown> = {}) {
    return fetch(resource, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'mcp-protocol-version': era,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(era === '2026-07-28' ? { 'mcp-method': 'tools/call', 'mcp-name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          ...(era === '2026-07-28'
            ? {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': era,
                  'io.modelcontextprotocol/clientCapabilities': {},
                  'io.modelcontextprotocol/clientInfo': {
                    name: 'customer-routing-test',
                    version: '1',
                  },
                },
              }
            : {}),
        },
      }),
    });
  }

  function noDownstreamCalls() {
    expect(brokerRequests).toEqual([]);
    expect(tokenEndpoint).not.toHaveBeenCalled();
    expect(connectorCalls).toEqual([]);
    expect(requireBackends().a.calls).toEqual([]);
    expect(requireBackends().b.calls).toEqual([]);
  }

  it('preserves anonymous Help policy without touching the broker or business API', async () => {
    const response = await request('help');
    expect(response.status).toBe(mode === 'mixed' ? 200 : 401);
    if (mode === 'mixed')
      expect(await response.json()).toMatchObject({
        result: { structuredContent: { message: 'Help is available' } },
      });
    noDownstreamCalls();
  });

  it.each([
    'anonymous',
    'wrong-role',
    'missing-scope',
  ] as const)('denies %s before real broker, exchange or egress', async (kind) => {
    const token =
      kind === 'anonymous'
        ? undefined
        : await signCustomerToken(`denied-${kind}`, ROUTE_A, {
            roles: kind === 'wrong-role' ? ['viewer'] : ['support'],
            scopes: kind === 'missing-scope' ? [] : ['records.read'],
          });
    const response = await request('list_records', token);
    expect(response.status, await response.clone().text()).toBe(kind === 'anonymous' ? 401 : 403);
    noDownstreamCalls();
  });

  it.each([
    'list_records',
    'archive_records',
  ])('sends only exchanged credentials to each verified route for %s', async (operation) => {
    const tokens = await Promise.all([
      signCustomerToken('business-a', ROUTE_A, grants),
      signCustomerToken('business-b', ROUTE_B, grants),
    ]);
    const outputs: unknown[] = [];
    for (const token of tokens) {
      const response = await request(operation, token);
      expect(response.status, await response.clone().text()).toBe(200);
      const output = await response.json();
      expect(output.result.isError).not.toBe(true);
      outputs.push(output);
    }
    expect(brokerRequests.map((request) => request.customerIssuer)).toEqual([ISSUER, ISSUER]);
    expect(brokerRequests.map((request) => request.caller)).toEqual([
      expect.objectContaining({
        subject: 'business-a',
        audience: resource,
        identityKind: 'customer',
        ...grants,
      }),
      expect.objectContaining({
        subject: 'business-b',
        audience: resource,
        identityKind: 'customer',
        ...grants,
      }),
    ]);
    for (let index = 0; index < 2; index++) {
      const route = brokerRequests[index]?.route;
      expect(route).toEqual({
        key: 'customer_api',
        fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(exchangeAssertions[index]).toMatchObject({
        sub: index === 0 ? 'business-a' : 'business-b',
        tenant: `acme/${app}/prod`,
        deployment: deploymentId,
        customer_identity: { version: 1, issuer: ISSUER },
        route,
      });
    }
    expect(connectorCalls.map((call) => call.route?.baseUrl)).toEqual([ROUTE_A, ROUTE_B]);
    expect(
      connectorCalls.map((call) =>
        'token' in call.credential ? call.credential.token : undefined,
      ),
    ).toEqual(exchangedTokens);
    const action = operation === 'archive_records';
    expect(requireBackends().a.calls).toEqual([
      {
        method: action ? 'POST' : 'GET',
        path: `/v1/${action ? 'archive' : 'records'}`,
        authorization: `Bearer ${exchangedTokens[0]}`,
      },
    ]);
    expect(requireBackends().b.calls).toEqual([
      {
        method: action ? 'POST' : 'GET',
        path: `/v2/${action ? 'archive' : 'records'}`,
        authorization: `Bearer ${exchangedTokens[1]}`,
      },
    ]);
    const publicData = JSON.stringify({ outputs, logs });
    for (const secret of [
      ...tokens,
      ...exchangedTokens,
      ROUTE_A,
      ROUTE_B,
      ISSUER,
      'customer_api',
      'fingerprint',
    ])
      expect(publicData).not.toContain(secret);
    expect(JSON.stringify(exchangeAssertions)).not.toContain(ROUTE_A);
    expect(JSON.stringify(exchangeAssertions)).not.toContain(ROUTE_B);
  });

  it('rejects forged routing and identity arguments before exchange, then retains the signed route', async () => {
    const token = await signCustomerToken('forgery-a', ROUTE_A, grants);
    const response = await request('list_records', token, {
      route: ROUTE_B,
      tenant: 'attacker',
      subject: 'business-b',
      customerIssuer: 'https://attacker.test',
    });
    const body = await response.json();
    expect(body.error ?? body.result?.isError).toBeTruthy();
    noDownstreamCalls();
    const valid = await request('list_records', token);
    expect(valid.status).toBe(200);
    expect((await valid.json()).result.structuredContent.marker).toBe('tenant-a');
    expect(brokerRequests[0]?.caller?.subject).toBe('forgery-a');
    expect(brokerRequests[0]?.customerIssuer).toBe(ISSUER);
    expect(connectorCalls[0]?.route?.baseUrl).toBe(ROUTE_A);
    expect(requireBackends().b.calls).toEqual([]);
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
