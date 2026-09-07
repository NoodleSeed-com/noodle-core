import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ensureMcpConfirmationNonceSchema,
  type McpConfirmationNoncePool,
  PostgresMcpConfirmationNonceLedger,
} from '../src/mcp-confirmation-nonce-postgres.js';

function poolWithRows(rowCounts: number[]): {
  readonly pool: McpConfirmationNoncePool;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ rowCount: rowCounts.shift() ?? 0 }));
  return { pool: { query }, query };
}

describe('Postgres MCP confirmation nonce ledger', () => {
  it('installs one additive short-TTL ledger table and expiry index', async () => {
    const fixture = poolWithRows([0, 0]);
    await ensureMcpConfirmationNonceSchema(fixture.pool);

    expect(fixture.query).toHaveBeenCalledTimes(2);
    expect(fixture.query.mock.calls[0]?.[0]).toContain(
      'CREATE TABLE IF NOT EXISTS mcp_confirmation_nonces',
    );
    expect(fixture.query.mock.calls[1]?.[0]).toContain('mcp_confirmation_nonces_expires_at_idx');
  });

  it('atomically admits a nonce once, stores only its hash, and rejects replay', async () => {
    const fixture = poolWithRows([1, 0]);
    const ledger = new PostgresMcpConfirmationNonceLedger(fixture.pool);
    const expiresAt = Date.UTC(2026, 6, 28, 12, 0, 0);

    await expect(ledger.consume('nonce-secret', expiresAt)).resolves.toBe(true);
    await expect(ledger.consume('nonce-secret', expiresAt)).resolves.toBe(false);

    const expectedHash = createHash('sha256').update('nonce-secret').digest('hex');
    expect(fixture.query.mock.calls[0]?.[0]).toContain('ON CONFLICT (nonce_hash) DO NOTHING');
    expect(fixture.query.mock.calls[0]?.[0]).toContain('SELECT $1, $2 WHERE $2 > now()');
    expect(fixture.query.mock.calls[0]?.[1]).toEqual([expectedHash, new Date(expiresAt)]);
    expect(JSON.stringify(fixture.query.mock.calls)).not.toContain('nonce-secret');
  });

  it('propagates storage unavailability so confirmation fails closed', async () => {
    const unavailable: McpConfirmationNoncePool = {
      query: vi.fn(async () => {
        throw new Error('postgres unavailable');
      }),
    };
    const ledger = new PostgresMcpConfirmationNonceLedger(unavailable);
    await expect(ledger.consume('nonce', Date.now() + 1_000)).rejects.toThrow(
      'postgres unavailable',
    );
  });
});

const DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const SCHEMA = `mcp_confirmation_nonce_${process.pid}`;

describe.skipIf(!DATABASE_URL)('Postgres MCP confirmation nonce concurrency', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 8,
      options: `-c search_path=${SCHEMA}`,
    });
    await ensureMcpConfirmationNonceSchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await admin?.end();
  });

  it('rejects expired nonces and admits exactly one concurrent live consume', async () => {
    const ledger = new PostgresMcpConfirmationNonceLedger(pool);
    const clock = await pool.query<{ now_ms: string }>(
      'SELECT floor(extract(epoch FROM now()) * 1000)::text AS now_ms',
    );
    const databaseNow = Number(clock.rows[0]?.now_ms);
    expect(Number.isSafeInteger(databaseNow)).toBe(true);
    await expect(ledger.consume('already-expired', databaseNow - 1)).resolves.toBe(false);

    const results = await Promise.all(
      Array.from({ length: 16 }, () => ledger.consume('one-live-nonce', databaseNow + 60_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
