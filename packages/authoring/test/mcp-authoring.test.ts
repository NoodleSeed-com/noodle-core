import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../../connector-defs/src/index.js';
import { connector, secret, server, tool, variable, z } from '../src/index.js';

function shopifyMcp() {
  return connector('shopify_storefront_mcp')
    .version('1.0.0')
    .mcp({
      endpoint: variable('SHOPIFY_MCP_ENDPOINT'),
      allowedOrigins: [variable('SHOPIFY_STORE_ORIGIN')],
      auth: { kind: 'bearer', secret: secret('SHOPIFY_STOREFRONT_TOKEN') },
      operations: {
        search_products: {
          type: 'read',
          tool: 'search-products',
          input: z.object({ query: z.string() }),
          output: z.object({ items: z.array(z.object({ handle: z.string(), title: z.string() })) }),
          fake: {
            structuredContent: {
              items: [{ handle: 'classic-tee', title: 'Classic Tee' }],
            },
          },
        },
      },
    });
}

describe('.mcp() authoring', () => {
  it('emits managed endpoint/origin refs, secret refs, wire names, and canonical schemas', () => {
    const shopify = shopifyMcp();
    expect(shopify.mcpDef).toMatchObject({
      id: 'shopify_storefront_mcp',
      version: '1.0.0',
      kind: 'custom',
      mcp: {
        endpoint: '${env.SHOPIFY_MCP_ENDPOINT}',
        allowedOrigins: ['${env.SHOPIFY_STORE_ORIGIN}'],
        auth: { kind: 'bearer', secret: 'SHOPIFY_STOREFRONT_TOKEN' },
      },
      operations: {
        search_products: {
          type: 'read',
          tool: 'search-products',
          result: 'structured',
          input: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            required: ['items'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(shopify.operations.search_products).toEqual({
      type: 'read',
      input: shopify.mcpDef?.operations.search_products.input,
      output: shopify.mcpDef?.operations.search_products.output,
    });
  });

  it('emits through server use and compiles to the runtime in fake mode', async () => {
    const app = server(
      'shopify-assistant',
      { title: 'Shopify Assistant', version: '1.0.0', use: { shopify: shopifyMcp() } },
      [
        tool('search_store', {
          description: 'Search products.',
          input: z.object({ query: z.string() }),
          fulfil: ({ input, connectors }) =>
            connectors.shopify.search_products({ query: input.query }),
        }),
      ],
    );
    const catalog = app.toConnectorCatalog();
    expect(catalog?.connectors[0]).toHaveProperty('mcp');
    const compiled = compileConnectors(JSON.stringify(catalog), { mode: 'fake' });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    await expect(
      compiled.connectors[0]?.invoke({
        operation: 'search_products',
        args: { query: 'tee' },
        credential: { token: 'unused' },
      }),
    ).resolves.toEqual({ items: [{ handle: 'classic-tee', title: 'Classic Tee' }] });
  });

  it('gives a text-only upstream tool the canonical text object output by default', () => {
    const policies = connector('policies')
      .version('1.0.0')
      .mcp({
        endpoint: 'https://store.example/api/mcp',
        operations: {
          return_policy: {
            type: 'read',
            tool: 'return-policy',
            result: 'text',
            input: z.object({}),
            fake: { text: 'Returns accepted within 30 days.' },
          },
        },
      });
    expect(policies.operations.return_policy?.output).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    });
  });

  it('rejects delegated upstream OAuth and inline credential values at author time', () => {
    expect(() =>
      connector('bad')
        .version('1.0.0')
        .mcp({
          endpoint: 'https://store.example/api/mcp',
          auth: { kind: 'delegatedOAuth', provider: 'shopify' } as never,
          operations: {
            list: { type: 'read', tool: 'list', input: z.object({}), output: z.object({}) },
          },
        }),
    ).toThrow(/only bearer, apiKey, or clientCredentials/);

    expect(() =>
      connector('bad')
        .version('1.0.0')
        .mcp({
          endpoint: 'https://store.example/api/mcp',
          auth: { kind: 'bearer', secret: { value: 'plaintext' } as never },
          operations: {
            list: { type: 'read', tool: 'list', input: z.object({}), output: z.object({}) },
          },
        }),
    ).toThrow();
  });

  it('refuses to mix MCP with HTTP or compute on one connector', () => {
    const mcp = connector('mixed')
      .version('1.0.0')
      .mcp({
        endpoint: 'https://store.example/api/mcp',
        operations: {
          list: { type: 'read', tool: 'list', input: z.object({}), output: z.object({}) },
        },
      });
    expect(() =>
      mcp.http({
        baseUrl: 'https://store.example',
        operations: { list: { type: 'read', path: '/' } },
      }),
    ).toThrow(/one engine/);
    expect(() =>
      mcp.compute('normalize', { input: z.object({}), output: z.object({}), run: () => ({}) }),
    ).toThrow(/MCP or compute/);
  });
});
