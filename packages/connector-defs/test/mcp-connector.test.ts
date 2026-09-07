import { ConnectorInvocationError } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../src/index.js';

const objectSchema = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
} as const;

const resultSchema = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'],
  additionalProperties: false,
} as const;

function source(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    connectors: [
      {
        id: 'shopify_storefront_mcp',
        version: '1.0.0',
        kind: 'custom',
        mcp: {
          endpoint: 'https://store.example/api/mcp',
          auth: { kind: 'bearer', secret: 'SHOPIFY_STOREFRONT_TOKEN' },
        },
        operations: {
          search_products: {
            type: 'read',
            tool: 'search-products',
            input: objectSchema,
            output: resultSchema,
            fake: { structuredContent: { items: ['one', 'two'] } },
          },
        },
        ...overrides,
      },
    ],
  });
}

describe('MCP connector compilation', () => {
  it('emits a normal catalog signature, broker binding, and runnable fake connector', async () => {
    const compiled = compileConnectors(source(), { mode: 'fake' });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    expect(compiled.catalog).toMatchObject([
      {
        id: 'shopify_storefront_mcp',
        version: '1.0.0',
        kind: 'custom',
        operations: {
          search_products: {
            type: 'read',
            input: objectSchema,
            output: resultSchema,
          },
        },
      },
    ]);
    expect(compiled.secretBindings).toEqual([
      {
        connectorId: 'shopify_storefront_mcp',
        connectorVersion: '1.0.0',
        secretRef: 'SHOPIFY_STOREFRONT_TOKEN',
      },
    ]);
    await expect(
      compiled.connectors[0]?.invoke({
        operation: 'search_products',
        args: { query: 'shoes' },
        credential: { token: 'not-used-in-fake-mode' },
      }),
    ).resolves.toEqual({ items: ['one', 'two'] });
  });

  it('tracks managed endpoint and origin variables for operator binding', () => {
    const compiled = compileConnectors(
      source({
        mcp: {
          endpoint: '${env.SHOPIFY_MCP_ENDPOINT}',
          allowedOrigins: ['${env.SHOPIFY_STORE_ORIGIN}'],
        },
      }),
      { mode: 'fake' },
    );
    expect(compiled).toMatchObject({
      ok: true,
      variableBindings: ['SHOPIFY_MCP_ENDPOINT', 'SHOPIFY_STORE_ORIGIN'],
    });
  });

  it('requires a separate allowlist for a managed endpoint', () => {
    const compiled = compileConnectors(
      source({ mcp: { endpoint: '${env.SHOPIFY_MCP_ENDPOINT}' } }),
    );
    expect(compiled).toMatchObject({
      ok: false,
      errors: [
        {
          code: 'variable_mcp_endpoint_requires_allowed_origins',
          path: 'connectors.shopify_storefront_mcp.mcp.allowedOrigins',
        },
      ],
    });
  });

  it('rejects insecure endpoints and non-canonical literal origins during compilation', () => {
    const insecure = compileConnectors(
      source({
        mcp: {
          endpoint: 'http://store.example/api/mcp',
          allowedOrigins: ['http://store.example/path'],
        },
      }),
    );
    expect(insecure).toMatchObject({ ok: false });
    if (insecure.ok) return;
    expect(insecure.errors.map((error) => error.message).join('\n')).toMatch(/must use HTTPS/);

    const pathOrigin = compileConnectors(
      source({
        mcp: {
          endpoint: 'https://store.example/api/mcp',
          allowedOrigins: ['https://store.example/path'],
        },
      }),
    );
    expect(pathOrigin).toMatchObject({ ok: false });
    if (pathOrigin.ok) return;
    expect(pathOrigin.errors.map((error) => error.message).join('\n')).toMatch(
      /canonical bare origin/,
    );
  });

  it('rejects delegated upstream OAuth until the consent-broker slice exists', () => {
    const compiled = compileConnectors(
      source({
        mcp: {
          endpoint: 'https://store.example/api/mcp',
          auth: { kind: 'delegatedOAuth', provider: 'shopify' },
        },
      }),
    );
    expect(compiled).toMatchObject({ ok: false });
    if (compiled.ok) return;
    expect(compiled.errors.map((error) => error.message).join('\n')).toMatch(
      /only bearer, apiKey, or clientCredentials/,
    );
  });

  it('rejects external schema references without fetching them', () => {
    const compiled = compileConnectors(
      source({
        operations: {
          unsafe: {
            type: 'read',
            tool: 'unsafe',
            input: {
              type: 'object',
              properties: { value: { $ref: 'https://schemas.example/value.json' } },
            },
            output: resultSchema,
          },
        },
      }),
    );
    expect(compiled).toMatchObject({ ok: false });
    if (compiled.ok) return;
    expect(compiled.errors.map((error) => error.message).join('\n')).toMatch(
      /external JSON Schema references/,
    );
  });

  it('compiles text-only upstream tools to the explicit object fallback contract', async () => {
    const compiled = compileConnectors(
      source({
        mcp: { endpoint: 'https://store.example/api/mcp' },
        operations: {
          store_policy: {
            type: 'read',
            tool: 'store-policy',
            result: 'text',
            input: { type: 'object', properties: {}, additionalProperties: false },
            output: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            fake: { text: 'Returns accepted within 30 days.' },
          },
        },
      }),
      { mode: 'fake' },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    await expect(
      compiled.connectors[0]?.invoke({
        operation: 'store_policy',
        args: {},
        credential: { token: 'unused' },
      }),
    ).resolves.toEqual({ text: 'Returns accepted within 30 days.' });
  });

  it('emits a client-credentials broker exchange and presents its result as bearer auth', () => {
    const compiled = compileConnectors(
      source({
        mcp: {
          endpoint: 'https://store.example/api/mcp',
          allowedOrigins: ['https://store.example', 'https://id.example'],
          auth: {
            kind: 'clientCredentials',
            tokenUrl: 'https://id.example/oauth/token',
            clientId: 'shopify-partner-client',
            clientSecret: 'SHOPIFY_PARTNER_SECRET',
            scopes: ['catalog:read'],
          },
        },
      }),
    );
    expect(compiled).toMatchObject({
      ok: true,
      secretBindings: [
        {
          secretRef: 'SHOPIFY_PARTNER_SECRET',
          authKind: 'clientCredentials',
          clientCredentials: {
            profile: 'oauth2',
            tokenUrl: 'https://id.example/oauth/token',
            clientId: 'shopify-partner-client',
            scopes: ['catalog:read'],
          },
        },
      ],
    });
  });

  it('fails fake execution when an operation has no deterministic response', async () => {
    const compiled = compileConnectors(
      source({
        mcp: { endpoint: 'https://store.example/api/mcp' },
        operations: {
          search_products: {
            type: 'read',
            tool: 'search-products',
            input: objectSchema,
            output: resultSchema,
          },
        },
      }),
      { mode: 'fake' },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const error = await compiled.connectors[0]
      ?.invoke({
        operation: 'search_products',
        args: { query: 'shoes' },
        credential: { token: 'unused' },
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ConnectorInvocationError);
    expect(error).toMatchObject({ category: 'invalid_response', retryable: false });
  });
});
