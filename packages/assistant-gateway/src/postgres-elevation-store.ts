import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ASSISTANT_ELEVATION_TTL_MS,
  type AssistantElevationClaim,
  type AssistantElevationRecord,
  type AssistantElevationStore,
  elevationContinuation,
  elevationDigest,
} from './elevation-store.js';
import type { TenantRef } from './tenant-ref.js';

interface ElevationRow {
  readonly id: string;
  readonly session_id: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly tool: string;
  readonly claimable_state_handles: string[];
  readonly continuation_hash: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly claimed_at: Date | null;
}

function toRecord(row: ElevationRow): AssistantElevationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenant: { org: row.org_slug, app: row.app_slug, env: row.environment },
    tool: row.tool,
    claimableStateHandles: [...(row.claimable_state_handles ?? [])],
    continuationHash: row.continuation_hash,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at.toISOString() }),
  };
}

/**
 * Durable elevation continuations.
 *
 * Two properties are load-bearing and both are enforced by the database rather than by application
 * order. A **partial unique index over unclaimed rows** keeps at most one live elevation per session, so
 * a model asking twice supersedes rather than accumulating keys to the same conversation. And the claim
 * is a **single statement** — `UPDATE … WHERE claimed_at IS NULL … RETURNING` — because two backends
 * racing the same continuation is exactly the case a read-then-write loses, and the loser would elevate
 * a second time.
 *
 * The refusal reasons are distinguished by re-reading the row *without* consuming it: a tenant mismatch
 * must not spend the rightful owner's continuation, or a probe becomes a denial of service.
 */
export class PostgresAssistantElevationStore implements AssistantElevationStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_elevations (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        org_slug text NOT NULL,
        app_slug text NOT NULL,
        environment text NOT NULL,
        tool text NOT NULL,
        claimable_state_handles jsonb NOT NULL DEFAULT '[]'::jsonb,
        continuation_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        claimed_at timestamptz
      )
    `);
    await this.#pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_elevations_continuation_key
         ON assistant_elevations (continuation_hash)`,
    );
    await this.#pool.query(`
      ALTER TABLE assistant_elevations
        ADD COLUMN IF NOT EXISTS claimable_state_handles jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await this.#pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_elevations_live_session_key
         ON assistant_elevations (session_id) WHERE claimed_at IS NULL`,
    );
  }

  async request(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly tool: string;
    readonly claimableStateHandles?: readonly string[];
    readonly now: Date;
  }): Promise<{ readonly elevation: AssistantElevationRecord; readonly continuation: string }> {
    // Delete before insert so the partial unique index cannot reject the supersede.
    await this.#pool.query(
      'DELETE FROM assistant_elevations WHERE session_id = $1 AND claimed_at IS NULL',
      [input.sessionId],
    );
    const continuation = elevationContinuation();
    const { rows } = await this.#pool.query<ElevationRow>(
      `INSERT INTO assistant_elevations
         (id, session_id, org_slug, app_slug, environment, tool, claimable_state_handles,
          continuation_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING *`,
      [
        `elev_${randomUUID().replaceAll('-', '')}`,
        input.sessionId,
        input.tenant.org,
        input.tenant.app,
        input.tenant.env,
        input.tool,
        JSON.stringify([...(input.claimableStateHandles ?? [])].sort()),
        elevationDigest(continuation),
        input.now.toISOString(),
        new Date(input.now.getTime() + ASSISTANT_ELEVATION_TTL_MS).toISOString(),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('elevation insert returned no row');
    return { elevation: toRecord(row), continuation };
  }

  async claim(input: {
    readonly continuation: string;
    readonly tenant: TenantRef;
    readonly now: Date;
  }): Promise<AssistantElevationClaim> {
    const hash = elevationDigest(input.continuation);
    const { rows } = await this.#pool.query<ElevationRow>(
      `UPDATE assistant_elevations
          SET claimed_at = $2
        WHERE continuation_hash = $1
          AND claimed_at IS NULL
          AND expires_at > $2
          AND org_slug = $3 AND app_slug = $4 AND environment = $5
        RETURNING *`,
      [hash, input.now.toISOString(), input.tenant.org, input.tenant.app, input.tenant.env],
    );
    const claimed = rows[0];
    if (claimed) return { ok: true, elevation: toRecord(claimed) };

    // Nothing was spent. Re-read to say *why* without consuming anything, so a wrong-tenant probe
    // cannot deny the rightful owner their elevation.
    const { rows: existing } = await this.#pool.query<ElevationRow>(
      'SELECT * FROM assistant_elevations WHERE continuation_hash = $1',
      [hash],
    );
    const row = existing[0];
    if (!row || row.claimed_at !== null) return { ok: false, reason: 'unknown' };
    if (
      row.org_slug !== input.tenant.org ||
      row.app_slug !== input.tenant.app ||
      row.environment !== input.tenant.env
    ) {
      return { ok: false, reason: 'tenant_mismatch' };
    }
    return { ok: false, reason: 'expired' };
  }
}
