import { afterAll, describe, expect, it } from 'vitest';
import { SandboxedAuthoringLoader } from '../dist/sandbox-authoring.js';
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
});
