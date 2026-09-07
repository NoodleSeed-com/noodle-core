import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '../../runtime/src/index.js';
import { connector, server, tool, z } from '../src/index.js';

const broker = new StaticServiceBroker({ token: '' });

/** Author a `word_stats` compute server fully in TypeScript. */
function wordStatsApp() {
  const text = connector('text')
    .version('1.0.0')
    .compute('word_stats', {
      input: z.object({ text: z.string(), limit: z.number().optional() }),
      output: z.object({
        total: z.number().optional(),
        unique: z.number().optional(),
        top: z.array(z.unknown()).optional(),
      }),
      run: (input) => {
        const words =
          String(input.text)
            .toLowerCase()
            .match(/[a-z0-9']+/g) || [];
        const counts: Record<string, number> = {};
        for (const w of words) counts[w] = (counts[w] || 0) + 1;
        const top = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, input.limit || 5)
          .map(([word, count]) => ({ word, count }));
        return { total: words.length, unique: Object.keys(counts).length, top };
      },
    });

  return server('text_tools', { title: 'Text Tools', version: '1.0.0', use: { text } }, [
    tool('word_stats', {
      description: 'Count words and return the most frequent ones.',
      input: z.object({ text: z.string(), limit: z.number().optional() }),
      fulfil({ input, connectors }) {
        const r = connectors.text.wordStats({ text: input.text, limit: input.limit });
        return { total: r.total, unique: r.unique, top: r.top };
      },
    }),
  ]);
}

describe('authoring compute connectors', () => {
  it('emits a connector catalog with the serialized code', () => {
    const catalog = wordStatsApp().toConnectorCatalog();
    expect(catalog).toBeDefined();
    const op = catalog?.connectors[0]?.operations.word_stats;
    expect(catalog?.connectors[0]).toMatchObject({ id: 'text', version: '1.0.0', kind: 'custom' });
    expect(op?.type).toBe('read');
    // Zod authoring emits the canonical closed JSON Schema (ADR 0139).
    expect(op?.output).toEqual({
      type: 'object',
      properties: {
        total: { type: 'number' },
        unique: { type: 'number' },
        top: { type: 'array', items: {} },
      },
      additionalProperties: false,
    });
    expect(typeof op?.code).toBe('string');
    expect(op?.code).toContain('match(/[a-z0-9');
  });

  it('returns undefined when there are no compute operations', () => {
    const app = server('plain', { title: 'Plain', version: '1.0.0' }, [
      tool('noop', {
        description: 'returns a constant',
        input: z.object({}),
        fulfil: () => ({ ok: 'yes' }),
      }),
    ]);
    expect(app.toConnectorCatalog()).toBeUndefined();
  });

  it('round-trips: authored manifest + emitted catalog run through the runtime', async () => {
    const app = wordStatsApp();
    const manifest = await app.toManifest();
    const catalog = app.toConnectorCatalog();
    if (!catalog) throw new Error('expected a catalog');

    const cc = compileConnectors(JSON.stringify(catalog));
    if (!cc.ok) throw new Error(`connector compile failed: ${JSON.stringify(cc.errors)}`);

    const compiled = compileManifest(manifest, { catalog: new InMemoryCatalog(cc.catalog) });
    if (!compiled.ok)
      throw new Error(`manifest compile failed: ${JSON.stringify(compiled.errors)}`);

    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry(cc.connectors),
      broker,
    };
    const result = await executeTool(
      compiled.artifact,
      'word_stats',
      { text: 'a b a c a b', limit: 2 },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      output: {
        total: 6,
        unique: 3,
        top: [
          { word: 'a', count: 3 },
          { word: 'b', count: 2 },
        ],
      },
    });
  });

  it('emits callOperation declarations and runs a compute handler through the runtime', async () => {
    const text = connector('text')
      .version('1.0.0')
      .compute('shout', {
        input: z.object({ s: z.string() }),
        output: z.object({ loud: z.string().optional() }),
        run: (input) => ({ loud: String(input.s).toUpperCase() }),
      });
    const wrapper = connector('wrapper')
      .version('1.0.0')
      .compute('decorate', {
        input: z.object({ s: z.string() }),
        output: z.object({ decorated: z.string().optional() }),
        calls: { shout: 'text.shout' },
        run: (input, { callOperation }) => {
          const result = callOperation('shout', { s: input.s }) as { loud: string };
          return { decorated: `[${result.loud}]` };
        },
      });

    const app = server(
      'decorator',
      { title: 'Decorator', version: '1.0.0', use: { text, wrapper } },
      [
        tool('decorate', {
          description: 'Decorate uppercased text.',
          input: z.object({ s: z.string() }),
          fulfil: ({ input, connectors }) => {
            connectors.text.shout({ s: input.s });
            const r = connectors.wrapper.decorate({ s: input.s });
            return { decorated: r.decorated };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();
    const catalog = app.toConnectorCatalog();
    if (!catalog) throw new Error('expected a catalog');
    expect(catalog.connectors[1]?.operations.decorate?.calls).toEqual({ shout: 'text.shout' });

    const cc = compileConnectors(JSON.stringify(catalog));
    if (!cc.ok) throw new Error(`connector compile failed: ${JSON.stringify(cc.errors)}`);
    const compiled = compileManifest(manifest, { catalog: new InMemoryCatalog(cc.catalog) });
    if (!compiled.ok)
      throw new Error(`manifest compile failed: ${JSON.stringify(compiled.errors)}`);

    const result = await executeTool(
      compiled.artifact,
      'decorate',
      { s: 'hello' },
      { connectors: new InMemoryConnectorRegistry(cc.connectors), broker },
    );
    expect(result).toEqual({ ok: true, output: { decorated: '[HELLO]' } });
  });

  it('promotes an object-method-shorthand handler to a runnable function expression', async () => {
    const echo = connector('echo')
      .version('1.0.0')
      // method shorthand: `run(input) { ... }` — not an expression on its own
      .compute('shout', {
        input: z.object({ s: z.string() }),
        output: z.object({ loud: z.string().optional() }),
        run(input) {
          return { loud: String(input.s).toUpperCase() };
        },
      });
    const catalog = echo.toConnectorCatalog?.() as never;
    void catalog;

    const doc = server('echoer', { title: 'Echoer', version: '1.0.0', use: { echo } }, [
      tool('shout', {
        description: 'Uppercase a string.',
        input: z.object({ s: z.string() }),
        fulfil: ({ input, connectors }) => {
          const r = connectors.echo.shout({ s: input.s });
          return { loud: r.loud };
        },
      }),
    ]);

    const cat = doc.toConnectorCatalog();
    expect(cat?.connectors[0]?.operations.shout?.code.startsWith('function')).toBe(true);

    const cc = compileConnectors(JSON.stringify(cat));
    if (!cc.ok) throw new Error('connector compile failed');
    const out = await cc.connectors[0]?.invoke({
      operation: 'shout',
      args: { s: 'hi' },
      credential: { token: '' },
    });
    expect(out).toEqual({ loud: 'HI' });
  });
});
