import type {
  AtomicDailyCounterStore,
  CounterRequest,
  DailyCounterStore,
} from './counter-store.js';

export const PUBLIC_RECORD_ADMISSION_DEFAULTS = Object.freeze({
  visitorPerMinute: 300,
  visitorPerHour: 3_000,
  networkPerMinute: 600,
  networkPerHour: 6_000,
  installationPerDay: 10_000,
});
export type PublicRecordAdmissionLimits = {
  readonly [Key in keyof typeof PUBLIC_RECORD_ADMISSION_DEFAULTS]: number;
};
export type PublicRecordLimitCategory = 'visitor' | 'network' | 'installation';

export type PublicRecordAdmissionResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'admission_unavailable' }
  | { readonly allowed: false; readonly reason: 'idempotency_conflict' }
  | {
      readonly allowed: false;
      readonly reason: 'quota_exceeded';
      readonly resetAt: Date;
      readonly limits: readonly {
        readonly category: PublicRecordLimitCategory;
        readonly limit: number;
        readonly resetAt: Date;
      }[];
    };

/** Channel-independent admission of one validated logical native create, after completed receipt replay. */
export async function admitPublicRecord(input: {
  readonly counters: DailyCounterStore;
  readonly surfaceId: string;
  readonly attempt: { readonly key: string; readonly fingerprint: string };
  readonly buckets: { readonly visitor?: string; readonly network?: string };
  readonly now: Date;
  readonly limits?: Partial<PublicRecordAdmissionLimits>;
}): Promise<PublicRecordAdmissionResult> {
  if (!input.buckets.network) return { allowed: false, reason: 'admission_unavailable' };
  if (!('consumeAllOnce' in input.counters) || typeof input.counters.consumeAllOnce !== 'function')
    return { allowed: false, reason: 'admission_unavailable' };
  try {
    const requests = publicRecordCounterRequests(
      input.surfaceId,
      input.buckets,
      publicRecordAdmissionLimits(input.limits),
    );
    const outcome = await (input.counters as AtomicDailyCounterStore).consumeAllOnce(
      requests,
      input.attempt,
      input.now,
    );
    if (outcome.kind === 'consumed' || outcome.kind === 'replayed') return { allowed: true };
    if (outcome.kind === 'conflict') return { allowed: false, reason: 'idempotency_conflict' };
    if (outcome.kind !== 'refused' || outcome.exhausted.length === 0)
      throw new Error('invalid atomic admission result');
    const limits = outcome.exhausted.map((counter) => ({
      category: requests.find((request) => request.key === counter.key)?.category ?? 'installation',
      limit: counter.limit,
      resetAt: counter.resetAt,
    }));
    return {
      allowed: false,
      reason: 'quota_exceeded',
      limits,
      resetAt: new Date(Math.max(...limits.map((counter) => counter.resetAt.getTime()))),
    };
  } catch {
    return { allowed: false, reason: 'admission_unavailable' };
  }
}

/** Deployment-owned lower limits retain the same counter identities and accumulated usage. */
export function publicRecordAdmissionLimits(
  configured: Partial<PublicRecordAdmissionLimits> = {},
): PublicRecordAdmissionLimits {
  return Object.fromEntries(
    Object.entries(PUBLIC_RECORD_ADMISSION_DEFAULTS).map(([name, maximum]) => {
      const value = configured[name as keyof PublicRecordAdmissionLimits] ?? maximum;
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
        throw new Error(
          'public record admission limits must be non-negative integers within the deployment ceiling',
        );
      return [name, value];
    }),
  ) as PublicRecordAdmissionLimits;
}

export function publicRecordCounterRequests(
  surfaceId: string,
  buckets: { readonly visitor?: string; readonly network?: string },
  limits: PublicRecordAdmissionLimits = PUBLIC_RECORD_ADMISSION_DEFAULTS,
): readonly (CounterRequest & { readonly category: PublicRecordLimitCategory })[] {
  const requests: (CounterRequest & { category: PublicRecordLimitCategory })[] = [];
  for (const category of ['visitor', 'network'] as const) {
    const bucket = buckets[category];
    if (bucket === undefined) continue;
    requests.push(
      {
        key: `solution-intake:${category}:minute:${surfaceId}:${bucket}`,
        category,
        limit: limits[`${category}PerMinute`],
        window: 'minute',
      },
      {
        key: `solution-intake:${category}:hour:${surfaceId}:${bucket}`,
        category,
        limit: limits[`${category}PerHour`],
        window: 'hour',
      },
    );
  }
  requests.push({
    key: `solution-intake:surface:${surfaceId}`,
    category: 'installation',
    limit: limits.installationPerDay,
    window: 'day',
  });
  return requests;
}
