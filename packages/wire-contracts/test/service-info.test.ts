import { describe, expect, it } from 'vitest';
import { serviceInfoClientResponseSchema, serviceInfoResponseSchema } from '../src/index.js';

const legacy = { ok: true, status: 'ok', version: '1.2.3', gitSha: 'abc', buildTime: 'now' };

describe('service feature negotiation', () => {
  it('accepts an older service without inventing support', () => {
    expect(serviceInfoClientResponseSchema.parse(legacy)).not.toHaveProperty('features');
  });
  it('validates enabled R1 support and keeps new client metadata additive', () => {
    const response = { ...legacy, features: { mixedCustomerAuth: 1 } };
    expect(serviceInfoResponseSchema.parse(response)).toEqual(response);
    expect(
      serviceInfoClientResponseSchema.parse({
        ...response,
        future: true,
        features: { mixedCustomerAuth: 2, future: true },
      }),
    ).toEqual({ ...response, features: { mixedCustomerAuth: 2 } });
    expect(
      serviceInfoResponseSchema.safeParse({ ...response, features: { mixedCustomerAuth: 2 } })
        .success,
    ).toBe(false);
  });
  it.each([0, -1, 1.5, '1', null, true])('rejects malformed advertised support %s', (value) => {
    expect(
      serviceInfoClientResponseSchema.safeParse({
        ...legacy,
        features: { mixedCustomerAuth: value },
      }).success,
    ).toBe(false);
  });
});
