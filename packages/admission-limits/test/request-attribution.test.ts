import { describe, expect, it } from 'vitest';
import { InMemoryDailyCounterStore } from '../src/in-memory-counter-store.js';
import { admitPublicRecord } from '../src/public-record-admission.js';
import { trustedPublicAdmission } from '../src/request-attribution.js';

const input = {
  scope: 'org/app/production',
  sourceAddress: '203.0.113.8',
  now: new Date('2030-01-01T10:00:00Z'),
};
describe('trusted in-process public-write attribution', () => {
  it('refuses missing network attribution before spending any installation allowance', async () => {
    const counters = new InMemoryDailyCounterStore();
    const result = await admitPublicRecord({
      counters,
      surfaceId: 'surface',
      attempt: { key: 'create', fingerprint: 'payload' },
      buckets: { visitor: 'visitor' },
      now: input.now,
    });
    expect(result).toEqual({ allowed: false, reason: 'admission_unavailable' });
    expect(
      await counters.consume({ key: 'solution-intake:surface:surface', limit: 1 }, input.now),
    ).toMatchObject({ allowed: true, used: 1 });
  });
  it('requires a scoped unambiguous peer and never invents a visitor', () => {
    expect(trustedPublicAdmission(input)).toEqual({
      network: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const sourceAddress of [undefined, '', 'garbage', '203.0.113.8, 203.0.113.9'])
      expect(trustedPublicAdmission({ ...input, sourceAddress })).toBeUndefined();
    expect(trustedPublicAdmission({ ...input, scope: undefined })).toBeUndefined();
  });
  it('normalizes peers, separates tenants and authenticated subjects, and rotates daily', () => {
    const first = trustedPublicAdmission({ ...input, subject: 'alice' });
    expect(
      trustedPublicAdmission({ ...input, sourceAddress: '::ffff:203.0.113.8', subject: 'alice' }),
    ).toEqual(first);
    const second = trustedPublicAdmission({ ...input, subject: 'bob' });
    expect(second?.network).toBe(first?.network);
    expect(second?.visitor).not.toBe(first?.visitor);
    expect(
      trustedPublicAdmission({ ...input, scope: 'other/app/production', subject: 'alice' })
        ?.network,
    ).not.toBe(first?.network);
    expect(
      trustedPublicAdmission({ ...input, now: new Date('2030-01-02T10:00:00Z') })?.network,
    ).not.toBe(first?.network);
    expect(JSON.stringify(first)).not.toMatch(/203\.0\.113|alice|org\/app/);
  });
});
