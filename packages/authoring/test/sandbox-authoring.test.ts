import { afterAll, describe, expect, it } from 'vitest';
import { SANDBOX_AUTHORING_LIMITS, SandboxedAuthoringLoader } from '../dist/sandbox-authoring.js';
import * as sdk from '../src/index.js';

const loader = new SandboxedAuthoringLoader();
afterAll(() => loader.close());

const source = `import { server, tool, z } from '@noodleseed/one';
export default server('welcome', { version: '1.0.0', title: 'Welcome' }, [
  tool('greet', { description: 'Greet a visitor', input: z.object({ name: z.string() }),
    fulfil: async (ctx) => ({ message: ctx.input.name }) })
]);`;

describe('isolated canonical TypeScript authoring', () => {
  it('loads the actual SDK without executing customer code on the host', async () => {
    const result = await loader.load({ entrypoint: 'server.ts', files: { 'server.ts': source } });
    expect(JSON.parse(result.manifest)).toMatchObject({
      server: { name: 'welcome' },
      tools: [{ name: 'greet' }],
    });
  });

  it('preserves native records, managed settings, and SDK projection parity', async () => {
    function definition(api: typeof sdk) {
      const { server, tool, z, variable, managedCollection, noodlePlatform } = api;
      const greeting = variable('GREETING', {
        schema: z.string().max(100),
        default: 'Hello 👋',
        portal: { label: 'Greeting' },
      });
      return server(
        'enquiries',
        {
          version: '1.0.0',
          title: 'Enquiries',
          variables: [greeting],
          use: { records: noodlePlatform.records.v1 },
          collections: [
            managedCollection('enquiries', {
              title: 'Enquiries',
              description: 'Visitor enquiries',
              schemaVersion: 1,
              record: z.object({ message: z.string().max(500) }),
              publicFields: ['message'],
            }),
          ],
        },
        [
          tool('send_enquiry', {
            description: 'Send an enquiry',
            input: z.object({ message: z.string().max(500) }),
            fulfil: ({ input, connectors }) => ({
              receipt: connectors.records.submitRecord({ collection: 'enquiries', payload: input })
                .recordId,
              greeting,
            }),
          }),
        ],
      );
    }
    const native = definition(sdk);
    const result = await loader.load({
      entrypoint: 'server.ts',
      files: {
        'server.ts': `import * as sdk from '@noodleseed/one'; export default (${definition.toString()})(sdk);`,
      },
    });
    expect(JSON.parse(result.manifest)).toEqual(await native.toManifest());
    expect(result.connectors === undefined ? undefined : JSON.parse(result.connectors)).toEqual(
      native.toConnectorCatalog(),
    );
    expect(result.compilerDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('resolves only uploaded relative helper modules', async () => {
    const result = await loader.load({
      entrypoint: 'src/server.ts',
      files: {
        'src/server.ts': `import app from '../helpers/app.js'; export default app;`,
        'helpers/app.ts': source,
      },
    });
    expect(JSON.parse(result.manifest).server.name).toBe('welcome');
  });

  it.each([
    'node:fs',
    'node:child_process',
    'https://example.com/x.js',
    '/tmp/server.ts',
    '../../escape.ts',
    '@noodle-borg/service',
  ])('denies import %s', async (specifier) => {
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: {
          'server.ts': `import * as denied from ${JSON.stringify(specifier)}; void denied; ${source}`,
        },
      }),
    ).rejects.toThrow('invalid_source');
  });

  it.each([
    'process',
    'fetch',
    'Date',
    'console',
    'XMLHttpRequest',
    'WebSocket',
    'require("node:fs")',
  ])('does not expose ambient %s', async (expression) => {
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': `void (${expression}); ${source}` },
      }),
    ).rejects.toThrow();
  });

  it('rejects malformed unused helper files', async () => {
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': source, 'unused.ts': 'const = ;' },
      }),
    ).rejects.toThrow('invalid_source');
  });

  it('checks UTF-8 bytes and paths before sandbox admission', async () => {
    await expect(
      loader.load({ entrypoint: 'server.ts', files: { '../server.ts': source } }),
    ).rejects.toThrow('invalid_source');
    await expect(
      loader.load({ entrypoint: 'server.ts', files: { 'server.ts': '😀'.repeat(70_000) } }),
    ).rejects.toThrow('invalid_source');
  });

  it('snapshots input and isolates globals across builds', async () => {
    const files = { 'server.ts': `globalThis.customerMarker = 'private'; ${source}` };
    const pending = loader.load({ entrypoint: 'server.ts', files });
    files['server.ts'] = 'throw new Error("mutated")';
    await expect(pending).resolves.toHaveProperty('manifest');
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: {
          'server.ts': `if ('customerMarker' in globalThis) throw new Error('leak'); ${source}`,
        },
      }),
    ).resolves.toHaveProperty('manifest');
  });

  it('admits at most two builds without an unbounded queue', async () => {
    const input = { entrypoint: 'server.ts', files: { 'server.ts': source } };
    const first = loader.load(input),
      second = loader.load(input);
    await expect(loader.load(input)).rejects.toMatchObject({ code: 'busy' });
    await Promise.all([first, second]);
  });

  it('bounds nonterminating source without blocking the host event loop', async () => {
    const bounded = new SandboxedAuthoringLoader({ timeoutMs: 8000 });
    try {
      const pending = bounded.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': `while (true) {} ${source}` },
      });
      let ticked = false;
      const tick = new Promise<void>((resolve) =>
        setTimeout(() => {
          ticked = true;
          resolve();
        }, 10),
      );
      await expect(pending).rejects.toMatchObject({ code: 'timeout' });
      expect(ticked).toBe(true);
      await tick;
      await expect(
        bounded.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
      ).resolves.toHaveProperty('manifest');
    } finally {
      await bounded.close();
    }
  }, 30_000);

  it.each([
    { limits: { memoryBytes: 4 * 1024 * 1024 }, code: 'memory' },
    { limits: { maxOutputBytes: 32 }, code: 'output_limit' },
  ])('enforces $code', async ({ limits, code }) => {
    const bounded = new SandboxedAuthoringLoader(limits);
    try {
      await expect(
        bounded.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
      ).rejects.toMatchObject({ code });
    } finally {
      await bounded.close();
    }
  });

  it('redacts arbitrary thrown text and disallows host operations', async () => {
    const privateText = 'customer-private-value';
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': `throw new Error(${JSON.stringify(privateText)}); ${source}` },
      }),
    ).rejects.toMatchObject({ code: 'invalid_source', message: 'invalid_source' });
    await expect(
      loader.load({
        entrypoint: 'server.ts',
        files: { 'server.ts': `callOperation('records.submitRecord', {}); ${source}` },
      }),
    ).rejects.toThrow();
  });

  it('closes admission even during preparation and permits only lowered limits', async () => {
    for (const key of ['timeoutMs', 'memoryBytes', 'maxOutputBytes'] as const) {
      expect(
        () => new SandboxedAuthoringLoader({ [key]: SANDBOX_AUTHORING_LIMITS[key] + 1 }),
      ).toThrow();
      expect(() => new SandboxedAuthoringLoader({ [key]: 0 })).toThrow();
    }
    const closed = new SandboxedAuthoringLoader();
    const pending = expect(
      closed.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
    ).rejects.toThrow();
    await closed.close();
    await pending;
    await expect(
      closed.load({ entrypoint: 'server.ts', files: { 'server.ts': source } }),
    ).rejects.toMatchObject({ code: 'closed' });
    await closed.close();
  });
});
