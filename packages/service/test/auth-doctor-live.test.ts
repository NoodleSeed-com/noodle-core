import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import type { ServerRegistry } from '../src/registry.js';
import { dispatchAuthDoctorRoute } from '../src/routes/auth-doctor-dispatch.js';
import { handleLiveAuthDoctor } from '../src/routes/auth-doctor-live.js';
import { InMemoryConfigStore } from '../src/store.js';
import { credentialBrokerScope as scope } from './credential-broker-fixtures.js';

describe('live auth doctor', () => {
  it('verifies a customer caller and probes delegated bindings without executing a connector', async () => {
    let safeRoute: unknown;
    const probe = vi.fn().mockImplementation(async (_caller, resolveRoute) => {
      safeRoute = resolveRoute({
        connectorId: 'orders',
        connectorVersion: '1.0.0',
        key: 'customer_api',
      });
      return [
        {
          connectorId: 'orders',
          operation: 'list_items',
          authKind: 'delegatedTokenExchange',
          ok: true,
        },
      ];
    });
    const verifyToken = vi.fn().mockResolvedValue({
      caller: {
        subject: 'customer-1',
        audience: 'https://cloud.example/o/acme/app/mcp',
        identityKind: 'customer',
      },
      customerIssuer: 'https://customer-idp.example',
      customerRouting: {
        customer_api: 'https://tenant.api.noodleseed.dev/v1',
      },
    });
    const registry = {
      getActiveByTenant: vi.fn().mockResolvedValue({
        accessMode: 'customers',
        authentication: { kind: 'customer', verifyToken },
        served: {
          artifact: {
            customerEndpoints: {
              customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
            },
          },
          deps: { broker: { getCredential: vi.fn(), probeDelegatedCredentials: probe } },
        },
      }),
    } as unknown as ServerRegistry;
    const response = captureResponse();

    await handleLiveAuthDoctor(
      { headers: { authorization: 'Bearer customer-token' } } as IncomingMessage,
      response.res,
      registry,
      { org: 'acme', app: 'app', env: 'prod' },
      {
        serviceBase: 'https://cloud.example',
        resolveEndpointOptions: async () => ({
          publicBaseDomain: 'mcp.example',
          mcpSubdomain: 'arez',
        }),
      },
    );

    expect(verifyToken).toHaveBeenCalledWith('customer-token', 'https://arez.mcp.example/app/mcp');
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ identityKind: 'customer' }),
      expect.any(Function),
      'https://customer-idp.example',
    );
    expect(safeRoute).toEqual({
      key: 'customer_api',
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(safeRoute).not.toHaveProperty('baseUrl');
    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      ok: true,
      resource: 'https://arez.mcp.example/app/mcp',
      checks: [{ connectorId: 'orders', ok: true }],
    });
    const serialized = JSON.stringify(response.body());
    expect(serialized).not.toContain('"audience"');
    expect(serialized).not.toContain('tenant.api.noodleseed.dev');
    expect(serialized).not.toContain('customer_api');
    expect(serialized).not.toContain('sha256:');
  });

  it('verifies an explicit deployed version against its exact MCP resource', async () => {
    const versionedResource = 'https://cloud.example/o/acme/app/v2_0/mcp';
    const verifyToken = vi.fn().mockResolvedValue({
      caller: {
        subject: 'customer-1',
        audience: versionedResource,
        identityKind: 'customer',
      },
      customerIssuer: 'https://customer-idp.example',
    });
    const probe = vi.fn().mockResolvedValue([]);
    const getActiveByTenant = vi.fn();
    const getActiveByTenantVersion = vi.fn().mockResolvedValue({
      accessMode: 'customers',
      authentication: { kind: 'customer', verifyToken },
      served: {
        artifact: { customerEndpoints: {} },
        deps: { broker: { getCredential: vi.fn(), probeDelegatedCredentials: probe } },
      },
    });
    const registry = {
      getActiveByTenant,
      getActiveByTenantVersion,
    } as unknown as ServerRegistry;
    const response = captureResponse();

    await handleLiveAuthDoctor(
      { headers: { authorization: 'Bearer customer-token' } } as IncomingMessage,
      response.res,
      registry,
      { org: 'acme', app: 'app', env: 'prod' },
      { serviceBase: 'https://cloud.example', serverVersion: 'v2_0' },
    );

    expect(getActiveByTenant).not.toHaveBeenCalled();
    expect(getActiveByTenantVersion).toHaveBeenCalledWith(
      { org: 'acme', app: 'app', env: 'prod' },
      '2.0',
    );
    expect(verifyToken).toHaveBeenCalledWith('customer-token', versionedResource);
    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      ok: true,
      resource: versionedResource,
      checks: [],
    });
    expect(response.body()).not.toHaveProperty('audience');
  });

  it('threads the version query from the service route to the live probe', async () => {
    const versionedResource = 'https://cloud.example/o/acme/app/v2_0/mcp';
    const verifyToken = vi.fn().mockResolvedValue({
      caller: {
        subject: 'customer-1',
        audience: versionedResource,
        identityKind: 'customer',
      },
      customerIssuer: 'https://customer-idp.example',
    });
    const getActiveByTenantVersion = vi.fn().mockResolvedValue({
      accessMode: 'customers',
      authentication: { kind: 'customer', verifyToken },
      served: {
        artifact: { customerEndpoints: {} },
        deps: {
          broker: {
            getCredential: vi.fn(),
            probeDelegatedCredentials: vi.fn().mockResolvedValue([]),
          },
        },
      },
    });
    const registry = {
      getActiveByTenant: vi.fn(),
      getActiveByTenantVersion,
    } as unknown as ServerRegistry;
    const response = captureResponse();

    expect(
      dispatchAuthDoctorRoute(
        {
          method: 'POST',
          headers: { authorization: 'Bearer customer-token' },
        } as IncomingMessage,
        response.res,
        new URL('https://control.example/v1/orgs/acme/apps/app/envs/prod/auth/doctor?version=v2_0'),
        {
          registry,
          serviceBase: 'https://cloud.example',
          resolveEndpointOptions: async () => ({}),
          applySecurityHeaders: vi.fn(),
          enforceHttps: () => false,
          sendJson: vi.fn(),
          tls: {},
        },
      ),
    ).toBe(true);
    await response.completed;

    expect(getActiveByTenantVersion).toHaveBeenCalledWith(
      { org: 'acme', app: 'app', env: 'prod' },
      '2.0',
    );
    expect(verifyToken).toHaveBeenCalledWith('customer-token', versionedResource);
    expect(response.body()).toMatchObject({ resource: versionedResource });
  });

  it('rejects an explicitly empty version query instead of probing the active deployment', async () => {
    const getActiveByTenant = vi.fn();
    const getActiveByTenantVersion = vi.fn();
    const response = captureResponse();

    expect(
      dispatchAuthDoctorRoute(
        {
          method: 'POST',
          headers: { authorization: 'Bearer customer-token' },
        } as IncomingMessage,
        response.res,
        new URL('https://control.example/v1/orgs/acme/apps/app/envs/prod/auth/doctor?version='),
        {
          registry: {
            getActiveByTenant,
            getActiveByTenantVersion,
          } as unknown as ServerRegistry,
          serviceBase: 'https://cloud.example',
          resolveEndpointOptions: async () => ({}),
          applySecurityHeaders: vi.fn(),
          enforceHttps: () => false,
          sendJson: vi.fn(),
          tls: {},
        },
      ),
    ).toBe(true);
    await response.completed;

    expect(response.status()).toBe(400);
    expect(response.body()).toMatchObject({ ok: false, error: expect.stringContaining('invalid') });
    expect(getActiveByTenant).not.toHaveBeenCalled();
    expect(getActiveByTenantVersion).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit version before deployment lookup or token verification', async () => {
    const getActiveByTenant = vi.fn();
    const getActiveByTenantVersion = vi.fn();
    const registry = {
      getActiveByTenant,
      getActiveByTenantVersion,
    } as unknown as ServerRegistry;
    const response = captureResponse();

    await handleLiveAuthDoctor(
      { headers: { authorization: 'Bearer customer-token' } } as IncomingMessage,
      response.res,
      registry,
      { org: 'acme', app: 'app', env: 'prod' },
      { serviceBase: 'https://cloud.example', serverVersion: 'not/a/version' },
    );

    expect(response.status()).toBe(400);
    expect(response.body()).toMatchObject({ ok: false, error: expect.stringContaining('invalid') });
    expect(getActiveByTenant).not.toHaveBeenCalled();
    expect(getActiveByTenantVersion).not.toHaveBeenCalled();
  });

  it('rejects a verified identity that is not classified by the trusted verifier as a customer', async () => {
    const probe = vi.fn();
    const registry = {
      getActiveByTenant: vi.fn().mockResolvedValue({
        accessMode: 'customers',
        authentication: {
          kind: 'customer',
          verifyToken: vi.fn().mockResolvedValue({
            caller: { subject: 'owner', identityKind: 'platform' },
          }),
        },
        served: { deps: { broker: { getCredential: vi.fn(), probeDelegatedCredentials: probe } } },
      }),
    } as unknown as ServerRegistry;
    const response = captureResponse();

    await handleLiveAuthDoctor(
      { headers: { authorization: 'Bearer platform-token' } } as IncomingMessage,
      response.res,
      registry,
      { org: 'acme', app: 'app', env: 'prod' },
      { serviceBase: 'https://cloud.example' },
    );

    expect(response.status()).toBe(401);
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-url'],
    ['disallowed', 'https://attacker.example/v1'],
  ] as const)('reports a %s customer endpoint claim as generically unavailable before broker dependencies', async (_label, rawRoute) => {
    const signer = await createStaticSigningKeyProvider();
    const signingKey = vi.spyOn(signer, 'signingKey');
    const configStore = new InMemoryConfigStore();
    const resolveConfig = vi.spyOn(configStore, 'resolveConfigValues');
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const broker = new ManagedConfigBroker(
      [
        {
          connectorId: 'orders',
          connectorVersion: '1.0.0',
          operation: 'list_items',
          customerEndpoint: 'customer_api',
          authKind: 'delegatedTokenExchange',
          secretRef: 'ORDERS_CLIENT_SECRET',
          tokenExchange: {
            tokenUrl: 'https://identity.example/oauth/token',
            clientId: 'orders-client',
            authMethod: 'client_secret_basic',
          },
        },
      ],
      configStore,
      scope,
      {
        delegatedExchange: {
          issuer: 'https://cloud.example',
          signer,
          tenant: 'acme/app/prod',
          deployment: 'app-abc12345',
        },
        fetchImpl,
      },
    );
    const verifyToken = vi.fn().mockResolvedValue({
      caller: {
        subject: 'customer-1',
        audience: 'https://cloud.example/o/acme/app/mcp',
        identityKind: 'customer',
      },
      customerIssuer: 'https://customer-idp.example',
      ...(rawRoute === undefined ? {} : { customerRouting: { customer_api: rawRoute } }),
    });
    const registry = {
      getActiveByTenant: vi.fn().mockResolvedValue({
        accessMode: 'customers',
        authentication: { kind: 'customer', verifyToken },
        served: {
          artifact: {
            customerEndpoints: {
              customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
            },
          },
          deps: { broker },
        },
      }),
    } as unknown as ServerRegistry;
    const response = captureResponse();

    await handleLiveAuthDoctor(
      { headers: { authorization: 'Bearer customer-token' } } as IncomingMessage,
      response.res,
      registry,
      { org: 'acme', app: 'app', env: 'prod' },
      { serviceBase: 'https://cloud.example' },
    );

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      ok: false,
      checks: [
        {
          connectorId: 'orders',
          operation: 'list_items',
          authKind: 'delegatedTokenExchange',
          ok: false,
          reason: 'connector_route_unavailable',
        },
      ],
    });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(signingKey).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    const serialized = JSON.stringify(response.body());
    expect(serialized).not.toContain('customer_api');
    expect(serialized).not.toContain('sha256:');
    if (rawRoute !== undefined) expect(serialized).not.toContain(rawRoute);
  });
});

function captureResponse(): {
  readonly res: ServerResponse;
  readonly status: () => number | undefined;
  readonly body: () => Record<string, unknown>;
  readonly completed: Promise<void>;
} {
  let status: number | undefined;
  let body = '';
  let complete: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    res: {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(chunk?: string) {
        body = chunk ?? '';
        complete();
        return this;
      },
    } as unknown as ServerResponse,
    status: () => status,
    body: () => JSON.parse(body) as Record<string, unknown>,
    completed,
  };
}
