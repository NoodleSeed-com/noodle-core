import { describe, expect, it } from 'vitest';
import { InMemoryCatalog } from '../src/catalog/in-memory.js';
import type { CatalogConnector } from '../src/catalog/types.js';

const emptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

function catalogConnector(id: string, version: string): CatalogConnector {
  return {
    id,
    version,
    kind: 'catalog',
    operations: {
      read: {
        type: 'read',
        input: emptySchema,
        output: emptySchema,
      },
    },
  };
}

describe('InMemoryCatalog connector identity', () => {
  it.each([
    ['first declaration order', false],
    ['reversed declaration order', true],
  ])('keeps delimiter-colliding identities distinct in %s', (_label, reversed) => {
    const first = catalogConnector('catalog@pair', '1');
    const second = catalogConnector('catalog', 'pair@1');
    const catalog = new InMemoryCatalog(reversed ? [second, first] : [first, second]);

    expect(catalog.get(first.id, first.version)).toBe(first);
    expect(catalog.get(second.id, second.version)).toBe(second);
  });
});
