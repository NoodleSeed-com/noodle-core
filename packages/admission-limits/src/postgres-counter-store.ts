import type { Pool, PoolClient } from 'pg';
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

/** One instance prunes at most this often; a boot sweep always runs once. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Bounded per sweep so one delete cannot hold locks across a large backlog. */
const PRUNE_BATCH = 10_000;

/**
 * Durable daily counters shared by every service instance.
 *
 * The consume path is a single statement. `INSERT … ON CONFLICT DO UPDATE` with the limit test in the
 * `WHERE` clause makes the read-modify-write atomic inside one row lock, so concurrent callers on the
 * same key serialize on that row and can never collectively exceed the ceiling. A denied call returns
 * no row, which is how the outcome is decided — no second query, and therefore no window between
 * checking and consuming.
 *
 * Retention is the other half. Every mint and every turn writes a row, and the fairness tiers are
 * hourly, so a busy surface writes up to 24 rows per visitor per day into the control plane's own
 * database. Nothing pruned them. A boot sweep plus a throttled piggyback on the consume path keeps
 * that bounded without a scheduler, the same shape the archived-app sweeper uses.
 */
export class PostgresDailyCounterStore implements DailyCounterStore, AtomicDailyCounterStore {
  readonly durable = true;
  readonly #pool: Pool;
  #prunedAt = 0;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS admission_daily_counters (
        counter_key text NOT NULL,
        day date NOT NULL,
        used bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (counter_key, day)
      )
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS admission_counter_receipts (
        receipt_key text NOT NULL,
        day date NOT NULL,
        fingerprint text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (receipt_key, day)
      )
    `);
    // The primary key leads with the counter key, so retention's `day < cutoff` would scan without
    // this. It is the only read the table has that is not a point lookup.
    //
    // Deliberately NOT `CONCURRENTLY`, which belongs in a migration run before the deploy rather
    // than here. A concurrent build cannot run inside a transaction and waits for every transaction
    // that could see the table to finish — so under the schema-startup lock two booting instances
    // each wait on the other and neither starts serving. Swallowing the error does not help,
    // because the cost is the waiting, not the failure. A plain build is safe in this position: the
    // startup lock means exactly one instance builds it, and on a table this small it is brief.
    // If this table ever grows large enough for that build to be felt, build the index once with a
    // `CREATE INDEX CONCURRENTLY` migration ahead of the deploy; this statement then finds it and
    // does nothing.
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS admission_daily_counters_day ON admission_daily_counters (day)',
    );
    await this.#pool.query(
      'CREATE INDEX IF NOT EXISTS admission_counter_receipts_day ON admission_counter_receipts (day)',
    );
  }

  async consume(request: CounterRequest, now: Date): Promise<CounterOutcome> {
    const amount = request.amount ?? 1;
    const { key: counterKey, day } = counterRow(request, now);
    const resetAt = nextReset(now, request.window);
    // A zero limit can never be satisfied; skip the round trip and report the switched-off surface.
    if (request.limit <= 0) {
      return { allowed: false, used: 0, limit: request.limit, resetAt };
    }
    const result = await this.#pool.query<{ used: string }>(
      // `SELECT … WHERE` rather than `VALUES`: the very first call for a key takes the insert path, so
      // the ceiling has to be tested there too — otherwise an opening request larger than the whole
      // daily budget would be admitted exactly once.
      `INSERT INTO admission_daily_counters (counter_key, day, used)
       SELECT $1::text, $2::date, $3::bigint WHERE $3::bigint <= $4::bigint
       ON CONFLICT (counter_key, day) DO UPDATE
         SET used = admission_daily_counters.used + $3::bigint, updated_at = now()
         WHERE admission_daily_counters.used + $3::bigint <= $4::bigint
       RETURNING used`,
      [counterKey, day, amount, request.limit],
    );
    this.#maybePrune(now);
    const row = result.rows[0];
    if (row === undefined) {
      return {
        allowed: false,
        // The stored key, not the requested one: an hourly row carries its window in the key, and
        // reading the raw key would report a denied visitor as having used nothing.
        used: await this.#usedFor(counterKey, day),
        limit: request.limit,
        resetAt,
      };
    }
    return { allowed: true, used: Number(row.used), limit: request.limit, resetAt };
  }

  async consumeAll(requests: readonly CounterRequest[], now: Date): Promise<boolean> {
    const batch = normalizedBatch(requests, now);
    if (batch.some((entry) => entry.request.limit <= 0)) return false;

    const client = await this.#pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      if ((await consumeBatch(client, batch, now)).length > 0) return false;
      await client.query('COMMIT');
      committed = true;
      this.#maybePrune(now);
      return true;
    } finally {
      if (!committed) {
        // Handles both a deliberate denial and an aborted transaction after an unexpected failure.
        await client.query('ROLLBACK').catch(() => undefined);
      }
      client.release();
    }
  }

  async consumeAllOnce(
    requests: readonly CounterRequest[],
    attempt: { readonly key: string; readonly fingerprint: string },
    now: Date,
  ): Promise<AtomicCounterAttemptOutcome> {
    const batch = normalizedBatch(requests, now);
    const receipt = counterRow({ key: attempt.key }, now);
    const client = await this.#pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        receipt.key,
        receipt.day,
      ]);
      const prior = await client.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM admission_counter_receipts WHERE receipt_key=$1 AND day=$2',
        [receipt.key, receipt.day],
      );
      const existing = prior.rows[0];
      if (existing !== undefined) {
        await client.query('COMMIT');
        committed = true;
        return { kind: existing.fingerprint === attempt.fingerprint ? 'replayed' : 'conflict' };
      }
      const exhausted = await consumeBatch(client, batch, now);
      if (exhausted.length > 0) return { kind: 'refused', exhausted };
      await client.query(
        `INSERT INTO admission_counter_receipts (receipt_key, day, fingerprint)
         VALUES ($1,$2,$3)`,
        [receipt.key, receipt.day, attempt.fingerprint],
      );
      await client.query('COMMIT');
      committed = true;
      this.#maybePrune(now);
      return { kind: 'consumed' };
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  /**
   * Fire and forget, off the caller's latency path.
   *
   * Retention is housekeeping: a failed sweep means the table is briefly larger, where a sweep that
   * could fail a turn would mean a visitor is refused because a delete timed out. The interval is
   * marked before the query so a slow sweep cannot pile up behind itself.
   */
  #maybePrune(now: Date): void {
    const at = now.getTime();
    if (at - this.#prunedAt < PRUNE_INTERVAL_MS) return;
    this.#prunedAt = at;
    void this.prune(now).catch(() => undefined);
  }

  async prune(now: Date): Promise<number> {
    // `ctid` batching bounds one statement's work; the next sweep takes the next batch.
    const counters = await this.#pool.query(
      `DELETE FROM admission_daily_counters
        WHERE ctid IN (
          SELECT ctid FROM admission_daily_counters WHERE day < $1::date LIMIT $2::int
        )`,
      [retentionCutoff(now), PRUNE_BATCH],
    );
    const receipts = await this.#pool.query(
      `DELETE FROM admission_counter_receipts
        WHERE ctid IN (
          SELECT ctid FROM admission_counter_receipts WHERE day < $1::date LIMIT $2::int
        )`,
      [retentionCutoff(now), PRUNE_BATCH],
    );
    return (counters.rowCount ?? 0) + (receipts.rowCount ?? 0);
  }

  async #usedFor(counterKey: string, day: string): Promise<number> {
    const result = await this.#pool.query<{ used: string }>(
      'SELECT used FROM admission_daily_counters WHERE counter_key = $1 AND day = $2',
      [counterKey, day],
    );
    return result.rows[0] === undefined ? 0 : Number(result.rows[0].used);
  }

  async peek(key: string, now: Date): Promise<number> {
    const result = await this.#pool.query<{ used: string }>(
      'SELECT used FROM admission_daily_counters WHERE counter_key = $1 AND day = $2',
      [key, dayKey(now)],
    );
    return result.rows[0] === undefined ? 0 : Number(result.rows[0].used);
  }
}

interface CounterBatchEntry {
  readonly request: CounterRequest;
  readonly counterKey: string;
  readonly day: string;
  readonly amount: number;
}

function normalizedBatch(requests: readonly CounterRequest[], now: Date): CounterBatchEntry[] {
  const batch = requests
    .map((request) => {
      const row = counterRow(request, now);
      return { request, counterKey: row.key, day: row.day, amount: request.amount ?? 1 };
    })
    .sort(
      (left, right) =>
        left.day.localeCompare(right.day) || left.counterKey.localeCompare(right.counterKey),
    );
  const identities = batch.map((entry) => `${entry.day}:${entry.counterKey}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error('atomic counter requests must have distinct row identities');
  }
  return batch;
}

async function consumeBatch(
  client: PoolClient,
  batch: readonly CounterBatchEntry[],
  now: Date,
): Promise<readonly ExhaustedCounter[]> {
  const exhausted: ExhaustedCounter[] = [];
  for (const entry of batch) {
    await client.query(
      'INSERT INTO admission_daily_counters (counter_key, day, used) VALUES ($1,$2,0) ON CONFLICT DO NOTHING',
      [entry.counterKey, entry.day],
    );
    const result = await client.query<{ used: string }>(
      'SELECT used FROM admission_daily_counters WHERE counter_key=$1 AND day=$2 FOR UPDATE',
      [entry.counterKey, entry.day],
    );
    const used = Number(result.rows[0]?.used ?? 0);
    if (entry.request.limit <= 0 || used + entry.amount > entry.request.limit)
      exhausted.push({
        key: entry.request.key,
        limit: entry.request.limit,
        resetAt: nextReset(now, entry.request.window),
      });
  }
  if (exhausted.length > 0) return exhausted;
  for (const entry of batch)
    await client.query(
      'UPDATE admission_daily_counters SET used=used+$3, updated_at=now() WHERE counter_key=$1 AND day=$2',
      [entry.counterKey, entry.day, entry.amount],
    );
  return [];
}
