import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { connector, prompt, resource, server, tool, z } from '../src/index.js';

describe('authoring resources/prompts — manifest emission', () => {
  it('emits a static resource as a steps-less flow wrapped in { value }', async () => {
    const app = server('docs_server', { title: 'Docs', version: '1.0.0' }, [
      resource('changelog', {
        uri: 'docs://changelog',
        mimeType: 'text/markdown',
        description: 'Project changelog',
        fulfil: () => '# Changelog',
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.resources).toEqual([
      {
        name: 'changelog',
        uri: 'docs://changelog',
        mimeType: 'text/markdown',
        description: 'Project changelog',
        fulfilment: { steps: [], output: { value: '# Changelog' } },
      },
    ]);
  });

  it('records a connector call inside a templated resource', async () => {
    const orders = connector('orders')
      .version('1.0.0')
      .operation('get_order', {
        type: 'read',
        input: z.object({ id: z.string() }),
        output: z.object({ order: z.record(z.string(), z.unknown()).optional() }),
      });
    const app = server('order_server', { title: 'Orders', version: '1.0.0', use: { orders } }, [
      resource('ticket', {
        uri: 'tickets://{id}',
        fulfil: ({ input, connectors }) => connectors.orders.getOrder({ id: input.id }),
      }),
    ]);
    const manifest = await app.toManifest();
    const resourceEntry = manifest.resources?.[0];
    expect(resourceEntry?.uri).toBe('tickets://{id}');
    expect(resourceEntry?.fulfilment.steps).toEqual([
      { id: 'get_order', use: 'orders.get_order', args: { id: '${input.id}' } },
    ]);
    expect(resourceEntry?.fulfilment.output).toEqual({ value: '${steps.get_order}' });
  });

  it('serializes nested resource returns with symbolic refs', async () => {
    const app = server('docs_server', { title: 'Docs', version: '1.0.0' }, [
      resource('ticket', {
        uri: 'tickets://{id}',
        fulfil: ({ input }) => ({
          text: `Ticket ${input.id}`,
          meta: { id: input.id, tags: ['triage', input.id] },
        }),
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.resources?.[0]?.fulfilment.output).toEqual({
      value: {
        text: 'Ticket ${input.id}',
        meta: { id: '${input.id}', tags: ['triage', '${input.id}'] },
      },
    });
  });

  it('derives prompt arguments from a Zod object and interpolates via a template literal', async () => {
    const app = server('p', { title: 'P', version: '1.0.0' }, [
      prompt('triage', {
        description: 'Triage a ticket',
        arguments: z.object({
          id: z.string().describe('ticket id'),
          note: z.string().optional(),
        }),
        fulfil: ({ input }) => `Triage ticket ${input.id}`,
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.prompts?.[0]).toEqual({
      name: 'triage',
      description: 'Triage a ticket',
      arguments: [
        { name: 'id', description: 'ticket id', required: true },
        { name: 'note', required: false },
      ],
      fulfilment: { steps: [], output: { value: 'Triage ticket ${input.id}' } },
    });
  });

  it('accepts an explicit prompt argument descriptor list', async () => {
    const app = server('p', { title: 'P', version: '1.0.0' }, [
      prompt('summarize', {
        arguments: [{ name: 'topic', required: true }],
        fulfil: ({ input }) => `Summarize ${input.topic}`,
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.prompts?.[0]?.arguments).toEqual([{ name: 'topic', required: true }]);
  });

  it('records a connector call inside a prompt', async () => {
    const orders = connector('orders')
      .version('1.0.0')
      .operation('get_order', {
        type: 'read',
        input: z.object({ id: z.string() }),
        output: z.object({ order: z.record(z.string(), z.unknown()).optional() }),
      });
    const app = server('prompt_server', { title: 'Prompts', version: '1.0.0', use: { orders } }, [
      prompt('summarize', {
        arguments: [{ name: 'id', required: true }],
        fulfil: ({ input, connectors }) => connectors.orders.getOrder({ id: input.id }),
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.prompts?.[0]?.fulfilment.steps).toEqual([
      { id: 'get_order', use: 'orders.get_order', args: { id: '${input.id}' } },
    ]);
    expect(manifest.prompts?.[0]?.fulfilment.output).toEqual({ value: '${steps.get_order}' });
  });

  it('serializes multi-message prompt returns with symbolic refs', async () => {
    const app = server('p', { title: 'P', version: '1.0.0' }, [
      prompt('triage', {
        arguments: z.object({ id: z.string() }),
        fulfil: ({ input }) => [
          { role: 'user', text: `Triage ticket ${input.id}` },
          { role: 'assistant', content: { text: `Loaded ${input.id}` } },
        ],
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.prompts?.[0]?.fulfilment.output).toEqual({
      value: [
        { role: 'user', text: 'Triage ticket ${input.id}' },
        { role: 'assistant', content: { text: 'Loaded ${input.id}' } },
      ],
    });
  });

  it('rejects non-object Zod prompt argument schemas', async () => {
    const app = server('p', { title: 'P', version: '1.0.0' }, [
      prompt('bad', {
        arguments: z.string(),
        fulfil: () => 'bad',
      }),
    ]);
    await expect(app.toManifest()).rejects.toThrow(
      'prompt arguments must be a Zod object or an explicit descriptor list',
    );
  });

  it('rejects non-serializable resource and prompt returns', async () => {
    const resourceApp = server('r', { title: 'R', version: '1.0.0' }, [
      resource('bad', {
        uri: 'docs://bad',
        fulfil: () => undefined,
      }),
    ]);
    await expect(resourceApp.toManifest()).rejects.toThrow(
      'cannot serialize undefined from a resource/prompt fulfilment',
    );

    const promptApp = server('p', { title: 'P', version: '1.0.0' }, [
      prompt('bad', {
        fulfil: () => () => 'nope',
      }),
    ]);
    await expect(promptApp.toManifest()).rejects.toThrow(
      'cannot serialize function from a resource/prompt fulfilment',
    );
  });
});

describe('authoring resources/prompts — compiles cleanly', () => {
  it('an authored server with a resource and a prompt compiles to a resolved artifact', async () => {
    // Execution of the compiled output is covered in the compiler/runtime/protocol suites; here we only
    // assert the authored manifest is well-formed enough to compile (no catalog connectors needed).
    const app = server('docs_server', { title: 'Docs', version: '1.0.0' }, [
      tool('noop', {
        description: 'no-op',
        input: z.object({}),
        fulfil: () => ({ ok: 'true' }),
      }),
      resource('changelog', { uri: 'docs://changelog', fulfil: () => '# Changelog' }),
      prompt('triage', {
        arguments: z.object({ id: z.string() }),
        fulfil: ({ input }) => `Triage ticket ${input.id}`,
      }),
    ]);

    const compiled = compileManifest(await app.toManifest(), { catalog: new InMemoryCatalog([]) });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.capabilities.resources).toEqual(['changelog']);
    expect(compiled.artifact.capabilities.prompts).toEqual(['triage']);
  });

  it('rejects a resource fulfil that returns the { contents: [...] } wrapper at compile time', async () => {
    // The bare-shape type bans this at author time; this covers the untyped/JS path — recordFulfilment
    // must reject the wrapper so `noodle validate` fails, not only when the resource is read.
    const app = server('docs_server', { title: 'Docs', version: '1.0.0' }, [
      resource('changelog', {
        uri: 'docs://changelog',
        mimeType: 'text/markdown',
        // Cast bypasses the compile-time ban, simulating an untyped author following the old recipe.
        fulfil: () =>
          ({ contents: [{ uri: 'docs://changelog', text: '# Changelog' }] }) as unknown as string,
      }),
    ]);
    await expect(app.toManifest()).rejects.toThrow(/contents.*wrapper|bare content entry/);
  });

  it('does not reject a prompt fulfil that returns a `contents` field (guard is resource-scoped)', async () => {
    // A prompt's return is not mapped into MCP `contents`, so the wrapper guard must not fire for it.
    const app = server('docs_server', { title: 'Docs', version: '1.0.0' }, [
      prompt('summarize', {
        fulfil: () => ({ contents: [{ text: 'ok' }] }) as unknown as string,
      }),
    ]);
    await expect(app.toManifest()).resolves.toBeDefined();
  });
});
