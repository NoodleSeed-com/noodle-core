import { describe, expect, it } from 'vitest';
import { builtInDefinitionAtRelease } from '../src/business-information/portable.js';
import { collectionToPublicWire } from '../src/routes/business-information-wire.js';

describe('anonymous collection definition projection', () => {
  it('exposes only declared public fields and omits native staff controls', () => {
    const collection = builtInDefinitionAtRelease('travel', 3).collections[0];
    if (collection === undefined) throw new Error('Travel collection missing');
    const projection = collectionToPublicWire(collection);
    expect(Object.keys(projection.recordSchema.properties as object)).toEqual(
      collection.publicFields,
    );
    expect(projection.recordSchema.properties).not.toHaveProperty('status');
    expect(projection).not.toHaveProperty('requestBehavior');
    expect(projection.summaryFields.every((name) => collection.publicFields?.includes(name))).toBe(
      true,
    );
  });

  it('does not publish a root default containing fields outside public authority', () => {
    const original = builtInDefinitionAtRelease('travel', 3).collections[0];
    if (original === undefined) throw new Error('Travel collection missing');
    const projection = collectionToPublicWire({
      ...original,
      recordSchema: { ...original.recordSchema, default: { status: 'staff-only-default' } },
    });
    expect(JSON.stringify(projection)).not.toContain('staff-only-default');
  });

  it('preserves the declared fields of a historical request release', () => {
    const collection = builtInDefinitionAtRelease('travel', 1).collections[0];
    if (collection === undefined) throw new Error('Travel collection missing');
    expect(collectionToPublicWire(collection).recordSchema.properties).toEqual(
      collection.recordSchema.properties,
    );
  });
});
