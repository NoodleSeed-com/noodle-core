import { describe, expect, it } from 'vitest';
import { connector, customerAuth, customerEndpoint, server, tool, z } from '../src/index.js';

function noopTool() {
  return tool('noop', {
    description: 'Return an empty result.',
    input: z.object({}),
    output: z.object({}),
    fulfil: () => ({}),
  });
}

describe('customerEndpoint', () => {
  it('returns a canonical endpoint reference without a resolved URL', () => {
    const endpoint = customerEndpoint('customer_api', {
      allowedHttpsHostSuffixes: ['Z.NOODLESEED.DEV', 'api.noodleseed.dev', 'z.noodleseed.dev'],
    });

    expect(endpoint).toEqual({
      kind: 'customerEndpoint',
      name: 'customer_api',
      policy: {
        allowedHttpsHostSuffixes: ['api.noodleseed.dev', 'z.noodleseed.dev'],
      },
    });
    expect(JSON.stringify(endpoint)).not.toContain('tenant');
  });

  it.each([
    '',
    'Customer_api',
    'customer-api',
    'customer.api',
  ])('rejects invalid endpoint name %j', (name) => {
    expect(() =>
      customerEndpoint(name, {
        allowedHttpsOrigins: ['https://api.noodleseed.dev'],
      }),
    ).toThrow('customer endpoint name');
  });

  it.each([
    {},
    { allowedHttpsOrigins: [], allowedHttpsHostSuffixes: undefined },
    {
      allowedHttpsOrigins: ['https://api.noodleseed.dev'],
      allowedHttpsHostSuffixes: ['noodleseed.dev'],
    },
  ])('rejects an invalid policy shape', (policy) => {
    expect(() => customerEndpoint('customer_api', policy as never)).toThrow(
      'invalid customer endpoint policy',
    );
  });

  it('serializes the endpoint object as an HTTP connector base URL', () => {
    const endpoint = customerEndpoint('customer_api', {
      allowedHttpsOrigins: ['https://api.noodleseed.dev'],
    });
    const api = connector('customer_records')
      .version('1.0.0')
      .http({
        baseUrl: endpoint,
        auth: {
          kind: 'delegatedTokenExchange',
          tokenUrl: 'https://idp.noodleseed.dev/oauth/token',
          clientId: 'CUSTOMER_API_CLIENT_ID',
          clientSecret: 'CUSTOMER_API_CLIENT_SECRET',
        },
        operations: {
          list_records: {
            type: 'read',
            method: 'GET',
            path: '/records',
            input: z.object({}),
            output: z.object({}),
          },
        },
      });

    expect(api.httpDef?.http.baseUrl).toEqual(endpoint);
  });
});

describe('customer auth endpoint routing authoring', () => {
  it.each([
    'direct',
    'federated',
  ] as const)('preserves an own __proto__ endpoint in %s authoring maps', (kind) => {
    const routing = {
      endpoints: { ['__proto__']: { claim: 'tenant.api_base_url' } },
    };
    const auth =
      kind === 'direct'
        ? customerAuth.oidc({
            issuer: 'https://idp.noodleseed.dev',
            audience: 'https://org.cloud.noodleseed.dev/app/mcp',
            routing,
          })
        : customerAuth.federatedOidc({
            issuers: [
              {
                issuer: 'https://idp.noodleseed.dev',
                audience: 'https://org.cloud.noodleseed.dev/app/mcp',
                routing,
              },
            ],
          });
    const endpoints =
      auth.kind === 'federatedOidc'
        ? auth.issuers[0]?.routing?.endpoints
        : auth.kind === 'bridge'
          ? undefined
          : auth.routing?.endpoints;

    expect(endpoints).toBeDefined();
    if (endpoints === undefined) return;
    expect(Object.getPrototypeOf(endpoints)).toBeNull();
    expect(Object.hasOwn(endpoints, '__proto__')).toBe(true);
    expect(endpoints.__proto__).toEqual({ claim: 'tenant.api_base_url' });
    expect(({} as { claim?: unknown }).claim).toBeUndefined();
  });

  it('serializes direct OIDC routing declarations', async () => {
    const app = server(
      'customer_records',
      {
        title: 'Customer records',
        version: '1.0.0',
        auth: customerAuth.oidc({
          issuer: 'https://idp.noodleseed.dev',
          audience: 'https://org.cloud.noodleseed.dev/app/mcp',
          routing: {
            endpoints: {
              customer_api: { claim: 'tenant.api_base_url' },
            },
          },
        }),
      },
      [noopTool()],
    );

    await expect(app.toManifest()).resolves.toMatchObject({
      server: {
        auth: {
          kind: 'oidc',
          routing: {
            endpoints: {
              customer_api: { claim: 'tenant.api_base_url' },
            },
          },
        },
      },
    });
  });

  it('serializes each federated issuer routing declaration independently', async () => {
    const app = server(
      'federated_customer_records',
      {
        title: 'Federated customer records',
        version: '1.0.0',
        auth: customerAuth.federatedOidc({
          issuers: [
            {
              issuer: 'https://idp-a.noodleseed.dev',
              audience: 'https://org.cloud.noodleseed.dev/app/mcp',
              routing: {
                endpoints: {
                  customer_api: { claim: 'tenant.api_base_url' },
                },
              },
            },
            {
              issuer: 'https://idp-b.noodleseed.dev',
              audience: 'https://org.cloud.noodleseed.dev/app/mcp',
              routing: {
                endpoints: {
                  customer_api: { claim: 'organization.routes.customer_api' },
                },
              },
            },
          ],
        }),
      },
      [noopTool()],
    );

    const manifest = await app.toManifest();
    expect(manifest.server.auth).toEqual({
      kind: 'federatedOidc',
      issuers: [
        {
          issuer: 'https://idp-a.noodleseed.dev',
          audience: 'https://org.cloud.noodleseed.dev/app/mcp',
          routing: {
            endpoints: {
              customer_api: { claim: 'tenant.api_base_url' },
            },
          },
        },
        {
          issuer: 'https://idp-b.noodleseed.dev',
          audience: 'https://org.cloud.noodleseed.dev/app/mcp',
          routing: {
            endpoints: {
              customer_api: { claim: 'organization.routes.customer_api' },
            },
          },
        },
      ],
    });
  });
});
