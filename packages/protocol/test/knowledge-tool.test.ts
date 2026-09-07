import { ErrorCode, type McpError } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { KnowledgeSearchPort } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { buildDeps, connectClientTo, resolvedArtifact } from './harness.js';
import { connectV2Client, createTestDualEraHandler, testServedArtifact } from './v2-harness.js';

/**
 * The generated `search_<name>` tool (ADR 0202 D4) projected through both MCP eras from one
 * artifact. Gate off ⇒ the tool is absent from listing, not merely refused at call time.
 */

const HITS = [
  {
    id: 'doc:a.md#0',
    title: 'Pricing guide',
    excerpt: 'alpha document about pricing plans',
    sourceKind: 'document' as const,
  },
];

function withKnowledge(artifact: RuntimeArtifact = resolvedArtifact()): RuntimeArtifact {
  return {
    ...artifact,
    server: {
      ...artifact.server,
      knowledge: [
        {
          name: 'product',
          title: 'Product knowledge',
          description: 'Public product information.',
          documents: [{ path: 'a.md', title: 'Pricing guide', sha256: 'a'.repeat(64), bytes: 10 }],
          sites: [],
          generatedTool: {
            name: 'search_product',
            description: 'Search Product knowledge.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', minLength: 1, maxLength: 2000 },
                limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
              },
              required: ['query'],
              additionalProperties: false,
            },
            outputSchema: { type: 'object' },
          },
        },
      ],
    },
  };
}

function port(overrides?: Partial<KnowledgeSearchPort>): KnowledgeSearchPort {
  return {
    enabled: async () => true,
    search: async () => ({ ok: true, hits: HITS }),
    ...overrides,
  };
}

describe('generated knowledge search tool (legacy era)', () => {
  it('lists and calls search_<name> when the port is enabled', async () => {
    const client = await connectClientTo({
      artifact: withKnowledge(),
      deps: { ...buildDeps(), knowledgeSearch: port() },
    });
    const list = await client.listTools();
    expect(list.tools.find((tool) => tool.name === 'search_product')).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    const result = await client.callTool({
      name: 'search_product',
      arguments: { query: 'pricing' },
    });
    expect(result.structuredContent).toMatchObject({ hits: [{ title: 'Pricing guide' }] });
  });

  it('omits the tool from listing when the gate is off or the port is absent', async () => {
    const gateOff = await connectClientTo({
      artifact: withKnowledge(),
      deps: { ...buildDeps(), knowledgeSearch: port({ enabled: async () => false }) },
    });
    expect((await gateOff.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'search_product',
    );
    const noPort = await connectClientTo({ artifact: withKnowledge(), deps: buildDeps() });
    expect((await noPort.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'search_product',
    );
    await expect(
      noPort.callTool({ name: 'search_product', arguments: { query: 'pricing' } }),
    ).rejects.toThrow(/no tool named/i);
  });

  it('rejects invalid arguments with InvalidParams', async () => {
    const client = await connectClientTo({
      artifact: withKnowledge(),
      deps: { ...buildDeps(), knowledgeSearch: port() },
    });
    try {
      await client.callTool({ name: 'search_product', arguments: {} });
      expect.unreachable('missing query must fail');
    } catch (error) {
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
    }
  });

  it('maps a blocked budget to a typed error, never a degraded answer', async () => {
    const client = await connectClientTo({
      artifact: withKnowledge(),
      deps: {
        ...buildDeps(),
        knowledgeSearch: port({
          search: async () => ({
            ok: false,
            reason: 'budget_exhausted',
            message: 'monthly search budget exhausted',
          }),
        }),
      },
    });
    await expect(
      client.callTool({ name: 'search_product', arguments: { query: 'pricing' } }),
    ).rejects.toThrow(/budget/i);
  });
});

describe('generated knowledge search tool (2026-07-28 era)', () => {
  it('lists and calls the same generated tool from one artifact', async () => {
    const handler = createTestDualEraHandler(
      {
        ...testServedArtifact(withKnowledge),
        deps: { ...buildDeps(), knowledgeSearch: port() },
      },
      {},
    );
    const { client, close } = await connectV2Client(handler, 'pinned-modern');
    try {
      const list = await client.listTools();
      expect(list.tools.find((tool) => tool.name === 'search_product')).toMatchObject({
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
      const result = await client.callTool({
        name: 'search_product',
        arguments: { query: 'pricing' },
      });
      expect(result.structuredContent).toMatchObject({ hits: [{ title: 'Pricing guide' }] });
    } finally {
      await close();
    }
  });
});
