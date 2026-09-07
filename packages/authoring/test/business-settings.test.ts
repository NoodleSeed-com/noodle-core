import { describe, expect, it } from 'vitest';
import { compileManifest } from '../../compiler/src/compile.js';
import { server, tool, variable, z } from '../src/index.js';

describe('typed managed business variables', () => {
  it('preserves typed declaration and ordinary variable references without buyer values', async () => {
    const days = variable('DAYS', {
      schema: z
        .array(z.enum(['mon', 'tue']))
        .min(1)
        .max(2),
      default: ['mon'],
      portal: { label: 'Available days', group: 'Scheduling' },
      requiredFor: ['availability'],
    });
    const app = server(
      'business',
      {
        title: 'Business',
        version: '1.0.0',
        variables: [days],
      },
      [
        tool('availability', {
          description: 'Show explicitly projected business availability.',
          input: z.object({}),
          fulfil: () => ({ days, technical: variable('TECHNICAL') }),
        }),
      ],
    );
    const manifest = await app.toManifest();
    expect(manifest.server.variables).toEqual([
      {
        name: 'DAYS',
        schemaVersion: 1,
        valueSchema: expect.objectContaining({ type: 'array', maxItems: 2 }),
        default: ['mon'],
        portal: { label: 'Available days', group: 'Scheduling' },
        requiredFor: ['availability'],
      },
    ]);
    expect(manifest.tools[0]?.fulfilment.output).toEqual({
      days: '${env.DAYS}',
      technical: '${env.TECHNICAL}',
    });
    const result = compileManifest(manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.variables?.[0]).toMatchObject({
      name: 'DAYS',
      schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.artifact.config?.variables).toEqual(['DAYS', 'TECHNICAL']);
  });

  it('requires explicit declarations and rejects invalid defaults and unsupported Zod schemas', () => {
    expect(() =>
      variable('COUNT', { schema: z.number().int().min(1).max(10), default: 11 }),
    ).toThrow(/default/);
    expect(() => variable('UNBOUNDED', { schema: z.string() })).toThrow(/maxLength/);
    expect(() =>
      variable('REFINED', {
        schema: z
          .string()
          .max(50)
          .refine((value) => value === 'safe'),
      }),
    ).toThrow(/refinements/);
    expect(() => variable('TRANSFORM', { schema: z.string().max(50).trim() })).toThrow(
      /transforms/,
    );
    expect(() =>
      variable('CODE', { schema: z.string().transform((value) => value.length) }),
    ).toThrow();
  });

  it('keeps declarations scoped to each application without a global registry', async () => {
    const first = variable('GREETING', {
      schema: z.string().max(50),
      default: 'Hello',
      portal: { label: 'Greeting' },
    });
    const second = variable('GREETING', {
      schema: z.string().max(50),
      default: 'Welcome',
      portal: { label: 'Greeting' },
    });
    const action = tool('ping', {
      description: 'Return health.',
      input: z.object({}),
      fulfil: () => ({ ok: true }),
    });
    const a = await server('first', { title: 'First', version: '1', variables: [first] }, [
      action,
    ]).toManifest();
    const b = await server('second', { title: 'Second', version: '1', variables: [second] }, [
      action,
    ]).toManifest();
    expect(a.server.variables?.[0]?.default).toBe('Hello');
    expect(b.server.variables?.[0]?.default).toBe('Welcome');
  });
});
