import { describe, expect, it } from 'vitest';
import { InMemoryDailyCounterStore } from '../src/in-memory-counter-store.js';
import {
  type PublicAdmissionRequestBinding,
  type PublicAdmissionSigningKeys,
  publicAdmissionRequestDigest,
  signPublicAdmissionAssertion,
  verifyPublicAdmissionAssertion,
} from '../src/public-admission-assertion.js';
import {
  publicRecordAdmissionLimits,
  publicRecordCounterRequests,
} from '../src/public-record-admission.js';

const now = new Date('2030-03-04T09:00:00Z');
const keys: PublicAdmissionSigningKeys = {
  activeVersion: 'v1',
  keys: { v1: 'one'.repeat(16), v2: 'two'.repeat(16) },
  pseudonymKey: 'stable'.repeat(8),
};
const binding: PublicAdmissionRequestBinding = {
  surfaceId: 'public-surface',
  installationId: 'installation',
  method: 'POST',
  route: '/v1/solution-intake/public-surface/leads/records',
  idempotencyKey: 'logical-record',
  requestDigest: publicAdmissionRequestDigest('{"payload":{"name":"Synthetic"}}'),
};
const attribution = { sourceAddress: '203.0.113.19', visitorHint: 'visitor-1' };

describe('private public-record attribution', () => {
  it('binds every request field and returns only scoped pseudonyms', () => {
    const token = signPublicAdmissionAssertion(binding, attribution, keys, now);
    const result = verifyPublicAdmissionAssertion(token, binding, keys, now);
    expect(result).toEqual({
      network: expect.stringMatching(/^[a-f0-9]{64}$/),
      visitor: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const decoded = Buffer.from(token.split('.')[0] ?? '', 'base64url').toString();
    expect(decoded).not.toContain(attribution.sourceAddress);
    expect(decoded).not.toContain(attribution.visitorHint);
    for (const field of [
      'surfaceId',
      'installationId',
      'route',
      'idempotencyKey',
      'requestDigest',
    ] as const) {
      expect(
        verifyPublicAdmissionAssertion(
          token,
          { ...binding, [field]: `changed-${binding[field]}` },
          keys,
          now,
        ),
      ).toBeUndefined();
    }
    expect(verifyPublicAdmissionAssertion(`${token}x`, binding, keys, now)).toBeUndefined();
  });

  it('bounds time, rejects unknown keys, and accepts rotation without new quota identities', () => {
    const first = signPublicAdmissionAssertion(binding, attribution, keys, now);
    const rotatedKeys = { ...keys, activeVersion: 'v2' };
    const second = signPublicAdmissionAssertion(binding, attribution, rotatedKeys, now);
    expect(verifyPublicAdmissionAssertion(first, binding, rotatedKeys, now)).toEqual(
      verifyPublicAdmissionAssertion(second, binding, rotatedKeys, now),
    );
    expect(
      verifyPublicAdmissionAssertion(
        first,
        binding,
        { ...keys, keys: { v2: keys.keys.v2 ?? '' } },
        now,
      ),
    ).toBeUndefined();
    expect(
      verifyPublicAdmissionAssertion(first, binding, keys, new Date(now.getTime() + 66_000)),
    ).toBeUndefined();
    expect(
      verifyPublicAdmissionAssertion(first, binding, keys, new Date(now.getTime() - 6_000)),
    ).toBeUndefined();
    const boundary = new Date('2030-03-04T23:59:50Z');
    const oldEpoch = signPublicAdmissionAssertion(binding, attribution, keys, boundary);
    expect(
      verifyPublicAdmissionAssertion(oldEpoch, binding, keys, new Date('2030-03-05T00:00:00Z')),
    ).toBeUndefined();
  });

  it('keeps network protection without a visitor hint and refuses ambiguous ingress chains', () => {
    const token = signPublicAdmissionAssertion(
      binding,
      { sourceAddress: attribution.sourceAddress },
      keys,
      now,
    );
    expect(verifyPublicAdmissionAssertion(token, binding, keys, now)).toEqual({
      network: expect.any(String),
    });
    expect(() =>
      signPublicAdmissionAssertion(
        binding,
        { sourceAddress: '203.0.113.1, 203.0.113.2' },
        keys,
        now,
      ),
    ).toThrow();
    const other = { ...binding, installationId: 'different-installation' };
    const otherToken = signPublicAdmissionAssertion(other, attribution, keys, now);
    expect(verifyPublicAdmissionAssertion(otherToken, other, keys, now)?.network).not.toEqual(
      verifyPublicAdmissionAssertion(token, binding, keys, now)?.network,
    );
  });
});

describe('ordinary public-record testing allowance', () => {
  it('allows three 500-create five-minute runs in an hour and 3,000 in the day', async () => {
    const counters = new InMemoryDailyCounterStore();
    for (let index = 0; index < 3_000; index++) {
      const elapsed = index < 1_500 ? index * 600 : 3_600_000 + (index - 1_500) * 600;
      const at = new Date(now.getTime() + elapsed);
      const result = await counters.consumeAllOnce(
        publicRecordCounterRequests('surface', { visitor: 'one', network: 'office' }),
        { key: `create-${index}`, fingerprint: 'a' },
        at,
      );
      expect(result.kind).toBe('consumed');
    }
    expect(await counters.peek('solution-intake:surface:surface', now)).toBe(3_000);
  });

  it('allows ten same-network testers to create 300 records each over ten minutes', async () => {
    const counters = new InMemoryDailyCounterStore();
    for (let index = 0; index < 300; index++) {
      const at = new Date(now.getTime() + index * 2_000);
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, tester) =>
          counters.consumeAllOnce(
            publicRecordCounterRequests('surface', {
              visitor: `visitor-${tester}`,
              network: 'office',
            }),
            { key: `tester-${tester}-${index}`, fingerprint: 'a' },
            at,
          ),
        ),
      );
      expect(outcomes.every((result) => result.kind === 'consumed')).toBe(true);
    }
  });

  it('preserves usage after lowering limits, refuses rotating visitors at the network bound', async () => {
    const counters = new InMemoryDailyCounterStore();
    const limits = publicRecordAdmissionLimits({ networkPerMinute: 2 });
    for (let index = 0; index < 2; index++)
      await counters.consumeAllOnce(
        publicRecordCounterRequests(
          'surface',
          { visitor: `rotate-${index}`, network: 'one' },
          limits,
        ),
        { key: `first-${index}`, fingerprint: 'a' },
        now,
      );
    const result = await counters.consumeAllOnce(
      publicRecordCounterRequests('surface', { visitor: 'new', network: 'one' }, limits),
      { key: 'denied', fingerprint: 'a' },
      now,
    );
    expect(result).toMatchObject({
      kind: 'refused',
      exhausted: [{ limit: 2, resetAt: new Date('2030-03-04T09:01:00Z') }],
    });
    expect(await counters.peek('solution-intake:surface:surface', now)).toBe(2);
    expect(() => publicRecordAdmissionLimits({ networkPerMinute: 601 })).toThrow();
  });
});
