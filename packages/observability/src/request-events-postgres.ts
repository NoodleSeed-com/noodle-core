import { randomUUID } from 'node:crypto';
import {
  type AccessMode,
  type AuditDetails,
  REQUEST_EVENT_SCHEMA_VERSION,
  type RequestEvent,
  type RequestEventFilter,
  type RequestEventInput,
  type RequestEventStore,
  type RequestKind,
  type RequestOutcome,
  type RequestSurface,
  redactDetails,
  type SessionSource,
  type SubjectKind,
} from '@noodle-borg/module';
import type { Pool } from 'pg';

/** Reads are always bounded: the metrics scan is the largest sanctioned window. */
const MAX_LIST_LIMIT = 50_000;
const DEFAULT_LIST_LIMIT = 10_000;

/**
 * Create the append-only `request_events` table if absent (idempotent; run once at startup). Like
 * `audit_events`, it has **no foreign key to `environments`** — the analytics stream carries plain
 * `org_slug`/`app_slug`/`environment` text so history survives tenant/app/env deletion and is pruned
 * only by retention (ADR 0121). `seq` (bigserial) gives stable newest-first order and a future cursor;
 * `details` is `jsonb` holding the already-redacted scalar bag.
 */
export async function ensureRequestEventSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS request_events (
      seq                  bigserial PRIMARY KEY,
      id                   uuid NOT NULL,
      schema_version       int NOT NULL,
      created_at           timestamptz NOT NULL,
      org_slug             text NOT NULL,
      app_slug             text,
      environment          text,
      deployment_id        text,
      server_version       text,
      sdk_protocol_version text,
      protocol_era         text,
      request_id           text NOT NULL,
      session_id           text,
      session_source       text NOT NULL,
      client_name          text,
      client_version       text,
      client_family        text,
      access_mode          text,
      surface              text,
      subject_kind         text NOT NULL,
      method               text NOT NULL,
      kind                 text NOT NULL,
      tool_name            text,
      resource_name        text,
      prompt_name          text,
      outcome              text NOT NULL,
      error_kind           text,
      duration_ms          double precision NOT NULL,
      queue_ms             double precision,
      exec_ms              double precision,
      output_tokens_est    int,
      country              text,
      details              jsonb
    )
  `);
  await pool.query(`
    ALTER TABLE request_events
      ADD COLUMN IF NOT EXISTS protocol_era text
  `);
  // Schema v2 (#1309): bounded client family, and the queue-vs-execution latency split.
  await pool.query(`
    ALTER TABLE request_events
      ADD COLUMN IF NOT EXISTS client_family text,
      ADD COLUMN IF NOT EXISTS queue_ms double precision,
      ADD COLUMN IF NOT EXISTS exec_ms double precision
  `);
  // Schema v3 (ADR 0220): the originating surface. Additive and unbackfilled — existing rows keep
  // a NULL surface and read back as unknown.
  await pool.query(`
    ALTER TABLE request_events
      ADD COLUMN IF NOT EXISTS surface text
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS request_events_tenant_time_idx
      ON request_events (org_slug, app_slug, environment, seq DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS request_events_tenant_method_time_idx
      ON request_events (org_slug, app_slug, environment, method, seq DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS request_events_session_idx
      ON request_events (org_slug, session_id)
      WHERE session_id IS NOT NULL
  `);
  // Retention prune deletes by `created_at < cutoff`; without this index every sweep is a full scan.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS request_events_created_at_idx
      ON request_events (created_at)
  `);
}

interface RequestEventRow {
  readonly seq: string | number;
  readonly id: string;
  readonly schema_version: number;
  readonly created_at: Date;
  readonly org_slug: string;
  readonly app_slug: string | null;
  readonly environment: string | null;
  readonly deployment_id: string | null;
  readonly server_version: string | null;
  readonly sdk_protocol_version: string | null;
  readonly protocol_era: string | null;
  readonly request_id: string;
  readonly session_id: string | null;
  readonly session_source: string;
  readonly client_name: string | null;
  readonly client_version: string | null;
  readonly client_family: string | null;
  readonly access_mode: string | null;
  readonly surface: string | null;
  readonly subject_kind: string;
  readonly method: string;
  readonly kind: string;
  readonly tool_name: string | null;
  readonly resource_name: string | null;
  readonly prompt_name: string | null;
  readonly outcome: string;
  readonly error_kind: string | null;
  readonly duration_ms: number;
  readonly queue_ms: number | null;
  readonly exec_ms: number | null;
  readonly output_tokens_est: number | null;
  readonly country: string | null;
  readonly details: AuditDetails | null;
}

/**
 * Relational system of record for the tenant-facing analytics stream (parallels
 * {@link InMemoryRequestEventStore}). The `pg.Pool` is injected; pure SQL, unit-testable against any
 * local Postgres (`DATABASE_URL_TEST`).
 */
export class PostgresRequestEventStore implements RequestEventStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, options: { now?: () => Date } = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
  }

  ensureSchema(): Promise<void> {
    return ensureRequestEventSchema(this.#pool);
  }

  async emit(input: RequestEventInput): Promise<void> {
    const details = redactDetails(input.details);
    await this.#pool.query(
      `INSERT INTO request_events
        (id, schema_version, created_at, org_slug, app_slug, environment, deployment_id,
         server_version, sdk_protocol_version, protocol_era, request_id, session_id, session_source,
         client_name, client_version, client_family, access_mode, surface, subject_kind, method, kind,
         tool_name, resource_name, prompt_name, outcome, error_kind, duration_ms, queue_ms, exec_ms,
         output_tokens_est, country, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [
        randomUUID(),
        REQUEST_EVENT_SCHEMA_VERSION,
        this.#now(),
        input.org,
        input.app ?? null,
        input.env ?? null,
        input.deploymentId ?? null,
        input.serverVersion ?? null,
        input.sdkProtocolVersion ?? null,
        input.protocolEra ?? null,
        input.requestId,
        input.sessionId ?? null,
        input.sessionSource,
        input.clientName ?? null,
        input.clientVersion ?? null,
        input.clientFamily ?? null,
        input.accessMode ?? null,
        input.surface ?? null,
        input.subjectKind,
        input.method,
        input.kind,
        input.toolName ?? null,
        input.resourceName ?? null,
        input.promptName ?? null,
        input.outcome,
        input.errorKind ?? null,
        input.durationMs,
        input.queueMs ?? null,
        input.execMs ?? null,
        input.outputTokensEst ?? null,
        input.country ?? null,
        details !== undefined ? JSON.stringify(details) : null,
      ],
    );
  }

  async list(filter: RequestEventFilter): Promise<readonly RequestEvent[]> {
    const clauses = ['org_slug = $1'];
    const values: unknown[] = [filter.org];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      clauses.push(`${column} = $${values.length}`);
    };
    if (filter.app !== undefined) add('app_slug', filter.app);
    if (filter.env !== undefined) add('environment', filter.env);
    if (filter.method !== undefined) add('method', filter.method);
    if (filter.outcome !== undefined) add('outcome', filter.outcome);
    if (filter.toolName !== undefined) add('tool_name', filter.toolName);
    if (filter.clientName !== undefined) add('client_name', filter.clientName);
    if (filter.surface !== undefined) add('surface', filter.surface);
    if (filter.sessionId !== undefined) add('session_id', filter.sessionId);
    if (filter.since !== undefined) {
      values.push(filter.since);
      clauses.push(`created_at >= $${values.length}`);
    }
    if (filter.until !== undefined) {
      values.push(filter.until);
      clauses.push(`created_at <= $${values.length}`);
    }
    // Always bounded: a missing limit gets the server-side default, and a malformed one can never
    // reach the SQL text (a raw `Number(...)` here would produce `LIMIT NaN`).
    const requested = Math.floor(Number(filter.limit));
    const limit =
      Number.isFinite(requested) && requested >= 0
        ? Math.min(requested, MAX_LIST_LIMIT)
        : DEFAULT_LIST_LIMIT;
    const { rows } = await this.#pool.query<RequestEventRow>(
      `SELECT * FROM request_events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ${limit}`,
      values,
    );
    return rows.map(rowToEvent);
  }

  /** Delete events older than the retention window (Stage-A default retention; called by the sweeper). */
  async prune(olderThan: Date): Promise<number> {
    const { rowCount } = await this.#pool.query(
      'DELETE FROM request_events WHERE created_at < $1',
      [olderThan],
    );
    return rowCount ?? 0;
  }
}

function rowToEvent(row: RequestEventRow): RequestEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    schemaVersion: row.schema_version,
    createdAt: row.created_at.toISOString(),
    org: row.org_slug,
    requestId: row.request_id,
    sessionSource: row.session_source as SessionSource,
    subjectKind: row.subject_kind as SubjectKind,
    method: row.method,
    kind: row.kind as RequestKind,
    outcome: row.outcome as RequestOutcome,
    durationMs: row.duration_ms,
    ...(row.app_slug !== null ? { app: row.app_slug } : {}),
    ...(row.environment !== null ? { env: row.environment } : {}),
    ...(row.deployment_id !== null ? { deploymentId: row.deployment_id } : {}),
    ...(row.server_version !== null ? { serverVersion: row.server_version } : {}),
    ...(row.sdk_protocol_version !== null ? { sdkProtocolVersion: row.sdk_protocol_version } : {}),
    ...(row.protocol_era !== null
      ? { protocolEra: row.protocol_era as NonNullable<RequestEvent['protocolEra']> }
      : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.client_name !== null ? { clientName: row.client_name } : {}),
    ...(row.client_version !== null ? { clientVersion: row.client_version } : {}),
    ...(row.client_family !== null ? { clientFamily: row.client_family } : {}),
    ...(row.access_mode !== null ? { accessMode: row.access_mode as AccessMode } : {}),
    ...(row.surface !== null ? { surface: row.surface as RequestSurface } : {}),
    ...(row.tool_name !== null ? { toolName: row.tool_name } : {}),
    ...(row.resource_name !== null ? { resourceName: row.resource_name } : {}),
    ...(row.prompt_name !== null ? { promptName: row.prompt_name } : {}),
    ...(row.error_kind !== null ? { errorKind: row.error_kind } : {}),
    ...(row.queue_ms !== null ? { queueMs: row.queue_ms } : {}),
    ...(row.exec_ms !== null ? { execMs: row.exec_ms } : {}),
    ...(row.output_tokens_est !== null ? { outputTokensEst: row.output_tokens_est } : {}),
    ...(row.country !== null ? { country: row.country } : {}),
    ...(row.details !== null ? { details: row.details } : {}),
  };
}
