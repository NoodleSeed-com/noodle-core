import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import {
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
  MapServiceBroker,
} from '../../runtime/src/index.js';
import { server, tool, z } from '../src/index.js';

// Regression coverage for the flat-output limitation: tool fulfilment used to throw
// "nested objects/arrays are not supported as mapping values in this phase", forcing real
// list-shaped apps (carousels, search results, product grids) to flatten their output into
// scalar fields like `primaryName`/`secondaryName`. Arrays and nested objects are the natural
// output shape for tools and widget props, so recording, compile, and execute must carry them.

/** Compile an authored server and execute one tool through the real runtime (no connectors). */
async function execute(
  app: { toManifest(): Promise<unknown> },
  name: string,
  input: unknown,
): Promise<unknown> {
  const manifest = await app.toManifest();
  const compiled = compileManifest(manifest, { catalog: new InMemoryCatalog([]) });
  if (!compiled.ok) throw new Error(`manifest compile failed: ${JSON.stringify(compiled.errors)}`);
  const deps: ExecuteDeps = {
    connectors: new InMemoryConnectorRegistry([]),
    broker: new MapServiceBroker(new Map()),
  };
  return executeTool(compiled.artifact, name, input, deps);
}

describe('nested tool output', () => {
  it('carries a literal array of objects (the carousel shape)', async () => {
    const app = server('s', { title: 'S', version: '1.0.0' }, [
      tool('list_destinations', {
        description: 'List destinations.',
        input: z.object({}),
        output: z.object({
          destinations: z.array(
            z.object({ name: z.string(), country: z.string(), priceLevel: z.number() }),
          ),
        }),
        fulfil: () => ({
          destinations: [
            { name: 'Lisbon', country: 'Portugal', priceLevel: 2 },
            { name: 'Kyoto', country: 'Japan', priceLevel: 3 },
          ],
        }),
      }),
    ]);
    const result = await execute(app, 'list_destinations', {});
    expect(result).toEqual({
      ok: true,
      output: {
        destinations: [
          { name: 'Lisbon', country: 'Portugal', priceLevel: 2 },
          { name: 'Kyoto', country: 'Japan', priceLevel: 3 },
        ],
      },
    });
  });

  it('substitutes input refs inside nested structures', async () => {
    const app = server('s', { title: 'S', version: '1.0.0' }, [
      tool('echo_pick', {
        description: 'Echo the pick.',
        input: z.object({ name: z.string(), month: z.string() }),
        output: z.object({
          picks: z.array(z.object({ name: z.string(), month: z.string(), rank: z.number() })),
          meta: z.object({ total: z.number() }),
        }),
        fulfil: ({ input }) => ({
          picks: [{ name: input.name, month: input.month, rank: 1 }],
          meta: { total: 1 },
        }),
      }),
    ]);
    const result = await execute(app, 'echo_pick', { name: 'Lisbon', month: 'May' });
    expect(result).toEqual({
      ok: true,
      output: { picks: [{ name: 'Lisbon', month: 'May', rank: 1 }], meta: { total: 1 } },
    });
  });

  it('carries a nested object literal', async () => {
    const app = server('s', { title: 'S', version: '1.0.0' }, [
      tool('summary', {
        description: 'Summarize.',
        input: z.object({}),
        output: z.object({ summary: z.object({ count: z.number(), top: z.string() }) }),
        fulfil: () => ({ summary: { count: 2, top: 'Lisbon' } }),
      }),
    ]);
    const result = await execute(app, 'summary', {});
    expect(result).toEqual({ ok: true, output: { summary: { count: 2, top: 'Lisbon' } } });
  });

  it('still rejects unserializable values in tool output', async () => {
    await expect(
      server('s', { title: 'S', version: '1.0.0' }, [
        tool('bad', {
          description: 'x',
          input: z.object({}),
          output: z.object({ f: z.string() }),
          fulfil: () => ({ f: (() => 'nope') as unknown as string }),
        }),
      ]).toManifest(),
    ).rejects.toThrow(/cannot serialize function/);
  });
});
