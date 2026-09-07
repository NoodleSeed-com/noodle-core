import { describe, expect, it } from 'vitest';
import { patchedPayload } from '../src/business-information/collection-controls.js';
import { builtInDefinition } from '../src/business-information/profiles.js';

describe('native record explicit optional-field removal', () => {
  const collection = builtInDefinition('travel').collections[0];
  if (!collection) throw new Error('travel schema missing');
  const current = { request_type: 'service', summary: 'Keep me', priority: 'urgent' };
  it('removes only named optional keys, preserves omissions and treats null as data', () => {
    expect(patchedPayload(collection, current, { summary: 'Updated' }, ['priority'])).toEqual({
      request_type: 'service',
      summary: 'Updated',
    });
    expect(patchedPayload(collection, current, {})).toEqual(current);
    expect(patchedPayload(collection, current, { priority: null })).toHaveProperty(
      'priority',
      null,
    );
    expect(current.priority).toBe('urgent');
  });
  it.each([
    [{ priority: 'normal' }, ['priority']],
    [{}, ['summary']],
    [{}, ['undeclared']],
    [{}, ['priority', 'priority']],
    [{}, Array.from({ length: 129 }, (_, index) => `field_${index}`)],
  ])('rejects overlap, required, unknown, duplicate or oversized removals', (patch, unset) => {
    expect(() => patchedPayload(collection, current, patch, unset as string[])).toThrow();
  });
  it('preserves the live edit mask even when the historical schema had the optional field', () => {
    expect(() =>
      patchedPayload({ ...collection, editableFields: ['summary'] }, current, {}, ['priority']),
    ).toThrow();
  });
});
