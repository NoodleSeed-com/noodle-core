/**
 * Humanized relative-time formatting for the resource commands' timestamp columns
 * (`apps list`'s UPDATED column, and similar `envs`/`deployments` views), plus the
 * future-relative `relativeUntil` for expiry columns (`members invitations`).
 * Pure and clock-injectable so callers (and tests) never depend on wall-clock time.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Format `iso` relative to `now` (default `Date.now()`) as e.g. "2h ago", "16d ago", "6mo ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = Math.max(0, now - then);
  if (diffMs < MINUTE_MS) return 'just now';
  if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  if (diffMs < MONTH_MS) return `${Math.floor(diffMs / DAY_MS)}d ago`;
  if (diffMs < YEAR_MS) return `${Math.floor(diffMs / MONTH_MS)}mo ago`;
  return `${Math.floor(diffMs / YEAR_MS)}y ago`;
}

/** Future-relative counterpart to `relativeTime` for expiry timestamps ("in 6d", "in 3h", "expired"). */
export function relativeUntil(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = then - now;
  if (diffMs <= 0) return 'expired';
  if (diffMs < MINUTE_MS) return 'in <1m';
  if (diffMs < HOUR_MS) return `in ${Math.floor(diffMs / MINUTE_MS)}m`;
  if (diffMs < DAY_MS) return `in ${Math.floor(diffMs / HOUR_MS)}h`;
  return `in ${Math.floor(diffMs / DAY_MS)}d`;
}
