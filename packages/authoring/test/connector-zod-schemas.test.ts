import { computeSignatureHash } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../../connector-defs/src/index.js';
import { connector, server, tool, z } from '../src/index.js';

// Zod-authored connector operation signatures (ADR 0139, Slice 2a): builders accept z.ZodType for
// operation input/output, convert through the same toJsonSchema seam tools use, and emit catalogs
// whose signatures hash identically to the compiled catalog's.

function weatherConnector() {
  return connector('geo')
    .version('1.0.0')
    .http({
      baseUrl: 'https://geo.example.com',
      allowedOrigins: ['https://geo.example.com'],
      operations: {
        search: {
          type: 'read',
          method: 'GET',
          path: '/v1/search',
          query: ['name'],
          input: z.object({ name: z.string() }),
          output: z.object({
            latitude: z.number(),
            longitude: z.number(),
            place: z.string().optional(),
          }),
          response: {
            latitude: '${response.results[0].latitude}',
            longitude: '${response.results[0].longitude}',
            place: '${response.results[0].name}',
          },
        },
      },
    });
}

describe('Zod-authored operation signatures', () => {
  it('emits a closed object schema with required from Zod optionality (io projection)', () => {
    const sig = weatherConnector().operations.search;
    expect(sig?.input).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    });
    expect(sig?.output).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['latitude', 'longitude']),
      additionalProperties: false,
    });
    expect((sig?.output as { required?: string[] }).required).not.toContain('place');
  });

  it('drops .default() fields from required on the input side', () => {
    const c = connector('d')
      .version('1.0.0')
      .compute('op', {
        input: z.object({ a: z.string(), b: z.number().default(3) }),
        output: z.object({ ok: z.boolean() }),
        run: (input) => ({ ok: Boolean(input.a) }),
      });
    const input = c.operations.op?.input as { required?: string[] };
    expect(input.required).toEqual(['a']);
  });

  it('passes raw JSON Schema through verbatim (plus closed-by-default normalization)', () => {
    const c = connector('raw')
      .version('1.0.0')
      .compute('op', {
        input: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
          required: ['mode'],
        },
        run: () => ({}),
      });
    expect(c.operations.op?.input).toEqual({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
      required: ['mode'],
      additionalProperties: false,
    });
  });

  it('rejects a non-object Zod input at author time', () => {
    expect(() =>
      connector('bad')
        .version('1.0.0')
        .compute('op', { input: z.string(), run: () => ({}) }),
    ).toThrow(/object/i);
  });

  it('rejects the retired flat field-map form at author time (ADR 0139)', () => {
    expect(() =>
      connector('legacy')
        .version('1.0.0')
        .compute('op', {
          // The retired shape is structurally a JsonSchema record, so it type-checks; the
          // builder must reject it at runtime with a precise error.
          input: { id: { type: 'string', required: true } },
          run: () => ({}),
        }),
    ).toThrow(/retired field-map/);
  });

  it('builder signatures hash identically to the compiled catalog signatures', () => {
    const app = server(
      'weather',
      { title: 'Weather', version: '1.0.0', use: { geo: weatherConnector() } },
      [
        tool('lookup', {
          description: 'Look up a place.',
          input: z.object({ city: z.string() }),
          output: z.object({ latitude: z.number() }),
          fulfil: ({ input, connectors }) => {
            const located = connectors.geo.search({ name: input.city });
            return { latitude: located.latitude };
          },
        }),
      ],
    );
    const doc = app.toConnectorCatalog();
    expect(doc).toBeDefined();
    const compiled = compileConnectors(JSON.stringify(doc));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const compiledSig = compiled.catalog[0]?.operations.search;
    const builderSig = weatherConnector().operations.search;
    if (!compiledSig || !builderSig) throw new Error('expected signatures');
    expect(computeSignatureHash('search', compiledSig)).toBe(
      computeSignatureHash('search', builderSig),
    );
  });

  it('emitted schema snapshot (tripwire: a zod upgrade changing toJSONSchema output moves hashes)', () => {
    const sig = weatherConnector().operations.search;
    expect(sig?.input).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "name": {
            "type": "string",
          },
        },
        "required": [
          "name",
        ],
        "type": "object",
      }
    `);
  });
});
