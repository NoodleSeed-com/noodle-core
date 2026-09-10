import type { Pool } from 'pg';
import type { PublicEmbedBudget, PublicEmbedRecord, PublicEmbedStore } from './embed-store.js';
import { newPublicEmbedId } from './in-memory-embed-store.js';

interface EmbedRow {
  readonly embed_id: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly surface_mode: 'public' | 'mixed';
  readonly created_at: Date;
  readonly revoked_at: Date | null;
  readonly turns_per_day: string | null;
  readonly mints_per_day: string | null;
  readonly mints_per_address_hour: string | null;
  readonly turns_per_address_hour: string | null;
  readonly bridge_tool_calls_per_session: string | null;
  readonly bridge_tool_calls_per_day: string | null;
}

function toRecord(row: EmbedRow): PublicEmbedRecord {
  return {
    embedId: row.embed_id,
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    surfaceMode: row.surface_mode,
    createdAt: row.created_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    // `bigint` arrives as a string; null stays undefined so "no override" and "zero" never merge.
    ...(row.turns_per_day === null ? {} : { turnsPerDay: Number(row.turns_per_day) }),
    ...(row.mints_per_day === null ? {} : { mintsPerDay: Number(row.mints_per_day) }),
    ...(row.mints_per_address_hour === null
      ? {}
      : { mintsPerAddressHour: Number(row.mints_per_address_hour) }),
    ...(row.turns_per_address_hour === null
      ? {}
      : { turnsPerAddressHour: Number(row.turns_per_address_hour) }),
    ...(row.bridge_tool_calls_per_session === null
      ? {}
      : { bridgeToolCallsPerSession: Number(row.bridge_tool_calls_per_session) }),
    ...(row.bridge_tool_calls_per_day === null
      ? {}
      : { bridgeToolCallsPerDay: Number(row.bridge_tool_calls_per_day) }),
  };
}

/**
 * Durable public embed identifiers.
 *
 * The table has **no secret column** — see `embed-store.ts` for why that is the point rather than an
 * omission. A partial unique index over live rows is what makes `ensure` idempotent under concurrency:
 * two simultaneous deploys of the same tenant surface cannot mint two live ids, and a revoked row does
 * not block a later one, so revoke-then-redeploy issues a genuinely new id instead of reviving the old.
 */
export class PostgresPublicEmbedStore implements PublicEmbedStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_public_embeds (
        embed_id text PRIMARY KEY,
        org_slug text NOT NULL,
        app_slug text NOT NULL,
        environment text NOT NULL,
        surface_mode text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz
      )
    `);
    await this.#pool.query(
      'ALTER TABLE assistant_public_embeds ADD COLUMN IF NOT EXISTS turns_per_day bigint',
    );
    await this.#pool.query(
      'ALTER TABLE assistant_public_embeds ADD COLUMN IF NOT EXISTS mints_per_day bigint',
    );
    await this.#pool.query(
      'ALTER TABLE assistant_public_embeds ADD COLUMN IF NOT EXISTS mints_per_address_hour bigint',
    );
    await this.#pool.query(
      'ALTER TABLE assistant_public_embeds ADD COLUMN IF NOT EXISTS turns_per_address_hour bigint',
    );
    // The bridge budgets became operator-settable after they shipped platform-only (ADR 0220);
    // additive like every column above it, so an existing row simply keeps using the defaults.
    await this.#pool.query(
      'ALTER TABLE assistant_public_embeds ADD COLUMN IF NOT EXISTS bridge_tool_calls_per_session bigint',
    );
    await this.#pool.query(
      'ALTER TABLE assistant_public_embeds ADD COLUMN IF NOT EXISTS bridge_tool_calls_per_day bigint',
    );
    await this.#pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS assistant_public_embeds_live
        ON assistant_public_embeds (org_slug, app_slug, environment)
        WHERE revoked_at IS NULL
    `);
  }

  async ensure(input: {
    readonly org: string;
    readonly app: string;
    readonly env: string;
    readonly surfaceMode: 'public' | 'mixed';
    readonly now: Date;
    /** Installation recovery preserves revocation; explicit redeploy may replace it by default. */
    readonly allowRevokedReplacement?: boolean;
  }): Promise<PublicEmbedRecord> {
    // `DO NOTHING` plus a follow-up read rather than `DO UPDATE`: a redeploy must return the *existing*
    // id untouched, including its original `created_at`, because that id is already in page source.
    const inserted = await this.#pool.query<EmbedRow>(
      `INSERT INTO assistant_public_embeds
         (embed_id, org_slug, app_slug, environment, surface_mode, created_at)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE $7::boolean OR NOT EXISTS (SELECT 1 FROM assistant_public_embeds
         WHERE org_slug = $2 AND app_slug = $3 AND environment = $4)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        newPublicEmbedId(),
        input.org,
        input.app,
        input.env,
        input.surfaceMode,
        input.now,
        input.allowRevokedReplacement !== false,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return toRecord(row);

    const existing = await this.#pool.query<EmbedRow>(
      `SELECT * FROM assistant_public_embeds
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3 AND revoked_at IS NULL`,
      [input.org, input.app, input.env],
    );
    const found = existing.rows[0];
    if (found === undefined) throw new Error('public embed id could not be resolved after insert');
    return toRecord(found);
  }

  async setBudget(
    embedId: string,
    budget: PublicEmbedBudget,
    _now: Date,
  ): Promise<PublicEmbedRecord | undefined> {
    // COALESCE on the parameter, not the column: passing null leaves that cap as it was, so raising
    // turns cannot quietly clear a mint ceiling someone set separately.
    const result = await this.#pool.query<EmbedRow>(
      `UPDATE assistant_public_embeds
         SET turns_per_day = COALESCE($2::bigint, turns_per_day),
             mints_per_day = COALESCE($3::bigint, mints_per_day),
             mints_per_address_hour = COALESCE($4::bigint, mints_per_address_hour),
             turns_per_address_hour = COALESCE($5::bigint, turns_per_address_hour),
             bridge_tool_calls_per_session = COALESCE($6::bigint, bridge_tool_calls_per_session),
             bridge_tool_calls_per_day = COALESCE($7::bigint, bridge_tool_calls_per_day)
       WHERE embed_id = $1 AND revoked_at IS NULL
       RETURNING *`,
      [
        embedId,
        budget.turnsPerDay ?? null,
        budget.mintsPerDay ?? null,
        budget.mintsPerAddressHour ?? null,
        budget.turnsPerAddressHour ?? null,
        budget.bridgeToolCallsPerSession ?? null,
        budget.bridgeToolCallsPerDay ?? null,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async lookup(embedId: string): Promise<PublicEmbedRecord | undefined> {
    const result = await this.#pool.query<EmbedRow>(
      'SELECT * FROM assistant_public_embeds WHERE embed_id = $1 AND revoked_at IS NULL',
      [embedId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async list(
    tenant: {
      readonly org: string;
      readonly app: string;
      readonly env: string;
    },
    options?: { readonly includeRevoked?: boolean },
  ): Promise<readonly PublicEmbedRecord[]> {
    const result = await this.#pool.query<EmbedRow>(
      `SELECT * FROM assistant_public_embeds
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3 AND ($4::boolean OR revoked_at IS NULL)
       ORDER BY created_at`,
      [tenant.org, tenant.app, tenant.env, options?.includeRevoked === true],
    );
    return result.rows.map(toRecord);
  }

  async revoke(embedId: string, now: Date): Promise<boolean> {
    const result = await this.#pool.query(
      'UPDATE assistant_public_embeds SET revoked_at = $2 WHERE embed_id = $1 AND revoked_at IS NULL',
      [embedId, now],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
