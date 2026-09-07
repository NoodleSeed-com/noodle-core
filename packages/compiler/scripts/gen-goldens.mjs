// Regenerate the golden runtime-artifact fixtures from compiled output (never hand-write them).
// Usage: pnpm --filter @noodle-borg/compiler build && node scripts/gen-goldens.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, InMemoryCatalog } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const valid = join(here, '..', 'fixtures', 'valid');
const read = (f) => readFileSync(join(valid, f), 'utf8');

// Mirror of test/catalog.ts so generated goldens match the resolution tests.
const catalog = new InMemoryCatalog([
  {
    id: 'acme_orders',
    version: '1.2.0',
    kind: 'catalog',
    operations: {
      get_order: {
        type: 'read',
        input: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: { order: { type: 'object' } },
          additionalProperties: false,
        },
      },
      get_tracking: {
        type: 'read',
        input: {
          type: 'object',
          properties: { order_id: { type: 'string' } },
          required: ['order_id'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: { url: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
  },
]);

const customerRoutingCatalog = new InMemoryCatalog([
  {
    id: 'customer_records',
    version: '1.0.0',
    kind: 'custom',
    operations: {
      list_records: {
        type: 'read',
        input: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    customerRouting: {
      directEndpoint: 'customer_api',
      endpoints: {
        customer_api: {
          allowedHttpsHostSuffixes: ['noodleseed.dev'],
        },
      },
      operationEndpoints: {
        list_records: ['customer_api'],
      },
      operationActionEndpoints: {
        list_records: [],
      },
    },
  },
]);

/** @type {Array<[string, string, object | undefined]>} manifest -> golden, with optional catalog */
const goldens = [
  ['minimal.manifest.yaml', 'minimal.artifact.json', undefined],
  ['minimal.manifest.yaml', 'minimal.resolved.artifact.json', catalog],
  ['schemas-basic.manifest.yaml', 'schemas-basic.artifact.json', undefined],
  ['single-op-args.manifest.yaml', 'single-op-args.artifact.json', undefined],
  ['flow-basic.manifest.yaml', 'flow-basic.artifact.json', catalog],
  ['customer-routing.manifest.yaml', 'customer-routing.artifact.json', customerRoutingCatalog],
];

let failed = false;
for (const [src, out, cat] of goldens) {
  const result = compile(read(src), cat ? { catalog: cat } : {});
  if (!result.ok) {
    console.error(`✗ ${src}:`, result.errors);
    failed = true;
    continue;
  }
  writeFileSync(join(valid, out), `${JSON.stringify(result.artifact, null, 2)}\n`);
  console.log(`✓ wrote ${out}`);
}
process.exit(failed ? 1 : 0);
