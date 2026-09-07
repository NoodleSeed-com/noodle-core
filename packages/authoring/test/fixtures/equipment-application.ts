import {
  annotations,
  bind,
  connection,
  connector,
  externalExchange,
  managedCollection,
  server,
  tool,
  z,
} from '../../src/index.js';

export const equipmentRecord = z
  .object({
    code: z.string().min(1),
    label: z.string().min(1),
    quantity: z.number().int().nonnegative(),
  })
  .meta({ $schema: 'https://json-schema.org/draft/2020-12/schema' });

const scanStockInput = z.object({
  mode: z.enum(['snapshot', 'changes']),
  cursor: z.string().optional(),
  checkpoint: z.string().optional(),
  limit: z.number().int().positive(),
});

const scanStockOutput = z.object({
  records: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1).optional(),
      record: equipmentRecord,
    }),
  ),
  deletedIds: z.array(z.string()),
  nextCursor: z.string().optional(),
  checkpoint: z.string().optional(),
  complete: z.boolean(),
  resetRequired: z.boolean().optional(),
});

/** A synthetic developer application used only by owner-layer horizontal-platform tests. */
export function equipmentApplication(customerApiUrl: string) {
  const inventoryApi = connector('customer_inventory')
    .version('1.0.0')
    .http({
      baseUrl: customerApiUrl,
      allowedOrigins: [customerApiUrl],
      credentialProfiles: { customer: { kind: 'bearer' } },
      operations: {
        scan_stock: {
          type: 'read',
          method: 'POST',
          path: '/stock:scan',
          input: scanStockInput,
          output: scanStockOutput,
          request: {
            mode: '${args.mode}',
            cursor: '${args.cursor}',
            checkpoint: '${args.checkpoint}',
            limit: '${args.limit}',
          },
          response: {
            records: '${response.records}',
            deletedIds: '${response.deletedIds}',
            nextCursor: '${response.nextCursor}',
            checkpoint: '${response.checkpoint}',
            complete: '${response.complete}',
            resetRequired: '${response.resetRequired}',
          },
          credentials: { profiles: ['customer'], scopes: ['inventory.read'] },
          resilience: {
            timeoutMs: 5_000,
            retry: { maxAttempts: 2, retryOn: ['timeout', 'network_error', 'upstream_5xx'] },
          },
          limits: { maxResponseBytes: 64 * 1024 },
        },
        adjust_stock: {
          type: 'action',
          method: 'POST',
          path: '/stock/${args.code}:adjust',
          input: z.object({ code: z.string().min(1), delta: z.number().int() }),
          output: z.object({ code: z.string(), quantity: z.number().int().nonnegative() }),
          request: { delta: '${args.delta}' },
          response: { code: '${response.code}', quantity: '${response.quantity}' },
          credentials: { profiles: ['customer'], scopes: ['inventory.write'] },
          resilience: { timeoutMs: 5_000 },
          limits: { maxResponseBytes: 16 * 1024 },
        },
      },
    });
  const inventory = bind(inventoryApi, {
    profile: 'customer',
    connection: connection('customer_inventory_account', externalExchange()),
  });

  // This live connector is deliberately not wrapped by a collection.
  const diagnostics = connector('customer_equipment_diagnostics')
    .version('1.0.0')
    .http({
      baseUrl: customerApiUrl,
      allowedOrigins: [customerApiUrl],
      operations: {
        inspect: {
          type: 'read',
          method: 'GET',
          path: '/equipment/${args.code}:inspect',
          input: z.object({ code: z.string().min(1) }),
          output: z.object({ code: z.string(), state: z.string() }),
          response: { code: '${response.code}', state: '${response.state}' },
          limits: { maxResponseBytes: 16 * 1024 },
        },
      },
    });

  const assets = managedCollection('assets', {
    title: 'Assets',
    description: 'Equipment records owned by this Noodle Seed application.',
    schemaVersion: 1,
    record: equipmentRecord,
  });
  const stock = managedCollection('stock', {
    title: 'Stock',
    description: 'Read-only stock projected from the customer inventory API.',
    schemaVersion: 1,
    record: equipmentRecord,
    source: { connector: inventory, scan: 'scan_stock' },
  });

  return server(
    'equipment_operations',
    {
      title: 'Equipment operations',
      version: '1.0.0',
      use: { inventory, diagnostics },
      collections: [assets, stock],
    },
    [
      tool('adjust_stock', {
        description: 'Adjust stock in the customer inventory system.',
        annotations: annotations.openAction({ destructive: true, confirm: true }),
        input: z.object({ code: z.string().min(1), delta: z.number().int() }),
        output: z.object({ code: z.string(), quantity: z.number().int().nonnegative() }),
        fulfil: ({ input, connectors }) => {
          const adjusted = connectors.inventory.adjustStock({
            code: input.code,
            delta: input.delta,
          });
          return { code: adjusted.code, quantity: adjusted.quantity };
        },
      }),
      tool('inspect_equipment', {
        description: 'Inspect live equipment state without storing a collection replica.',
        input: z.object({ code: z.string().min(1) }),
        output: z.object({ code: z.string(), state: z.string() }),
        fulfil: ({ input, connectors }) => {
          const inspected = connectors.diagnostics.inspect({ code: input.code });
          return { code: inspected.code, state: inspected.state };
        },
      }),
    ],
  );
}
