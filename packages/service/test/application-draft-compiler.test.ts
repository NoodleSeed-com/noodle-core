import { afterAll, describe, expect, it } from 'vitest';
import { ApplicationDraftCompiler } from '../dist/application-drafts/compiler.js';

const compiler = new ApplicationDraftCompiler();
afterAll(() => compiler.close());
const input = (content: string) => ({
  entrypoint: 'server.ts',
  files: [{ path: 'server.ts', content }],
});
const source = `import { server, tool, z } from '@noodleseed/one';
export default server('welcome', { version: '1.0.0', title: 'Welcome' }, [
  tool('greet', { description: 'Greet a visitor', input: z.object({ name: z.string() }),
    fulfil: async (ctx) => ({ message: ctx.input.name }) })
]);`;

describe('draft source compiler', () => {
  it('resolves canonical SDK output without deployment, credentials or tool invocation', async () => {
    const result = await compiler.compile(input(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.compilerDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await compiler.compile(input(source))).toEqual(result);
  });

  it('does not trust a forged SDK-shaped export as a valid runtime artifact', async () => {
    const result = await compiler.compile(
      input(`export default {
      toManifest: async () => ({ manifestVersion: '999', server: { name: 'forged' } }),
      toConnectorCatalog: () => undefined, toDistributionMetadata: () => undefined
    };`),
    );
    expect(result.ok).toBe(false);
  });

  it('checks a native enquiry action without an external service', async () => {
    const result = await compiler.compile(
      input(`import { server, tool, z, managedCollection, noodlePlatform } from '@noodleseed/one';
      export default server('enquiries', { version: '1.0.0', title: 'Enquiries',
        use: { records: noodlePlatform.records.v1 },
        collections: [managedCollection('enquiries', { title: 'Enquiries', description: 'Visitor enquiries', schemaVersion: 1,
          record: z.object({ message: z.string().max(500) }), publicFields: ['message'] })],
      }, [tool('send_enquiry', { description: 'Send an enquiry', input: z.object({ message: z.string().max(500) }),
        fulfil: ({ input, connectors }) => ({ receipt: connectors.records.submitRecord({ collection: 'enquiries', payload: input }).recordId }),
      })]);`),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('returns bounded structured compiler issues for missing required fields', async () => {
    const result = await compiler.compile(input(source.replace(", title: 'Welcome'", '')));
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: 'invalid_shape', path: 'server.title' }],
    });
  });

  it('cannot replace a platform-owned connector with uploaded code', async () => {
    const result = await compiler.compile(
      input(`${source.replace('export default ', 'const app = ')}
      export default { toManifest: () => app.toManifest(), toDistributionMetadata: () => undefined,
        toConnectorCatalog: () => ({ connectors: [{ id: 'noodle_records', version: '1.0.0',
          operations: { read: { type: 'read', code: '() => ({})' } } }] }) };`),
    );
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'reserved_connector' }] });
  });

  it('rejects deep customer-produced JSON before recursive compiler validation', async () => {
    const result = await compiler.compile(
      input(`const nested = {}; let node = nested;
      for (let i = 0; i < 100; i++) node = node.next = {};
      export default { toManifest: async () => nested,
      toConnectorCatalog: () => undefined, toDistributionMetadata: () => undefined };`),
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('never exposes arbitrary source error text', async () => {
    const result = await compiler.compile(input(`throw new Error('private-value'); ${source}`));
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'invalid_source' }] });
    expect(JSON.stringify(result)).not.toContain('private-value');
  });
});
