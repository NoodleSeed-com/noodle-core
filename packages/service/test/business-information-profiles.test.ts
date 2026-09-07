import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_SOLUTION_PROFILES,
  builtInCollection,
  validateProfilePayload,
} from '../src/business-information/profiles.js';

const examples = {
  travel: {
    collection: 'travel_requests',
    payload: { request_type: 'refund', summary: 'Refund the unused segment.' },
  },
  b2b_saas: {
    collection: 'service_requests',
    payload: { request_type: 'support', summary: 'Workspace provisioning did not complete.' },
  },
  ecommerce: {
    collection: 'return_requests',
    payload: { order_reference: 'ORDER-9', reason: 'Item arrived damaged.' },
  },
  restaurant: {
    collection: 'guest_requests',
    payload: { request_type: 'reservation_help', summary: 'Move dinner to 20:00.' },
  },
} as const;

describe('built-in managed request profiles', () => {
  it('keeps four vertical profiles as declarative data with one collection each', () => {
    expect(Object.keys(BUILT_IN_SOLUTION_PROFILES).sort()).toEqual([
      'b2b_saas',
      'ecommerce',
      'restaurant',
      'travel',
    ]);
    for (const [profileKey, example] of Object.entries(examples)) {
      const profile = BUILT_IN_SOLUTION_PROFILES[profileKey as keyof typeof examples];
      expect(profile.collections).toHaveLength(1);
      expect(profile.collections[0]).toMatchObject({
        key: example.collection,
        schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
      });
      expect(profile.collections[0]?.labels.plural.length).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(examples))('validates the %s request schema', (profileKey, example) => {
    expect(
      validateProfilePayload(
        profileKey as keyof typeof examples,
        example.collection,
        example.payload,
      ),
    ).toEqual(example.payload);
  });

  it('rejects unknown fields and missing required profile fields', () => {
    expect(() =>
      validateProfilePayload('travel', 'travel_requests', {
        request_type: 'refund',
        summary: 'Valid',
        undeclared: true,
      }),
    ).toThrow(/undeclared/);
    expect(() =>
      validateProfilePayload('ecommerce', 'return_requests', { reason: 'Missing order' }),
    ).toThrow(/order_reference/);
    expect(() => builtInCollection('travel', 'service_requests')).toThrow(/not declared/);
  });
});
