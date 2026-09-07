import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
  MapServiceBroker,
} from '../../runtime/src/index.js';
import { connector, server, tool, z } from '../src/index.js';

const catalog = connector('catalog_upstream')
  .version('1.0.0')
  .mcp({
    endpoint: 'https://catalog.example/mcp',
    operations: {
      search: {
        type: 'read',
        tool: 'search-catalog',
        input: z.object({ term: z.string(), limit: z.number().int().min(1).max(10) }),
        output: z.object({ items: z.array(z.object({ name: z.string(), price: z.number() })) }),
        fake: { structuredContent: { items: [{ name: 'Trail mug', price: 18 }] } },
      },
    },
  });

const policies = connector('policy_upstream')
  .version('1.0.0')
  .mcp({
    endpoint: 'https://policies.example/mcp',
    operations: {
      answer: {
        type: 'read',
        tool: 'policy.answer',
        result: 'text',
        input: z.object({ question: z.string() }),
        fake: { text: 'Returns are accepted within 30 days.' },
      },
    },
  });

const composition = connector('composition')
  .version('1.0.0')
  .compute('shopper_result', {
    input: z.object({
      items: z.array(z.object({ name: z.string(), price: z.number() })),
      policy: z.string(),
    }),
    output: z.object({ cards: z.array(z.string()), policy: z.string() }),
    run: (input) => ({
      cards: input.items.map(
        (item: { name: string; price: number }) => `${item.name}: $${item.price}`,
      ),
      policy: input.policy.slice(0, 500),
    }),
  });

const findProducts = tool('find_store_products', {
  title: 'Find store products',
  description:
    'Search a curated upstream catalog, combine it with a second upstream policy answer, and show a stable local view.',
  input: z.object({ query: z.string() }),
  output: z.object({ cards: z.array(z.string()), policy: z.string() }),
  fulfil: ({ input, connectors }) => {
    const found = connectors.catalog.search({ term: input.query, limit: 2 });
    const policy = connectors.policies.answer({ question: 'What is the return policy?' });
    const result = connectors.compose.shopper_result({ items: found.items, policy: policy.text });
    return { cards: result.cards, policy: result.policy };
  },
  view: { html: '<main id="root">Curated Noodle view</main>' },
  viewTitle: 'Store products',
  viewDescription: 'A Noodle-owned view over two headless upstream MCP servers.',
});

const refreshProducts = tool('refresh_store_products', {
  visibility: ['app'],
  description: 'App-only helper for refreshing the curated store view.',
  input: z.object({ query: z.string() }),
  output: z.object({ items: z.array(z.object({ name: z.string(), price: z.number() })) }),
  fulfil: ({ input, connectors }) => {
    const result = connectors.catalog.search({ term: input.query, limit: 2 });
    return { items: result.items };
  },
});

const app = server(
  'mcp_composition',
  {
    title: 'MCP composition fixture',
    version: '1.0.0',
    use: { catalog, policies, compose: composition },
  },
  [findProducts, refreshProducts],
);

async function compiledFixture() {
  const connectorCatalog = app.toConnectorCatalog();
  if (connectorCatalog === undefined) throw new Error('expected connector catalog');
  const connectors = compileConnectors(JSON.stringify(connectorCatalog), { mode: 'fake' });
  if (!connectors.ok) throw new Error(JSON.stringify(connectors.errors));
  const compiled = compileManifest(await app.toManifest(), {
    catalog: new InMemoryCatalog(connectors.catalog),
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const deps: ExecuteDeps = {
    connectors: new InMemoryConnectorRegistry(connectors.connectors),
    broker: new MapServiceBroker(new Map()),
  };
  return { compiled, deps };
}

describe('curated MCP composition end to end', () => {
  it('executes two frozen upstreams plus compute behind one renamed outward tool', async () => {
    const { compiled, deps } = await compiledFixture();
    await expect(
      executeTool(compiled.artifact, 'find_store_products', { query: 'mug' }, deps),
    ).resolves.toEqual({
      ok: true,
      output: {
        cards: ['Trail mug: $18'],
        policy: 'Returns are accepted within 30 days.',
      },
    });
  });

  it('publishes only Noodle contracts, a Noodle view, and an app-only helper', async () => {
    const manifest = (await app.toManifest()) as {
      readonly tools: readonly { readonly name: string; readonly visibility?: readonly string[] }[];
      readonly widgets?: readonly { readonly tool: string; readonly html: string }[];
    };
    const serialized = JSON.stringify(manifest);
    expect(manifest.tools.map((entry) => entry.name)).toEqual([
      'find_store_products',
      'refresh_store_products',
    ]);
    expect(manifest.tools[1]?.visibility).toEqual(['app']);
    expect(manifest.widgets?.map((widget) => widget.tool)).toEqual(['find_store_products']);
    expect(serialized).not.toContain('search-catalog');
    expect(serialized).not.toContain('policy.answer');
    expect(serialized).not.toContain('tools/list');
    expect(serialized).not.toContain('_meta');
  });
});
