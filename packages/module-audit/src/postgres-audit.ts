import { randomUUID } from 'node:crypto';
import {
  AUDIT_SCHEMA_VERSION,
  type AuditDecision,
  type AuditDetails,
  type AuditEvent,
  type AuditEventInput,
  type AuditFilter,
  type AuditStore,
  redactDetails,
} from '@noodle-borg/module';
import type { Pool } from 'pg';

export type PostgresAuditQueryable = Pick<Pool, 'query'>;

export interface PostgresAuditInsertOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
}

/**
 * Create the append-only `audit_events` table if absent (idempotent; run once at startup). Unlike
 * `deploy_records`/`config_values`, this table has **no foreign key to `environments`** — audit evidence
 * must survive tenant/app/env deletion, so it carries plain `org_slug`/`app_slug`/`environment` text and is
 * never cascade-deleted. `seq` (bigserial) gives a stable newest-first order and a future cursor for the
 * audit query API; `details` is `jsonb` holding the already-redacted scalar bag.
 */
export async function ensureAuditSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_events (
      seq            bigserial PRIMARY KEY,
      id             uuid NOT NULL,
      event_type     text NOT NULL,
      org_slug       text NOT NULL,
      app_slug       text,
      environment    text,
      deployment_id  text,
      actor_subject  text,
      actor_email    text,
      decision       text,
      status         text,
      reason_code    text,
      schema_version int NOT NULL,
      details        jsonb,
      created_at     timestamptz NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx
      ON audit_events (org_slug, app_slug, environment, seq DESC)
  `);
}

interface AuditRow {
  readonly id: string;
  readonly event_type: string;
  readonly org_slug: string;
  readonly app_slug: string | null;
  readonly environment: string | null;
  readonly deployment_id: string | null;
  readonly actor_subject: string | null;
  readonly actor_email: string | null;
  readonly decision: string | null;
  readonly status: string | null;
  readonly reason_code: string | null;
  readonly schema_version: number;
  readonly details: AuditDetails | null;
  readonly created_at: Date;
}

/**
 * Insert one canonical, redacted audit row through either a pool or an already-open transaction client.
 * This helper deliberately does not manage a transaction: callers using a `PoolClient` keep the audit
 * evidence in the same commit boundary as the state change it records.
 */
export async function insertAuditEvent(
  queryable: PostgresAuditQueryable,
  input: AuditEventInput,
  options: PostgresAuditInsertOptions = {},
): Promise<void> {
  const details = redactDetails(input.details);
  await queryable.query(
    `INSERT INTO audit_events
      (id, event_type, org_slug, app_slug, environment, deployment_id, actor_subject, actor_email,
       decision, status, reason_code, schema_version, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      (options.id ?? randomUUID)(),
      input.eventType,
      input.org,
      input.app ?? null,
      input.env ?? null,
      input.deploymentId ?? null,
      input.actorSubject ?? null,
      input.actorEmail ?? null,
      input.decision ?? null,
      input.status !== undefined ? String(input.status) : null,
      input.reasonCode ?? null,
      AUDIT_SCHEMA_VERSION,
      details !== undefined ? JSON.stringify(details) : null,
      (options.now ?? (() => new Date()))(),
    ],
  );
}

/**
 * Relational system of record for {@link AuditEvent}s (parallels {@link InMemoryAuditStore}). The `pg.Pool`
 * is injected; this class is pure SQL and unit-testable against any local Postgres.
 */
export class PostgresAuditStore implements AuditStore {
  readonly #pool: Pool;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(pool: Pool, options: PostgresAuditInsertOptions = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  ensureSchema(): Promise<void> {
    return ensureAuditSchema(this.#pool);
  }

  async emit(input: AuditEventInput): Promise<void> {
    await insertAuditEvent(this.#pool, input, { now: this.#now, id: this.#id });
  }

  async list(filter: AuditFilter): Promise<readonly AuditEvent[]> {
    const org = validateSlug('org', filter.org);
    const clauses = ['org_slug = $1'];
    const values: unknown[] = [org];
    if (filter.app !== undefined) {
      values.push(filter.app);
      clauses.push(`app_slug = $${values.length}`);
    }
    if (filter.env !== undefined) {
      values.push(filter.env);
      clauses.push(`environment = $${values.length}`);
    }
    if (filter.eventType !== undefined) {
      values.push(filter.eventType);
      clauses.push(`event_type = $${values.length}`);
    }
    const limit = filter.limit !== undefined ? ` LIMIT ${Number(filter.limit)}` : '';
    const { rows } = await this.#pool.query<AuditRow>(
      `SELECT * FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC${limit}`,
      values,
    );
    return rows.map(rowToEvent);
  }
}

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    eventType: row.event_type,
    org: row.org_slug,
    createdAt: row.created_at.toISOString(),
    ...(row.app_slug !== null ? { app: row.app_slug } : {}),
    ...(row.environment !== null ? { env: row.environment } : {}),
    ...(row.deployment_id !== null ? { deploymentId: row.deployment_id } : {}),
    ...(row.actor_subject !== null ? { actorSubject: row.actor_subject } : {}),
    ...(row.actor_email !== null ? { actorEmail: row.actor_email } : {}),
    ...(row.decision !== null ? { decision: row.decision as AuditDecision } : {}),
    ...(row.status !== null ? { status: row.status } : {}),
    ...(row.reason_code !== null ? { reasonCode: row.reason_code } : {}),
    ...(row.details !== null ? { details: row.details } : {}),
  };
}

function validateSlug(label: string, value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error(`${label} must be a lowercase slug`);
  }
  return value;
}
