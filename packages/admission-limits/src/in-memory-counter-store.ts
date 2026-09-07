import {
  type AtomicCounterAttemptOutcome,
  type AtomicDailyCounterStore,
  type CounterOutcome,
  type CounterRequest,
  counterRow,
  type DailyCounterStore,
  dayKey,
  type ExhaustedCounter,
  nextReset,
  retentionCutoff,
} from './counter-store.js';

/**
 * Process-local counters for local development and tests.
 *
 * `durable` is false, and that is load-bearing rather than informational: the public mint route refuses
 * to serve a surface backed by this store, because a ceiling that resets on every restart and is not
 * shared across instances would look like protection while providing none.
 */
export class InMemoryDailyCounterStore implements DailyCounterStore, AtomicDailyCounterStore {
  readonly durable = false;
  readonly #used = new Map<string, number>();
  readonly #receipts = new Map<string, string>();

  async consume(request: CounterRequest, now: Date): Promise<CounterOutcome> {
    const row = counterRow(request, now);
    const key = `${row.day}:${row.key}`;
    const amount = request.amount ?? 1;
    const used = this.#used.get(key) ?? 0;
    const resetAt = nextReset(now, request.window);
    if (used + amount > request.limit) {
      return { allowed: false, used, limit: request.limit, resetAt };
    }
    this.#used.set(key, used + amount);
    return { allowed: true, used: used + amount, limit: request.limit, resetAt };
  }

  async consumeAll(requests: readonly CounterRequest[], now: Date): Promise<boolean> {
    return this.#consumeAll(requests, now).length === 0;
  }

  async consumeAllOnce(
    requests: readonly CounterRequest[],
    attempt: { readonly key: string; readonly fingerprint: string },
    now: Date,
  ): Promise<AtomicCounterAttemptOutcome> {
    const receipt = counterRow({ key: attempt.key }, now);
    const receiptKey = `${receipt.day}:${receipt.key}`;
    const existing = this.#receipts.get(receiptKey);
    if (existing !== undefined)
      return { kind: existing === attempt.fingerprint ? 'replayed' : 'conflict' };
    const exhausted = this.#consumeAll(requests, now);
    if (exhausted.length > 0) return { kind: 'refused', exhausted };
    this.#receipts.set(receiptKey, attempt.fingerprint);
    return { kind: 'consumed' };
  }

  #consumeAll(requests: readonly CounterRequest[], now: Date): readonly ExhaustedCounter[] {
    const batch = requests.map((request) => {
      const row = counterRow(request, now);
      return {
        request,
        key: `${row.day}:${row.key}`,
        amount: request.amount ?? 1,
      };
    });
    if (new Set(batch.map((entry) => entry.key)).size !== batch.length) {
      throw new Error('atomic counter requests must have distinct row identities');
    }
    const exhausted: ExhaustedCounter[] = [];
    for (const entry of batch) {
      const used = this.#used.get(entry.key) ?? 0;
      if (entry.request.limit <= 0 || used + entry.amount > entry.request.limit)
        exhausted.push({
          key: entry.request.key,
          limit: entry.request.limit,
          resetAt: nextReset(now, entry.request.window),
        });
    }
    if (exhausted.length > 0) return exhausted;
    for (const entry of batch) {
      this.#used.set(entry.key, (this.#used.get(entry.key) ?? 0) + entry.amount);
    }
    return [];
  }

  async prune(now: Date): Promise<number> {
    // The day is the map key's prefix, and it sorts lexicographically because it is ISO-8601 — which
    // is the same property the durable store leans on in SQL.
    const cutoff = retentionCutoff(now);
    let removed = 0;
    for (const key of this.#used.keys()) {
      if ((key.split(':')[0] ?? '') < cutoff) {
        this.#used.delete(key);
        removed += 1;
      }
    }
    for (const key of this.#receipts.keys()) {
      if ((key.split(':')[0] ?? '') < cutoff) {
        this.#receipts.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async peek(key: string, now: Date): Promise<number> {
    return this.#used.get(`${dayKey(now)}:${key}`) ?? 0;
  }
}
