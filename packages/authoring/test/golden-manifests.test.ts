import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../compiler/src/index.js';
import headlessOrders from './fixtures/golden/headless-orders.js';
import widgetSuite from './fixtures/golden/widget-suite.js';

/**
 * Golden author→manifest gate (ADR 0150): the SDK is governed, not frozen — sugar may change freely,
 * but the manifest emitted for a representative `server.ts` may not change without updating the
 * committed golden in the same diff, and every golden must validate as a Core v1 manifest. To refresh
 * after an intentional change: `expect(manifest).toEqual(...)` failures print the new emission; write
 * it to the fixture JSON and review the diff as a contract change.
 */

const here = dirname(fileURLToPath(import.meta.url));
const golden = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, 'fixtures', 'golden', name), 'utf8'));

describe('golden author→manifest emissions (ADR 0150)', () => {
  it('headless-orders emits the pinned manifest and connector catalog', async () => {
    const manifest = await headlessOrders.toManifest();
    expect(manifest).toEqual(golden('headless-orders.manifest.json'));
    expect(headlessOrders.toConnectorCatalog()).toEqual(golden('headless-orders.connectors.json'));
  });

  it('widget-suite emits the pinned manifest', async () => {
    const manifest = await widgetSuite.toManifest();
    expect(manifest).toEqual(golden('widget-suite.manifest.json'));
  });

  it('every golden manifest validates as a Core v1 manifest', () => {
    for (const name of ['headless-orders.manifest.json', 'widget-suite.manifest.json']) {
      const result = validateManifest(golden(name));
      expect(result.ok, `${name}: ${JSON.stringify(result.errors)}`).toBe(true);
    }
  });
});
