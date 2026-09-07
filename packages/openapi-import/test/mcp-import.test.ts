import { createMcpHandler, type McpHttpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  diffSnapshots,
  parseMcpImportSnapshot,
  probeMcpServer,
  renderMcpServerSource,
  snapshotFromTools,
} from '../src/index.js';

const handlers: McpHttpHandler[] = [];

afterEach(async () => {
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
});

function fixtureFetch(observed: { authorization?: string }) {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'import-fixture', version: '1.0.0' },
      { supportedProtocolVersions: ['2026-07-28', '2025-11-25'] },
    );
    server.registerTool(
      'search-products',
      {
        description: 'Search the current storefront catalog.',
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ items: z.array(z.object({ handle: z.string() })) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async () => ({ structuredContent: { items: [] }, content: [] }),
    );
    server.registerTool(
      'cartCreate',
      {
        description: 'Create a cart.',
        inputSchema: z.object({ merchandiseId: z.string() }),
        outputSchema: z.object({ cartId: z.string() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async () => ({ structuredContent: { cartId: 'cart-1' }, content: [] }),
    );
    return server;
  });
  handlers.push(handler);
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    observed.authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    return handler.fetch(new Request(url, init));
  };
}

describe('MCP import', () => {
  it('discovers both eras through the official SDK and freezes only tool contracts', async () => {
    const observed: { authorization?: string } = {};
    const snapshot = await probeMcpServer({
      endpoint: 'http://127.0.0.1/mcp',
      name: 'shopify-storefront',
      headers: { authorization: 'Bearer import-only-secret' },
      auth: { kind: 'bearer', secretRef: 'SHOPIFY_STOREFRONT_TOKEN' },
      fetch: fixtureFetch(observed),
    });

    expect(observed.authorization).toBe('Bearer import-only-secret');
    expect(snapshot).toMatchObject({
      formatVersion: 1,
      connectorId: 'shopify_storefront',
      endpointVariable: 'SHOPIFY_STOREFRONT_MCP_ENDPOINT',
      originVariable: 'SHOPIFY_STOREFRONT_MCP_ORIGIN',
      auth: { kind: 'bearer', secretRef: 'SHOPIFY_STOREFRONT_TOKEN' },
      tools: [
        { upstreamName: 'cartCreate', operationName: 'cart_create', operationType: 'action' },
        {
          upstreamName: 'search-products',
          operationName: 'search_products',
          operationType: 'action',
          destructive: true,
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('import-only-secret');
    expect(JSON.stringify(snapshot)).not.toContain('_meta');
  });

  it('reports an authentication status without including the upstream body', async () => {
    const failure = await probeMcpServer({
      endpoint: 'http://127.0.0.1/mcp',
      name: 'private',
      fetch: async () =>
        new Response('sensitive authorization explanation', {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/HTTP 401/);
    expect(String(failure)).not.toContain('sensitive authorization explanation');
  });

  it('maps camel, punctuation, prefixes, and collisions deterministically', () => {
    const snapshot = snapshotFromTools({
      endpoint: 'https://mcp.example/mcp',
      name: 'composed',
      prefix: 'store',
      tools: [
        {
          name: 'listIssues',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'list-issues',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    expect(snapshot.tools.map((tool) => tool.operationName)).toEqual([
      'store_list_issues',
      'store_list_issues_2',
    ]);
    expect(
      snapshotFromTools({
        endpoint: 'https://mcp.example/mcp',
        name: 'composed',
        prefix: 'store',
        tools: [...snapshot.tools].reverse().map((tool) => ({
          name: tool.upstreamName,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: true },
        })),
      }).tools.map((tool) => tool.operationName),
    ).toEqual(snapshot.tools.map((tool) => tool.operationName));
  });

  it('defaults missing read annotations to an action requiring author review', () => {
    const snapshot = snapshotFromTools({
      endpoint: 'https://mcp.example/mcp',
      name: 'safe',
      tools: [{ name: 'ambiguous', inputSchema: { type: 'object', properties: {} } }],
    });
    expect(snapshot.tools[0]).toMatchObject({ operationType: 'action', destructive: true });
    expect(snapshot.warnings.join('\n')).toMatch(/conservatively as a confirmed action/);
  });

  it('treats all upstream annotation hints as untrusted until author review', () => {
    const snapshot = snapshotFromTools({
      endpoint: 'https://mcp.example/mcp',
      name: 'safe',
      tools: [
        {
          name: 'claimed-read',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: 'claimed-safe-action',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      ],
    });
    expect(
      snapshot.tools.map(({ operationName, destructive }) => ({ operationName, destructive })),
    ).toEqual([
      { operationName: 'claimed_read', destructive: true },
      { operationName: 'claimed_safe_action', destructive: true },
    ]);
    expect(snapshot.tools.every((tool) => tool.operationType === 'action')).toBe(true);
    expect(snapshot.warnings.join('\n')).toMatch(/claims readOnlyHint/);
  });

  it('rejects external references, non-object roots, and oversized tool inventories', () => {
    expect(() =>
      snapshotFromTools({
        endpoint: 'https://mcp.example/mcp',
        name: 'unsafe',
        tools: [
          {
            name: 'external',
            inputSchema: {
              type: 'object',
              properties: { value: { $ref: 'https://schemas.example/value.json' } },
            },
          },
        ],
      }),
    ).toThrow(/external \$ref/);
    expect(() =>
      snapshotFromTools({
        endpoint: 'https://mcp.example/mcp',
        name: 'unsafe',
        tools: [{ name: 'array', inputSchema: { type: 'array', items: {} } }],
      }),
    ).toThrow(/object top-level type/);
    expect(() =>
      snapshotFromTools({
        endpoint: 'https://mcp.example/mcp',
        name: 'too_many',
        tools: Array.from({ length: 257 }, (_, index) => ({
          name: `tool-${index}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      }),
    ).toThrow(/more than 256 tools/);
    expect(() =>
      snapshotFromTools({
        endpoint: 'https://mcp.example/mcp',
        name: 'unsafe',
        tools: [
          {
            name: `tool-${'x'.repeat(257)}`,
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
    ).toThrow(/1-256 non-control characters/);
  });

  it('renders byte-stable TypeScript with managed bindings and confirmed actions', () => {
    const snapshot = snapshotFromTools({
      endpoint: 'https://shop.example/api/mcp',
      name: 'shopify',
      auth: { kind: 'apiKey', header: 'x-shopify-storefront-access-token', secretRef: 'TOKEN' },
      tools: [
        {
          name: 'search-products',
          description: 'Search products.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          outputSchema: { type: 'object', properties: { items: { type: 'array' } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'cartCreate',
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object', properties: { cartId: { type: 'string' } } },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      ],
    });
    const source = renderMcpServerSource(snapshot);
    expect(renderMcpServerSource(snapshot)).toBe(source);
    expect(source).toContain('.mcp({');
    expect(source).toContain('title: "Search Products"');
    expect(source).toContain('secret("TOKEN")');
    expect(source).not.toContain('annotations.readOnly');
    expect(source).toContain('annotations.openAction({ destructive: true, confirm: true })');
    expect(source).not.toContain(snapshot.endpoint);
  });

  it('reports stable added, removed, and changed drift without mutating either snapshot', () => {
    const make = (tools: Parameters<typeof snapshotFromTools>[0]['tools']) =>
      snapshotFromTools({ endpoint: 'https://mcp.example/mcp', name: 'drift', tools });
    const before = make([
      {
        name: 'same',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'removed',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);
    const after = make([
      {
        name: 'same',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'added',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);
    expect(diffSnapshots(before, after)).toEqual({
      changed: true,
      lines: [
        'additive: added tool: added',
        'breaking: removed tool: removed',
        'breaking: changed tool: same',
      ],
    });
    expect(diffSnapshots(before, before)).toEqual({ changed: false, lines: [] });
    const descriptionOnly = {
      ...before,
      tools: before.tools.map((tool) =>
        tool.upstreamName === 'same' ? { ...tool, description: 'Updated help text.' } : tool,
      ),
    };
    expect(diffSnapshots(before, descriptionOnly)).toEqual({
      changed: true,
      lines: ['metadata-only: changed tool: same'],
    });
    expect(parseMcpImportSnapshot(JSON.parse(JSON.stringify(before)))).toEqual(before);
    expect(() =>
      parseMcpImportSnapshot({
        ...before,
        tools: [{ ...before.tools[0], operationName: '../../escape' }],
      }),
    ).toThrow(/operationName is invalid/);
  });
});
