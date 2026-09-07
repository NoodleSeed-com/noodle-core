import { describe, expect, it } from 'vitest';
import { bind, connection, connector, managedCollection, server, tool, z } from '../src/index.js';

describe('managed collection authoring', () => {
  it('projects a Zod record schema into the canonical Core v2 manifest', async () => {
    const requests = managedCollection('service_requests', {
      title: 'Service requests',
      description: 'Customer requests that the business can review and resolve.',
      schemaVersion: 1,
      record: z.object({
        workspaceReference: z.string().min(1).max(120),
        category: z.enum(['question', 'change']),
        summary: z.string().min(1).max(1000),
      }),
    });
    const app = server(
      'customer_service',
      {
        title: 'Customer service',
        version: '1.0.0',
        collections: [requests],
      },
      [
        tool('health', {
          description: 'Return service health.',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          fulfil: () => ({ ok: true }),
        }),
      ],
    );

    await expect(app.toManifest()).resolves.toMatchObject({
      manifestVersion: '2',
      server: {
        collections: [
          {
            name: 'service_requests',
            title: 'Service requests',
            description: 'Customer requests that the business can review and resolve.',
            schemaVersion: 1,
            recordSchema: {
              type: 'object',
              required: ['workspaceReference', 'category', 'summary'],
              additionalProperties: false,
            },
          },
        ],
      },
    });
  });

  it('projects an external source through the existing bound connector alias', async () => {
    const inventoryConnector = connector('inventory_api')
      .version('1.0.0')
      .credentials({ customer: { kind: 'bearer' } })
      .operation('scan_stock', {
        type: 'read',
        input: z.object({
          mode: z.enum(['snapshot', 'changes']),
          cursor: z.string().optional(),
          checkpoint: z.string().optional(),
          limit: z.number().int().positive(),
        }),
        output: z.object({
          records: z.array(
            z.object({
              id: z.string(),
              version: z.string().optional(),
              record: z.object({ sku: z.string(), quantity: z.number().int() }),
            }),
          ),
          deletedIds: z.array(z.string()),
          nextCursor: z.string().optional(),
          checkpoint: z.string().optional(),
          complete: z.boolean(),
          resetRequired: z.boolean().optional(),
        }),
      });
    const inventoryApi = bind(inventoryConnector, {
      profile: 'customer',
      connection: connection('inventory_connection', { kind: 'externalExchange' }),
    });
    const stock = managedCollection('stock', {
      title: 'Stock',
      description: 'Read-only stock from the customer inventory system.',
      schemaVersion: 1,
      record: z.object({ sku: z.string(), quantity: z.number().int() }),
      source: { connector: inventoryApi, scan: 'scan_stock' },
    });
    const app = server(
      'inventory',
      {
        title: 'Inventory',
        version: '1.0.0',
        use: { inventory: inventoryApi },
        collections: [stock],
      },
      [
        tool('health', {
          description: 'Return service health.',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          fulfil: () => ({ ok: true }),
        }),
      ],
    );

    await expect(app.toManifest()).resolves.toMatchObject({
      server: {
        collections: [
          {
            name: 'stock',
            source: { connector: 'inventory', scan: 'scan_stock' },
          },
        ],
      },
    });
  });

  it('rejects a source connector that is not declared by the server', async () => {
    const undeclared = connector('inventory_api')
      .version('1.0.0')
      .operation('scan_stock', {
        type: 'read',
        input: z.object({}),
        output: z.object({}),
      });
    const stock = managedCollection('stock', {
      title: 'Stock',
      description: 'Stock.',
      schemaVersion: 1,
      record: z.object({ sku: z.string() }),
      source: { connector: undeclared, scan: 'scan_stock' },
    });
    const app = server(
      'inventory',
      { title: 'Inventory', version: '1.0.0', collections: [stock] },
      [
        tool('health', {
          description: 'Return service health.',
          input: z.object({}),
          fulfil: () => ({ ok: true }),
        }),
      ],
    );

    await expect(app.toManifest()).rejects.toThrow(/source connector.*server\.use/);
  });
});
