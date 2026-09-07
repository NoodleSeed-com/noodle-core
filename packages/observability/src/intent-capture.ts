import { randomUUID } from 'node:crypto';
import {
  INTENT_CAPTURE_SCHEMA_VERSION,
  type IntentCaptureMode,
  type IntentCategory,
  type IntentEvent,
  type IntentEventFilter,
  type IntentEventInput,
  type IntentEventSink,
  type IntentEventStore,
  type IntentMatch,
  type RequestOutcome,
} from '@noodle-borg/module';
import type { Pool } from 'pg';

const DEFAULT_CAP = 10_000;
const MAX_LIST_LIMIT = 50_000;
const DEFAULT_LIST_LIMIT = 10_000;

export interface IntentTenantRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export interface IntentCaptureSetting extends IntentTenantRef {
  readonly mode: Exclude<IntentCaptureMode, 'off'>;
  readonly updatedAt: string;
  readonly updatedBySubject?: string;
}

export interface IntentCaptureSettingsStore {
  get(ref: IntentTenantRef): Promise<IntentCaptureSetting | undefined>;
  set(
    ref: IntentTenantRef,
    mode: Exclude<IntentCaptureMode, 'off'>,
    updatedBySubject?: string,
  ): Promise<IntentCaptureSetting>;
  delete(ref: IntentTenantRef): Promise<boolean>;
}

export class InMemoryIntentCaptureSettingsStore implements IntentCaptureSettingsStore {
  readonly #records = new Map<string, IntentCaptureSetting>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  get(ref: IntentTenantRef): Promise<IntentCaptureSetting | undefined> {
    return Promise.resolve(this.#records.get(refKey(ref)));
  }

  set(
    ref: IntentTenantRef,
    mode: Exclude<IntentCaptureMode, 'off'>,
    updatedBySubject?: string,
  ): Promise<IntentCaptureSetting> {
    const record: IntentCaptureSetting = {
      ...ref,
      mode,
      updatedAt: this.#now().toISOString(),
      ...(updatedBySubject === undefined ? {} : { updatedBySubject }),
    };
    this.#records.set(refKey(ref), record);
    return Promise.resolve(record);
  }

  delete(ref: IntentTenantRef): Promise<boolean> {
    return Promise.resolve(this.#records.delete(refKey(ref)));
  }
}

export class PostgresIntentCaptureSettingsStore implements IntentCaptureSettingsStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async get(ref: IntentTenantRef): Promise<IntentCaptureSetting | undefined> {
    const { rows } = await this.#pool.query<IntentSettingRow>(
      `SELECT * FROM intent_capture_settings
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3`,
      [ref.org, ref.app, ref.env],
    );
    return rows[0] === undefined ? undefined : settingFromRow(rows[0]);
  }

  async set(
    ref: IntentTenantRef,
    mode: Exclude<IntentCaptureMode, 'off'>,
    updatedBySubject?: string,
  ): Promise<IntentCaptureSetting> {
    const { rows } = await this.#pool.query<IntentSettingRow>(
      `INSERT INTO intent_capture_settings
        (org_slug, app_slug, environment, mode, updated_at, updated_by_subject)
       VALUES ($1,$2,$3,$4,now(),$5)
       ON CONFLICT (org_slug, app_slug, environment) DO UPDATE SET
         mode = EXCLUDED.mode,
         updated_at = EXCLUDED.updated_at,
         updated_by_subject = EXCLUDED.updated_by_subject
       RETURNING *`,
      [ref.org, ref.app, ref.env, mode, updatedBySubject ?? null],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('intent capture setting write returned no row');
    return settingFromRow(row);
  }

  async delete(ref: IntentTenantRef): Promise<boolean> {
    const result = await this.#pool.query(
      `DELETE FROM intent_capture_settings
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3`,
      [ref.org, ref.app, ref.env],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export class InMemoryIntentEventStore implements IntentEventStore {
  readonly #events: IntentEvent[] = [];
  readonly #cap: number;
  readonly #now: () => Date;

  constructor(options: { cap?: number; now?: () => Date } = {}) {
    this.#cap = options.cap ?? DEFAULT_CAP;
    this.#now = options.now ?? (() => new Date());
  }

  emit(input: IntentEventInput): Promise<void> {
    this.#events.push(toIntentEvent(input, this.#now));
    if (this.#events.length > this.#cap) this.#events.splice(0, this.#events.length - this.#cap);
    return Promise.resolve();
  }

  list(filter: IntentEventFilter): Promise<readonly IntentEvent[]> {
    const result = this.#events
      .filter((event) => intentMatches(event, filter))
      .toReversed()
      .slice(0, boundedLimit(filter.limit));
    return Promise.resolve(result);
  }

  purge(filter: Pick<IntentEventFilter, 'org' | 'app' | 'env'>): Promise<number> {
    let removed = 0;
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index];
      if (event !== undefined && intentMatches(event, filter)) {
        this.#events.splice(index, 1);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

export class PostgresIntentEventStore implements IntentEventStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, options: { now?: () => Date } = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
  }

  async emit(input: IntentEventInput): Promise<void> {
    await this.#pool.query(
      `INSERT INTO intent_events
        (id, schema_version, created_at, org_slug, app_slug, environment, deployment_id,
         server_version, sdk_protocol_version, protocol_era, request_id, client_name,
         client_version, tool_name, outcome, error_kind, category, match, goal, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        randomUUID(),
        INTENT_CAPTURE_SCHEMA_VERSION,
        this.#now(),
        input.org,
        input.app,
        input.env,
        input.deploymentId ?? null,
        input.serverVersion ?? null,
        input.sdkProtocolVersion ?? null,
        input.protocolEra,
        input.requestId,
        input.clientName ?? null,
        input.clientVersion ?? null,
        input.toolName,
        input.outcome,
        input.errorKind ?? null,
        input.category,
        input.match,
        input.goal,
        input.source,
      ],
    );
  }

  async list(filter: IntentEventFilter): Promise<readonly IntentEvent[]> {
    const { clauses, values } = intentSqlFilter(filter);
    const limit = boundedLimit(filter.limit);
    const { rows } = await this.#pool.query<IntentEventRow>(
      `SELECT * FROM intent_events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ${limit}`,
      values,
    );
    return rows.map(intentFromRow);
  }

  async purge(filter: Pick<IntentEventFilter, 'org' | 'app' | 'env'>): Promise<number> {
    const { clauses, values } = intentSqlFilter(filter);
    const result = await this.#pool.query(
      `DELETE FROM intent_events WHERE ${clauses.join(' AND ')}`,
      values,
    );
    return result.rowCount ?? 0;
  }

  async prune(olderThan: Date): Promise<number> {
    const result = await this.#pool.query('DELETE FROM intent_events WHERE created_at < $1', [
      olderThan,
    ]);
    return result.rowCount ?? 0;
  }
}

export class IntentEventBuffer {
  readonly #sink: IntentEventSink;
  readonly #cap: number;
  readonly #queue: IntentEventInput[] = [];
  #draining: Promise<void> = Promise.resolve();
  #inFlight = false;
  #closed = false;
  #dropped = 0;
  #failed = 0;

  constructor(sink: IntentEventSink, options: { cap?: number } = {}) {
    this.#sink = sink;
    this.#cap = options.cap ?? 1024;
  }

  capture(event: IntentEventInput): void {
    if (this.#closed || this.#queue.length >= this.#cap) {
      this.#dropped += 1;
      return;
    }
    this.#queue.push(event);
    if (!this.#inFlight) {
      this.#inFlight = true;
      this.#draining = this.#drain();
    }
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (event === undefined) break;
      try {
        await this.#sink.emit(event);
      } catch {
        this.#failed += 1;
      }
    }
    this.#inFlight = false;
  }

  /** Events currently queued and not yet durably written. */
  get depth(): number {
    return this.#queue.length;
  }

  get droppedTotal(): number {
    return this.#dropped;
  }

  get failedTotal(): number {
    return this.#failed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#draining;
  }
}

export async function ensureIntentCaptureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intent_capture_settings (
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      mode text NOT NULL CHECK (mode = 'starter-v1'),
      updated_at timestamptz NOT NULL,
      updated_by_subject text,
      PRIMARY KEY (org_slug, app_slug, environment)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS intent_events (
      seq bigserial PRIMARY KEY,
      id uuid NOT NULL,
      schema_version int NOT NULL,
      created_at timestamptz NOT NULL,
      org_slug text NOT NULL,
      app_slug text NOT NULL,
      environment text NOT NULL,
      deployment_id text,
      server_version text,
      sdk_protocol_version text,
      protocol_era text NOT NULL,
      request_id text NOT NULL,
      client_name text,
      client_version text,
      tool_name text NOT NULL,
      outcome text NOT NULL,
      error_kind text,
      category text NOT NULL,
      match text NOT NULL,
      goal text NOT NULL,
      source text NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS intent_events_tenant_time_idx
    ON intent_events (org_slug, app_slug, environment, seq DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS intent_events_category_match_idx
    ON intent_events (org_slug, app_slug, environment, category, match)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS intent_events_created_at_idx
    ON intent_events (created_at)`);
}

function toIntentEvent(input: IntentEventInput, now: () => Date): IntentEvent {
  return {
    ...input,
    id: randomUUID(),
    schemaVersion: INTENT_CAPTURE_SCHEMA_VERSION,
    createdAt: now().toISOString(),
  };
}

function intentMatches(
  event: IntentEvent,
  filter: Pick<IntentEventFilter, keyof IntentEventFilter>,
): boolean {
  return (
    event.org === filter.org &&
    (filter.app === undefined || event.app === filter.app) &&
    (filter.env === undefined || event.env === filter.env) &&
    (filter.toolName === undefined || event.toolName === filter.toolName) &&
    (filter.category === undefined || event.category === filter.category) &&
    (filter.match === undefined || event.match === filter.match) &&
    (filter.since === undefined || event.createdAt >= filter.since) &&
    (filter.until === undefined || event.createdAt <= filter.until)
  );
}

function boundedLimit(limit: number | undefined): number {
  const parsed = Math.floor(Number(limit));
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_LIST_LIMIT)
    : DEFAULT_LIST_LIMIT;
}

function refKey(ref: IntentTenantRef): string {
  return `${ref.org}\0${ref.app}\0${ref.env}`;
}

interface IntentSettingRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly mode: string;
  readonly updated_at: Date;
  readonly updated_by_subject: string | null;
}

function settingFromRow(row: IntentSettingRow): IntentCaptureSetting {
  return {
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    mode: row.mode as 'starter-v1',
    updatedAt: row.updated_at.toISOString(),
    ...(row.updated_by_subject === null ? {} : { updatedBySubject: row.updated_by_subject }),
  };
}

interface IntentEventRow {
  readonly seq: string | number;
  readonly id: string;
  readonly schema_version: number;
  readonly created_at: Date;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly deployment_id: string | null;
  readonly server_version: string | null;
  readonly sdk_protocol_version: string | null;
  readonly protocol_era: string;
  readonly request_id: string;
  readonly client_name: string | null;
  readonly client_version: string | null;
  readonly tool_name: string;
  readonly outcome: string;
  readonly error_kind: string | null;
  readonly category: string;
  readonly match: string;
  readonly goal: string;
  readonly source: string;
}

function intentFromRow(row: IntentEventRow): IntentEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    schemaVersion: row.schema_version,
    createdAt: row.created_at.toISOString(),
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    ...(row.deployment_id === null ? {} : { deploymentId: row.deployment_id }),
    ...(row.server_version === null ? {} : { serverVersion: row.server_version }),
    ...(row.sdk_protocol_version === null ? {} : { sdkProtocolVersion: row.sdk_protocol_version }),
    protocolEra: row.protocol_era as IntentEventInput['protocolEra'],
    requestId: row.request_id,
    ...(row.client_name === null ? {} : { clientName: row.client_name }),
    ...(row.client_version === null ? {} : { clientVersion: row.client_version }),
    toolName: row.tool_name,
    outcome: row.outcome as RequestOutcome,
    ...(row.error_kind === null ? {} : { errorKind: row.error_kind }),
    category: row.category as IntentCategory,
    match: row.match as IntentMatch,
    goal: row.goal,
    source: row.source as 'tool_schema',
  };
}

function intentSqlFilter(filter: Pick<IntentEventFilter, keyof IntentEventFilter>): {
  clauses: string[];
  values: unknown[];
} {
  const clauses = ['org_slug = $1'];
  const values: unknown[] = [filter.org];
  const add = (column: string, value: unknown): void => {
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  };
  if (filter.app !== undefined) add('app_slug', filter.app);
  if (filter.env !== undefined) add('environment', filter.env);
  if (filter.toolName !== undefined) add('tool_name', filter.toolName);
  if (filter.category !== undefined) add('category', filter.category);
  if (filter.match !== undefined) add('match', filter.match);
  if (filter.since !== undefined) {
    values.push(filter.since);
    clauses.push(`created_at >= $${values.length}`);
  }
  if (filter.until !== undefined) {
    values.push(filter.until);
    clauses.push(`created_at <= $${values.length}`);
  }
  return { clauses, values };
}
