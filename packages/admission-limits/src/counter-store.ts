/**
 * The durable daily-counter port.
 *
 * Types are declared here rather than imported from the service's policy layer on purpose: this package
 * must not reach into a commercial carve-out cluster, and the shape is small enough that an independent
 * declaration is cheaper than the coupling (the same precedent `@noodle-borg/module` and
 * `@noodle-borg/transport-http` set for `AccessMode`).
 */

export interface CounterRequest {
  /** Stable identity of the thing being bounded — a surface's embed id, never a raw address. */
  readonly key: string;
  /** Ceiling for this key on this UTC day. Zero means the surface is switched off. */
  readonly limit: number;
  /** Units to consume; a mint and a turn are both 1 today. */
  readonly amount?: number;
  /**
   * Which window the ceiling belongs to. Solvency bounds are daily (the default); the per-address
   * fairness tier is hourly, so a visitor's accidental burst forgives itself within the same visit.
   */
  readonly window?: 'day' | 'hour';
}

export interface CounterOutcome {
  readonly allowed: boolean;
  /** Units used after this call (unchanged when the call was denied). */
  readonly used: number;
  readonly limit: number;
  /** Start of the window after the one this counter belongs to. */
  readonly resetAt: Date;
}

export interface DailyCounterStore {
  /**
   * Atomically consume against a key's daily budget. Must be safe under concurrency: N simultaneous
   * callers on one key may never push `used` past `limit`, because that is the whole point of the
   * counter.
   */
  consume(request: CounterRequest, now: Date): Promise<CounterOutcome>;
  /**
   * Delete rows no reader can reach any more, and return how many went.
   *
   * The table takes a write on every mint and every turn, and the fairness tiers are hourly, so a
   * busy surface writes up to 24 rows per visitor per day. Retention is what keeps that bounded.
   *
   * Safe by construction: both windows record the same `day` — an hourly row carries its hour inside
   * the key — so `day` behind the cutoff means unreachable, whatever wrote it.
   */
  prune(now: Date): Promise<number>;
  /** Usage without consuming, for operator reads. */
  peek(key: string, now: Date): Promise<number>;
  /**
   * Whether this store survives a process restart and is shared across service instances. The public
   * mint route refuses to serve when this is false: a per-process counter silently resets a customer's
   * spend ceiling on every deploy, restart, and scale-out, which is indistinguishable from having no
   * ceiling at all.
   */
  readonly durable: boolean;
}

/**
 * A counter store that can spend several independent ceilings as one admission decision.
 *
 * Sponsored managed-model egress uses this stronger port for the billing-account and fleet-wide
 * ceilings. Either both counters advance or neither does; charging one while refusing the other
 * would make the reported allowance drift from provider exposure.
 */
export interface AtomicDailyCounterStore extends DailyCounterStore {
  /** Atomically consume every request, returning false without changing any row when one refuses. */
  consumeAll(requests: readonly CounterRequest[], now: Date): Promise<boolean>;
}

/** Counters roll at UTC midnight — a fixed boundary no tenant timezone can shift. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Tier 3 rolls hourly rather than daily. A fairness bound wants a window short enough that an
 * accidental burst forgives itself within the same visit, where a solvency bound wants the whole day.
 */
export function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/**
 * The row identity for a request, and the reason the hour is folded into the **key** rather than the day.
 *
 * The counter table's `day` column is a real `date`, so an hour-resolution value cannot go there: it
 * fails at the database with `invalid input syntax for type date`, which is exactly how the per-address
 * tier took production down after passing every test — the shared suite only exercised the daily window
 * and the route tests used a mocked counter, so no test ever put an hourly request through real SQL.
 *
 * Partitioning by date and distinguishing the hour inside the key keeps both windows in one table with
 * no migration and no ambiguity: a daily row and an hourly row can never collide, because the hourly key
 * carries a suffix the daily key cannot produce.
 */
export function counterRow(
  request: Pick<CounterRequest, 'key' | 'window'>,
  now: Date,
): { readonly key: string; readonly day: string } {
  return {
    key: request.window === 'hour' ? `${request.key}@${hourKey(now)}` : request.key,
    day: dayKey(now),
  };
}

/**
 * Days of counter history kept.
 *
 * Two rather than one: instances disagree about the clock and requests are in flight across the UTC
 * boundary, so deleting a row the moment it stops being today's would race both. Two days is cheap —
 * the rows are tiny — and removes the race entirely.
 */
export const COUNTER_RETENTION_DAYS = 2;

/** The oldest day still readable at `now`. Rows before it are unreachable and may be deleted. */
export function retentionCutoff(now: Date): string {
  return dayKey(new Date(now.getTime() - COUNTER_RETENTION_DAYS * 24 * 60 * 60 * 1000));
}

export function nextReset(now: Date, window: 'day' | 'hour' = 'day'): Date {
  const next = new Date(now);
  if (window === 'hour') {
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
