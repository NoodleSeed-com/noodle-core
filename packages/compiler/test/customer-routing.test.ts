import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile, compileManifest } from '../src/index.js';
import {
  app,
  codes,
  directAuth,
  federatedAuth,
  prototypeEndpointCatalog,
  routedCatalog,
  suffixPolicy,
} from './customer-routing-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures', 'valid');

function readFixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8');
}

describe('customer endpoint auth mapping cross-validation', () => {
  it('compiles direct OIDC with an exact endpoint mapping', () => {
    const result = compileManifest(app({ auth: directAuth() }), { catalog: routedCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifact.server.auth).toEqual(directAuth());
    expect(result.artifact.customerEndpoints).toEqual({
      customer_api: suffixPolicy,
    });
  });

  it('compiles federated OIDC with issuer-specific claim paths', () => {
    const auth = federatedAuth();
    const result = compileManifest(app({ auth }), { catalog: routedCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.auth).toEqual(auth);
    expect(result.artifact.customerEndpoints).toEqual({
      customer_api: suffixPolicy,
    });
  });

  it.each([
    'direct',
    'federated',
  ] as const)('preserves an own __proto__ endpoint through %s auth and artifact compilation', (kind) => {
    const endpoints = { ['__proto__']: { claim: 'tenant.api_base_url' } };
    const auth = kind === 'direct' ? directAuth(endpoints) : federatedAuth(endpoints, endpoints);
    const result = compileManifest(app({ auth }), { catalog: prototypeEndpointCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const artifactEndpoints = result.artifact.customerEndpoints;
    expect(artifactEndpoints).toBeDefined();
    if (artifactEndpoints === undefined) return;
    expect(Object.getPrototypeOf(artifactEndpoints)).toBeNull();
    expect(Object.hasOwn(artifactEndpoints, '__proto__')).toBe(true);
    expect(artifactEndpoints.__proto__).toEqual(suffixPolicy);

    const artifactAuth = result.artifact.server.auth;
    expect(artifactAuth).toBeDefined();
    if (artifactAuth === undefined || artifactAuth.kind === 'bridge') return;
    const routingEndpoints =
      artifactAuth.kind === 'federatedOidc'
        ? artifactAuth.issuers[0]?.routing?.endpoints
        : artifactAuth.routing?.endpoints;
    expect(routingEndpoints).toBeDefined();
    if (routingEndpoints === undefined) return;
    expect(Object.getPrototypeOf(routingEndpoints)).toBeNull();
    expect(Object.hasOwn(routingEndpoints, '__proto__')).toBe(true);
    expect(routingEndpoints.__proto__).toEqual({ claim: 'tenant.api_base_url' });
    expect(({} as { claim?: unknown }).claim).toBeUndefined();

    const serialized = JSON.parse(JSON.stringify(result.artifact)) as {
      customerEndpoints: Record<string, unknown>;
      server: {
        auth:
          | {
              kind?: 'oidc';
              routing?: { endpoints: Record<string, unknown> };
            }
          | {
              kind: 'federatedOidc';
              issuers: Array<{ routing?: { endpoints: Record<string, unknown> } }>;
            };
      };
    };
    const serializedRouting =
      serialized.server.auth.kind === 'federatedOidc'
        ? serialized.server.auth.issuers[0]?.routing?.endpoints
        : serialized.server.auth.routing?.endpoints;
    expect(Object.hasOwn(serialized.customerEndpoints, '__proto__')).toBe(true);
    expect(serializedRouting).toBeDefined();
    if (serializedRouting !== undefined) {
      expect(Object.hasOwn(serializedRouting, '__proto__')).toBe(true);
    }
  });

  it('rejects no auth, bridge auth, and missing direct mappings', () => {
    const noAuth = compileManifest(app(), { catalog: routedCatalog });
    expect(codes(noAuth)).toContain('customer_endpoint_auth_required');

    const bridge = compileManifest(app({ auth: { kind: 'bridge', provider: 'firebase' } }), {
      catalog: routedCatalog,
    });
    expect(codes(bridge)).toContain('customer_endpoint_bridge_unsupported');

    const missing = compileManifest(
      app({
        auth: {
          issuer: 'https://id.noodleseed.dev',
          audience: 'https://org.cloud.noodleseed.dev/app/mcp',
        },
      }),
      {
        catalog: routedCatalog,
      },
    );
    expect(codes(missing)).toContain('customer_endpoint_mapping_required');
  });

  it('rejects a missing issuer mapping and unknown direct or issuer mappings', () => {
    const missingIssuerAuth = federatedAuth() as {
      issuers: Array<Record<string, unknown>>;
    };
    delete missingIssuerAuth.issuers[1]?.routing;
    const missingIssuer = compileManifest(app({ auth: missingIssuerAuth }), {
      catalog: routedCatalog,
    });
    expect(codes(missingIssuer)).toContain('customer_endpoint_mapping_required');

    const unknownDirect = compileManifest(
      app({
        auth: directAuth({
          customer_api: { claim: 'tenant.api_base_url' },
          unused_api: { claim: 'tenant.unused_api_base_url' },
        }),
      }),
      { catalog: routedCatalog },
    );
    expect(codes(unknownDirect)).toContain('customer_endpoint_unknown_mapping');

    const unknownIssuer = compileManifest(
      app({
        auth: federatedAuth(undefined, {
          customer_api: { claim: 'organization.routes.customer_api' },
          unused_api: { claim: 'organization.routes.unused_api' },
        }),
      }),
      { catalog: routedCatalog },
    );
    expect(codes(unknownIssuer)).toContain('customer_endpoint_unknown_mapping');
  });

  it('keeps Core v1 and bridge auth routing-free and rejects top-level federated routing', () => {
    const v1 = app({ auth: directAuth() }) as Record<string, unknown>;
    v1.manifestVersion = '1';
    expect(codes(compileManifest(v1))).toContain('invalid_shape');

    const bridge = app({
      auth: {
        kind: 'bridge',
        provider: 'firebase',
        routing: {
          endpoints: { customer_api: { claim: 'tenant.api_base_url' } },
        },
      },
    });
    expect(codes(compileManifest(bridge))).toContain('invalid_shape');

    const federated = federatedAuth() as Record<string, unknown>;
    federated.routing = {
      endpoints: { customer_api: { claim: 'tenant.api_base_url' } },
    };
    expect(codes(compileManifest(app({ auth: federated })))).toContain('invalid_shape');
  });
});

describe('customer endpoint artifact contract', () => {
  it('matches the resolved customer-routing golden artifact', () => {
    const result = compile(readFixture('customer-routing.manifest.yaml'), {
      catalog: routedCatalog,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact).toEqual(JSON.parse(readFixture('customer-routing.artifact.json')));
  });

  it('emits only endpoint declarations and keys, never a resolved customer URL', () => {
    const result = compileManifest(app({ auth: directAuth() }), { catalog: routedCatalog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifact.artifactSchemaVersion).toBe('0.17.0');
    expect(result.artifact.customerEndpoints).toEqual({
      customer_api: suffixPolicy,
    });
    const fulfilment = result.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind).toBe('operation');
    if (fulfilment?.kind !== 'operation') return;
    expect(fulfilment.operationRef).toMatchObject({
      resolved: true,
      customerEndpoint: 'customer_api',
    });
    expect(JSON.stringify(result.artifact)).not.toContain('tenant-a.api.noodleseed.dev');
  });
});
