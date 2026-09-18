import type { Pool, PoolClient } from 'pg';
import {
  type ChannelCipher,
  type ChannelRow,
  type ChannelScan,
  type ChannelStore,
  type ChannelTransaction,
  channelScanLimit,
  requireChannelLock,
} from './channel-store.js';

interface StoredChannelRow {
  id: string;
  kind: ChannelRow['kind'];
  state: string | null;
  updated_at: string;
  expires_at: string | null;
  sealed: unknown;
}

/** Logged, encrypted journal with per-binding locks. No state relies on a surviving worker process. */
export class PostgresChannelStore implements ChannelStore {
  readonly durable = true;
  constructor(
    private readonly pool: Pool,
    private readonly cipher: ChannelCipher,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS assistant_channel_records (
      scope text NOT NULL, id text NOT NULL, kind text NOT NULL, state text,
      updated_at bigint NOT NULL, expires_at bigint, sealed jsonb NOT NULL,
      PRIMARY KEY(scope,id))`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS assistant_channel_scan
      ON assistant_channel_records(scope,kind,state,id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS assistant_channel_expiry
      ON assistant_channel_records(expires_at) WHERE expires_at IS NOT NULL`);
  }

  async transaction<T>(
    locks: readonly string[],
    work: (tx: ChannelTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      for (const scope of [...new Set(locks)].sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 713))', [scope]);
      }
      const result = await work(this.transactionView(client, locks));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private transactionView(client: PoolClient, locks: readonly string[]): ChannelTransaction {
    const read = async (scope: string, rows: readonly StoredChannelRow[]): Promise<ChannelRow[]> =>
      Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          kind: row.kind,
          ...(row.state === null ? {} : { state: row.state }),
          updatedAt: Number(row.updated_at),
          ...(row.expires_at === null ? {} : { expiresAt: Number(row.expires_at) }),
          value: await this.cipher.open(scope, row.id, row.sealed),
        })),
      );
    return {
      get: async (scope, id) => {
        requireChannelLock(locks, scope);
        const result = await client.query<StoredChannelRow>(
          'SELECT * FROM assistant_channel_records WHERE scope=$1 AND id=$2',
          [scope, id],
        );
        return (await read(scope, result.rows))[0];
      },
      put: async (scope, row) => {
        requireChannelLock(locks, scope);
        const sealed = await this.cipher.seal(scope, row.id, row.value);
        await client.query(
          `INSERT INTO assistant_channel_records(scope,id,kind,state,updated_at,expires_at,sealed)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(scope,id) DO UPDATE SET
          kind=EXCLUDED.kind,state=EXCLUDED.state,updated_at=EXCLUDED.updated_at,
          expires_at=EXCLUDED.expires_at,sealed=EXCLUDED.sealed`,
          [
            scope,
            row.id,
            row.kind,
            row.state ?? null,
            row.updatedAt,
            row.expiresAt ?? null,
            JSON.stringify(sealed),
          ],
        );
      },
      remove: async (scope, id) => {
        requireChannelLock(locks, scope);
        await client.query('DELETE FROM assistant_channel_records WHERE scope=$1 AND id=$2', [
          scope,
          id,
        ]);
      },
      count: async (scope, kind, state, now) => {
        requireChannelLock(locks, scope);
        const result = await client.query<{ count: string }>(
          'SELECT count(*) FROM assistant_channel_records WHERE scope=$1 AND kind=$2 AND state=$3 AND (expires_at IS NULL OR expires_at > $4)',
          [scope, kind, state, now],
        );
        return Number(result.rows[0]!.count);
      },
      list: async (scope: string, scan: ChannelScan) => {
        requireChannelLock(locks, scope);
        const result = await client.query<StoredChannelRow>(
          `SELECT * FROM assistant_channel_records
          WHERE scope=$1 AND kind=$2 AND ($3::text IS NULL OR state=$3)
          AND ($4::text IS NULL OR id COLLATE "C" > $4 COLLATE "C")
          ORDER BY id COLLATE "C" LIMIT $5`,
          [scope, scan.kind, scan.state ?? null, scan.after ?? null, channelScanLimit(scan.limit)],
        );
        return read(scope, result.rows);
      },
    };
  }

  async prune(now: number, limit: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM assistant_channel_records WHERE (scope,id) IN (
      SELECT scope,id FROM assistant_channel_records WHERE expires_at <= $1
      ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [now, channelScanLimit(limit)],
    );
    return result.rowCount ?? 0;
  }
}
