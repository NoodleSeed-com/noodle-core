import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  managedCollection,
  noodlePlatform,
  noodlePlatformCatalog,
  server,
  tool,
  z,
} from '../src/index.js';

describe('explicit native record operations', () => {
  it('compiles optional field removal through the same explicitly declared staff update operation', async () => {
    const app = server(
      'items',
      {
        title: 'Items',
        version: '1.0.0',
        use: { records: noodlePlatform.records.v1 },
      },
      [
        tool('clear_reference', {
          description: 'Clear the optional reference on an existing item.',
          input: z.object({ id: z.string(), revision: z.number().int().min(1) }),
          output: z.object({ ok: z.boolean() }),
          fulfil: ({ input, connectors }) => {
            const result = connectors.records.updateRecord({
              collection: 'items',
              id: input.id,
              expectedRevision: input.revision,
              patch: {},
              unset: ['reference'],
            });
            return { ok: result.ok };
          },
        }),
      ],
    );
    const manifest = await app.toManifest();
    expect(manifest.tools[0]?.fulfilment.steps).toMatchObject([
      {
        use: 'records.update_record',
        args: {
          collection: 'items',
          id: '${input.id}',
          expectedRevision: '${input.revision}',
          patch: {},
          unset: ['reference'],
        },
      },
    ]);
    expect(
      compileManifest(manifest, { catalog: new InMemoryCatalog(noodlePlatformCatalog) }).ok,
    ).toBe(true);
  });

  it('keeps collection declaration inert and compiles only the author-selected submission tool', async () => {
    const items = managedCollection('items', {
      title: 'Items',
      description: 'Requested items',
      schemaVersion: 1,
      record: z.object({ label: z.string().max(100) }),
      publicFields: ['label'],
    });
    const config = {
      title: 'Items',
      version: '1.0.0',
      collections: [items],
      use: { records: noodlePlatform.records.v1 },
    };
    expect((await server('items', config, []).toManifest()).tools).toEqual([]);
    const app = server('items', config, [
      tool('request_item', {
        description: 'Submit one requested item.',
        input: z.object({ label: z.string().max(100) }),
        output: z.object({ recordId: z.string() }),
        fulfil: ({ input, connectors }) => {
          const receipt = connectors.records.submitRecord({
            collection: 'items',
            payload: { label: input.label },
          });
          return { recordId: receipt.recordId };
        },
      }),
    ]);
    const manifest = await app.toManifest();
    expect(manifest.tools[0]?.fulfilment.steps).toMatchObject([
      {
        use: 'records.submit_record',
        args: { collection: 'items', payload: { label: '${input.label}' } },
      },
    ]);
    const compiled = compileManifest(manifest, {
      catalog: new InMemoryCatalog(noodlePlatformCatalog),
    });
    expect(compiled.ok).toBe(true);
  });
});
