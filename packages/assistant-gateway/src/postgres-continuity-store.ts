import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  type AssistantContinuityClaim,
  type AssistantContinuityContext,
  type AssistantContinuityRecord,
  type AssistantContinuityStore,
  continuityDigest,
  continuityHandle,
  continuityMaxRestores,
  continuityWindowMs,
} from './continuity-store.js';
import type { TenantRef } from './tenant-ref.js';

interface ContinuityRow {
  readonly id: string;
  readonly session_id: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly embed_id: string;
  readonly origin_hash: string;
  readonly visitor_hash: string;
  readonly handle_hash: string;
  readonly restore_count: number;
  readonly max_restores: number;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly claimed_at: Date | null;
}

function toRecord(row: ContinuityRow): AssistantContinuityRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenant: { org: row.org_slug, app: row.app_slug, env: row.environment },
    context: {
      embedId: row.embed_id,
      originHash: row.origin_hash,
      visitorHash: row.visitor_hash,
    },
    handleHash: row.handle_hash,
    restoreCount: row.restore_count,
    maxRestores: row.max_restores,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at.toISOString() }),
  };
}

/**
 * Durable continuity handles (ADR 0223, clauses 11-16).
 *
 * Its own table, deliberately not a second row kind in `assistant_elevations`. A display-only handle and
 * an identity-transition ticket must not share storage, so that a defect in either cannot reach the
 * other and a reader never has to work out which rows are dangerous.
 *
 * Two properties are enforced by the database rather than by application order, exactly as they are for
 * elevations. A **partial unique index over unclaimed rows** keeps at most one live handle per session,
 * so each turn's handle supersedes rather than accumulating one live key per turn. And the claim is a
 * **single statement** — `UPDATE … WHERE claimed_at IS NULL … RETURNING` — because two backends racing
 * one handle is precisely the case a read-then-write loses, and the loser would restore a second time.
 *
 * The refusal reasons are distinguished by re-reading the row *without* consuming it: a wrong-context
 * probe must not spend the rightful visitor's handle, or reading someone's conversation becomes
 * unnecessary and denying it becomes trivial.
 */
export class PostgresAssistantContinuityStore implements AssistantContinuityStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_continuity_handles (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        org_slug text NOT NULL,
        app_slug text NOT NULL,
        environment text NOT NULL,
        embed_id text NOT NULL,
        origin_hash text NOT NULL,
        visitor_hash text NOT NULL,
        handle_hash text NOT NULL,
        restore_count integer NOT NULL DEFAULT 0,
        max_restores integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        claimed_at timestamptz
      )
    `);
    await this.#pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_continuity_handle_key
         ON assistant_continuity_handles (handle_hash)`,
    );
    await this.#pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS assistant_continuity_live_session_key
         ON assistant_continuity_handles (session_id) WHERE claimed_at IS NULL`,
    );
    // Retention is part of this store rather than an afterthought: handles are short-lived and must be
    // swept, not accumulated, and the sweep needs this index to stay cheap as the table grows.
    await this.#pool.query(
      `CREATE INDEX IF NOT EXISTS assistant_continuity_expires_at_idx
         ON assistant_continuity_handles (expires_at)`,
    );
  }

  async issue(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly context: AssistantContinuityContext;
    readonly windowMs?: number;
    readonly maxRestores?: number;
    readonly now: Date;
  }): Promise<{ readonly record: AssistantContinuityRecord; readonly handle: string } | undefined> {
    return this.#write({ ...input, restoreCount: 0 });
  }

  async claim(input: {
    readonly handle: string;
    readonly context: AssistantContinuityContext;
    readonly now: Date;
  }): Promise<AssistantContinuityClaim> {
    const hash = continuityDigest(input.handle);
    const { rows } = await this.#pool.query<ContinuityRow>(
      `UPDATE assistant_continuity_handles
          SET claimed_at = $2, restore_count = restore_count + 1
        WHERE handle_hash = $1
          AND claimed_at IS NULL
          AND expires_at > $2
          AND embed_id = $3 AND origin_hash = $4 AND visitor_hash = $5
        RETURNING *`,
      [
        hash,
        input.now.toISOString(),
        input.context.embedId,
        input.context.originHash,
        input.context.visitorHash,
      ],
    );
    const claimed = rows[0];
    if (!claimed) return this.#explainRefusal(hash, input.context);

    const record = toRecord(claimed);
    if (record.restoreCount >= record.maxRestores) return { ok: true, record };

    const rotated = await this.#write({
      sessionId: record.sessionId,
      tenant: record.tenant,
      context: record.context,
      // Re-derive from the record so a rotation can never widen what the first issue clamped.
      windowMs: Date.parse(record.expiresAt) - Date.parse(record.createdAt),
      maxRestores: record.maxRestores,
      restoreCount: record.restoreCount,
      now: input.now,
    });
    return rotated === undefined
      ? { ok: true, record }
      : { ok: true, record, handle: rotated.handle };
  }

  /** Remove spent and expired rows. Callers may lag expiry: `claim` already refuses a stale handle. */
  async sweepExpired(input: { readonly now: Date }): Promise<number> {
    const { rowCount } = await this.#pool.query(
      'DELETE FROM assistant_continuity_handles WHERE expires_at <= $1 OR claimed_at IS NOT NULL',
      [input.now.toISOString()],
    );
    return rowCount ?? 0;
  }

  async #explainRefusal(
    hash: string,
    context: AssistantContinuityContext,
  ): Promise<AssistantContinuityClaim> {
    const { rows } = await this.#pool.query<ContinuityRow>(
      'SELECT * FROM assistant_continuity_handles WHERE handle_hash = $1',
      [hash],
    );
    const row = rows[0];
    if (!row || row.claimed_at !== null) return { ok: false, reason: 'unknown' };
    if (
      row.embed_id !== context.embedId ||
      row.origin_hash !== context.originHash ||
      row.visitor_hash !== context.visitorHash
    ) {
      return { ok: false, reason: 'context_mismatch' };
    }
    return { ok: false, reason: 'expired' };
  }

  async #write(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly context: AssistantContinuityContext;
    readonly windowMs?: number;
    readonly maxRestores?: number;
    readonly restoreCount: number;
    readonly now: Date;
  }): Promise<{ readonly record: AssistantContinuityRecord; readonly handle: string } | undefined> {
    const windowMs = continuityWindowMs(input.windowMs);
    const maxRestores = continuityMaxRestores(input.maxRestores);
    if (windowMs === 0 || maxRestores === 0) return undefined;

    // Delete before insert so the partial unique index cannot reject the supersede.
    await this.#pool.query(
      'DELETE FROM assistant_continuity_handles WHERE session_id = $1 AND claimed_at IS NULL',
      [input.sessionId],
    );
    const handle = continuityHandle();
    const { rows } = await this.#pool.query<ContinuityRow>(
      `INSERT INTO assistant_continuity_handles
         (id, session_id, org_slug, app_slug, environment, embed_id, origin_hash, visitor_hash,
          handle_hash, restore_count, max_restores, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        `cont_${randomUUID().replaceAll('-', '')}`,
        input.sessionId,
        input.tenant.org,
        input.tenant.app,
        input.tenant.env,
        input.context.embedId,
        input.context.originHash,
        input.context.visitorHash,
        continuityDigest(handle),
        input.restoreCount,
        maxRestores,
        input.now.toISOString(),
        new Date(input.now.getTime() + windowMs).toISOString(),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('continuity insert returned no row');
    return { record: toRecord(row), handle };
  }
}
