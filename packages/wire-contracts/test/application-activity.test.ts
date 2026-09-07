import { describe, expect, it } from 'vitest';
import {
  ApplicationActivityListClientResponseSchema,
  ApplicationActivityListResponseSchema,
  ApplicationActivityPreviewClientResponseSchema,
  ApplicationActivityPreviewResponseSchema,
} from '../src/application-activity.js';

const entry = {
  id: 'a'.repeat(64),
  actorReference: 'b'.repeat(64),
  tool: 'send',
  operation: 'create',
  connectionId: 'account',
  outcome: 'accepted',
  startedAt: '2026-09-07T00:00:00.000Z',
};
const preview = {
  state: 'available',
  kind: 'hypothetical',
  asOf: '2026-09-07T00:00:00.000Z',
  revision: 'c'.repeat(64),
  currentMaximumDays: 90,
  paidPeriodEnd: '2026-09-30T00:00:00.000Z',
  currentlyAccessibleCount: 30,
  physicallyExpiresByPeriodEndCount: 5,
  scenarios: [
    { id: 'free', label: 'Free', maximumDays: 7, additionallyHiddenAtPeriodEndCount: 12 },
  ],
};
describe('bounded installation Activity wire', () => {
  it('requires scoped references in current server output, with additive older-client compatibility', () => {
    const body = { ok: true, data: { historyDays: 30, activities: [entry] } };
    expect(ApplicationActivityListResponseSchema.parse(body)).toEqual(body);
    const { actorReference: _actor, ...old } = entry;
    expect(
      ApplicationActivityListClientResponseSchema.parse({
        ok: true,
        data: {
          historyDays: 30,
          activities: [{ ...old, actorDigest: 'private', payload: 'private' }],
        },
      }).data.activities,
    ).toEqual([old]);
    expect(
      ApplicationActivityListResponseSchema.safeParse({
        ok: true,
        data: { historyDays: 30, activities: [old] },
      }).success,
    ).toBe(false);
  });
  it('rejects oversized pages, unscoped identity and raw evidence in server output', () => {
    for (const activities of [
      Array.from({ length: 101 }, () => entry),
      [{ ...entry, actorReference: 'name@example.com' }],
      [{ ...entry, actorDigest: 'private' }],
    ])
      expect(
        ApplicationActivityListResponseSchema.safeParse({
          ok: true,
          data: { historyDays: 30, activities },
        }).success,
      ).toBe(false);
  });
  it('strips additive preview fields at every nested client layer but rejects them at the server', () => {
    const body = {
      ok: true,
      data: {
        ...preview,
        payload: 'private',
        scenarios: preview.scenarios.map((item) => ({ ...item, raw: 'private' })),
      },
    };
    expect(ApplicationActivityPreviewClientResponseSchema.parse(body).data).toEqual(preview);
    expect(ApplicationActivityPreviewResponseSchema.safeParse(body).success).toBe(false);
  });
  it('requires bounded nonnegative counts and a hypothetical label without an invented schedule', () => {
    expect(
      ApplicationActivityPreviewResponseSchema.parse({ ok: true, data: preview }).data,
    ).toEqual(preview);
    for (const patch of [
      { currentlyAccessibleCount: -1 },
      { currentlyAccessibleCount: Number.MAX_SAFE_INTEGER + 1 },
      { kind: 'scheduled' },
      { scenarios: Array.from({ length: 3 }, () => preview.scenarios[0]) },
    ])
      expect(
        ApplicationActivityPreviewResponseSchema.safeParse({
          ok: true,
          data: { ...preview, ...patch },
        }).success,
      ).toBe(false);
  });
  it('keeps missing verified paid-period evidence separate from zero projected losses', () => {
    expect(
      ApplicationActivityPreviewResponseSchema.parse({
        ok: true,
        data: { state: 'unavailable', reason: 'no_verified_paid_period' },
      }).data,
    ).toEqual({ state: 'unavailable', reason: 'no_verified_paid_period' });
    expect(
      ApplicationActivityPreviewResponseSchema.safeParse({
        ok: true,
        data: {
          state: 'unavailable',
          reason: 'no_verified_paid_period',
          currentlyAccessibleCount: 0,
        },
      }).success,
    ).toBe(false);
  });
});
