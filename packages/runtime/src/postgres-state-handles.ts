import type { ArtifactState, ArtifactStateHandle } from '@noodle-borg/compiler';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  CallerStateAdoptionInput,
  CallerStateAdoptionResult,
} from './state-handle-ownership.js';
import {
  assertExpectedStateRevision,
  assertNoSecretValue,
  assertSchemaValue,
  assertStateHandleNotCompleted,
  createMutableStateHandleRecord,
  type MutableStateHandleRecord,
  type StateHandleRecord,
  type StateHandleStore,
  type StateInput,
  type StateMutationInput,
  type StatePatchInput,
  stateHandleRecordForMutation,
  toPublicStateHandleRecord,
} from './state-handles.js';

/** Covers a request admitted just before the anonymous session's absolute expiry. */
const STATE_OWNER_REDIRECT_GRACE_MS = 5 * 60 * 1000;

export interface PostgresStateHandleStoreOptions {
  readonly deploymentId: string;
  readonly state: ArtifactState;
  readonly now?: () => Date;
}

interface StateRecordRow extends QueryResultRow {
  readonly handle_name: string;
  readonly state_key: string;
  readonly handle_version: string;
  readonly value: unknown;
  readonly revision: string | number;
  readonly status: 'active' | 'completed';
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly expires_at: Date | string | null;
}

export class PostgresStateHandleStore implements StateHandleStore {
  readonly #pool: Pool;
  readonly #deploymentId: string;
  readonly #state: ArtifactState;
  readonly #now: () => Date;

  constructor(pool: Pool, options: PostgresStateHandleStoreOptions) {
    this.#pool = pool;
    this.#deploymentId = options.deploymentId;
    this.#state = options.state;
    this.#now = options.now ?? (() => new Date());
  }

  async read(input: StateInput): Promise<StateHandleRecord> {
    const def = this.#definition(input.handle);
    const owner = ownerKey(def, input);
    const key = input.key ?? 'default';
    const read = async (client: Pool | PoolClient): Promise<StateHandleRecord> => {
      const nowDate = this.#now();
      const resolvedOwner =
        def.claimOnAuthentication === true
          ? await resolveOperationOwner(
              client as PoolClient,
              this.#deploymentId,
              input.handle,
              owner,
              nowDate,
            )
          : owner;
      const row = await selectRow(client, this.#deploymentId, input.handle, resolvedOwner, key);
      const now = nowDate.getTime();
      if (row === undefined) {
        return toPublicStateHandleRecord(
          createMutableStateHandleRecord(input.handle, key, def.ttlSeconds, now),
          now,
        );
      }
      assertVersion(row, def);
      return toPublicStateHandleRecord(mutableFromRow(row), now);
    };
    return def.claimOnAuthentication === true
      ? this.#withTransaction((client) => read(client))
      : read(this.#pool);
  }

  async patch(input: StatePatchInput): Promise<StateHandleRecord> {
    return this.#withTransaction(async (client) => {
      const def = this.#definition(input.handle);
      const owner = ownerKey(def, input);
      const key = input.key ?? 'default';
      const nowDate = this.#now();
      const resolvedOwner =
        def.claimOnAuthentication === true
          ? await resolveOperationOwner(client, this.#deploymentId, input.handle, owner, nowDate)
          : owner;
      const row = await selectRow(
        client,
        this.#deploymentId,
        input.handle,
        resolvedOwner,
        key,
        true,
      );
      if (row !== undefined) assertVersion(row, def);
      const now = nowDate.getTime();
      const current = stateHandleRecordForMutation(
        row ? mutableFromRow(row) : undefined,
        input.handle,
        key,
        def.ttlSeconds,
        now,
      );
      assertStateHandleNotCompleted(current);
      assertExpectedStateRevision(current, input.expectedRevision);
      assertNoSecretValue(input.value);
      const value = { ...current.value, ...input.value };
      assertSchemaValue(def.schema, value);
      const next = {
        ...current,
        value,
        revision: current.revision + 1,
        updatedAt: now,
      };
      await upsertRow(client, this.#deploymentId, resolvedOwner, def.version, next);
      return toPublicStateHandleRecord(next, now);
    });
  }

  async complete(input: StateMutationInput): Promise<StateHandleRecord> {
    return this.#withTransaction(async (client) => {
      const def = this.#definition(input.handle);
      const owner = ownerKey(def, input);
      const key = input.key ?? 'default';
      const nowDate = this.#now();
      const resolvedOwner =
        def.claimOnAuthentication === true
          ? await resolveOperationOwner(client, this.#deploymentId, input.handle, owner, nowDate)
          : owner;
      const row = await selectRow(
        client,
        this.#deploymentId,
        input.handle,
        resolvedOwner,
        key,
        true,
      );
      if (row !== undefined) assertVersion(row, def);
      const now = nowDate.getTime();
      const current = stateHandleRecordForMutation(
        row ? mutableFromRow(row) : undefined,
        input.handle,
        key,
        def.ttlSeconds,
        now,
      );
      assertStateHandleNotCompleted(current);
      assertExpectedStateRevision(current, input.expectedRevision);
      const next = {
        ...current,
        status: 'completed' as const,
        revision: current.revision + 1,
        updatedAt: now,
      };
      await upsertRow(client, this.#deploymentId, resolvedOwner, def.version, next);
      return toPublicStateHandleRecord(next, now);
    });
  }

  async pruneExpired(): Promise<number> {
    const result = await this.#pool.query(
      `DELETE FROM state_handle_records
       WHERE deployment_id = $1 AND expires_at IS NOT NULL AND expires_at <= $2`,
      [this.#deploymentId, this.#now()],
    );
    await this.#pool.query(
      `DELETE FROM state_handle_owner_redirects
       WHERE deployment_id = $1 AND expires_at <= $2`,
      [this.#deploymentId, new Date(this.#now().getTime() - STATE_OWNER_REDIRECT_GRACE_MS)],
    );
    return result.rowCount ?? 0;
  }

  #definition(handle: string): ArtifactStateHandle {
    const def = this.#state.handles[handle];
    if (def === undefined) throw new Error(`unknown state handle "${handle}"`);
    return def;
  }

  async #withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function ensureStateHandleSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state_handle_records (
      deployment_id   text NOT NULL,
      handle_name     text NOT NULL,
      owner_key       text NOT NULL,
      state_key       text NOT NULL,
      handle_version  text NOT NULL,
      value           jsonb NOT NULL,
      revision        bigint NOT NULL,
      status          text NOT NULL CHECK (status IN ('active', 'completed')),
      created_at      timestamptz NOT NULL,
      updated_at      timestamptz NOT NULL,
      expires_at      timestamptz,
      PRIMARY KEY (deployment_id, handle_name, owner_key, state_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS state_handle_records_expiry_idx
    ON state_handle_records (expires_at)
    WHERE expires_at IS NOT NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state_handle_owner_redirects (
      deployment_id   text NOT NULL,
      handle_name     text NOT NULL,
      source_owner_key text NOT NULL,
      target_owner_key text NOT NULL,
      created_at      timestamptz NOT NULL,
      expires_at      timestamptz NOT NULL,
      PRIMARY KEY (deployment_id, handle_name, source_owner_key),
      CHECK (source_owner_key <> target_owner_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS state_handle_owner_redirects_expiry_idx
    ON state_handle_owner_redirects (expires_at)
  `);
}

/**
 * Rebind opted-in caller state inside the elevation transaction supplied by assistant-gateway.
 * Values are never decoded or rewritten: changing only `owner_key` preserves every lifecycle field.
 */
export async function adoptCallerState(
  client: PoolClient,
  input: CallerStateAdoptionInput,
): Promise<CallerStateAdoptionResult> {
  if (input.sourceCallerSubject === input.targetCallerSubject) {
    return { ok: true, adoptedHandles: [], adoptedRecords: 0 };
  }
  const handles = [...new Set(input.handles)].sort();
  for (const handle of handles) {
    // Anonymous -> authenticated is directional. Every opted state operation takes the source
    // lock before following its redirect and then takes the target lock, so the adoption uses the
    // same order while still serializing concurrent creates under either owner.
    await lockOwner(client, input.deploymentId, handle, input.sourceCallerSubject);
    await lockOwner(client, input.deploymentId, handle, input.targetCallerSubject);
  }
  if (handles.length === 0) {
    return { ok: true, adoptedHandles: [], adoptedRecords: 0 };
  }

  const redirect = await client.query<{ handle_name: string; target_owner_key: string }>(
    `SELECT handle_name, target_owner_key
     FROM state_handle_owner_redirects
     WHERE deployment_id = $1
       AND handle_name = ANY($2::text[])
       AND source_owner_key = $3
       AND expires_at > $4`,
    [
      input.deploymentId,
      handles,
      input.sourceCallerSubject,
      new Date(input.now.getTime() - STATE_OWNER_REDIRECT_GRACE_MS),
    ],
  );
  if (redirect.rows.some((row) => row.target_owner_key !== input.targetCallerSubject)) {
    return { ok: false, reason: 'state_key_conflict' };
  }

  const collision = await client.query(
    `SELECT 1
     FROM state_handle_records AS source
     JOIN state_handle_records AS target
       ON target.deployment_id = source.deployment_id
      AND target.handle_name = source.handle_name
      AND target.state_key = source.state_key
     WHERE source.deployment_id = $1
       AND source.handle_name = ANY($2::text[])
       AND source.owner_key = $3
       AND target.owner_key = $4
     LIMIT 1`,
    [input.deploymentId, handles, input.sourceCallerSubject, input.targetCallerSubject],
  );
  if ((collision.rowCount ?? 0) > 0) {
    return { ok: false, reason: 'state_key_conflict' };
  }

  const moved = await client.query(
    `UPDATE state_handle_records
     SET owner_key = $4
     WHERE deployment_id = $1
       AND handle_name = ANY($2::text[])
       AND owner_key = $3`,
    [input.deploymentId, handles, input.sourceCallerSubject, input.targetCallerSubject],
  );
  await client.query(
    `INSERT INTO state_handle_owner_redirects
       (deployment_id, handle_name, source_owner_key, target_owner_key, created_at, expires_at)
     SELECT $1, handle_name, $3, $4, $5, $6
     FROM unnest($2::text[]) AS handle_name
     ON CONFLICT (deployment_id, handle_name, source_owner_key) DO UPDATE SET
       target_owner_key = EXCLUDED.target_owner_key,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at`,
    [
      input.deploymentId,
      handles,
      input.sourceCallerSubject,
      input.targetCallerSubject,
      input.now,
      input.redirectExpiresAt,
    ],
  );
  return {
    ok: true,
    adoptedHandles: handles,
    adoptedRecords: moved.rowCount ?? 0,
  };
}

async function selectRow(
  client: Pool | PoolClient,
  deploymentId: string,
  handle: string,
  owner: string,
  key: string,
  forUpdate = false,
): Promise<StateRecordRow | undefined> {
  const result = await client.query<StateRecordRow>(
    `SELECT handle_name, state_key, handle_version, value, revision, status,
            created_at, updated_at, expires_at
     FROM state_handle_records
     WHERE deployment_id = $1 AND handle_name = $2 AND owner_key = $3 AND state_key = $4
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [deploymentId, handle, owner, key],
  );
  return result.rows[0];
}

async function upsertRow(
  client: PoolClient,
  deploymentId: string,
  owner: string,
  version: string,
  record: MutableStateHandleRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO state_handle_records
       (deployment_id, handle_name, owner_key, state_key, handle_version, value, revision,
        status, created_at, updated_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
     ON CONFLICT (deployment_id, handle_name, owner_key, state_key) DO UPDATE SET
       handle_version = EXCLUDED.handle_version,
       value          = EXCLUDED.value,
       revision       = EXCLUDED.revision,
       status         = EXCLUDED.status,
       created_at     = EXCLUDED.created_at,
       updated_at     = EXCLUDED.updated_at,
       expires_at     = EXCLUDED.expires_at`,
    [
      deploymentId,
      record.handle,
      owner,
      record.key,
      version,
      JSON.stringify(record.value),
      record.revision,
      record.status,
      new Date(record.createdAt),
      new Date(record.updatedAt),
      record.expiresAt === undefined ? null : new Date(record.expiresAt),
    ],
  );
}

function ownerKey(def: ArtifactStateHandle, input: StateInput): string {
  return def.scope === 'caller' ? (input.callerSubject ?? 'anonymous') : 'deployment';
}

async function lockOwner(
  client: PoolClient,
  deploymentId: string,
  handle: string,
  owner: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    stateOwnerLockKey(deploymentId, handle, owner),
  ]);
}

/** PostgreSQL text rejects NUL, so length-prefix each untrusted segment instead of using a sentinel. */
function stateOwnerLockKey(deploymentId: string, handle: string, owner: string): string {
  return `state-owner:${deploymentId.length}:${deploymentId}:${handle.length}:${handle}:${owner.length}:${owner}`;
}

async function resolveOperationOwner(
  client: PoolClient,
  deploymentId: string,
  handle: string,
  owner: string,
  now: Date,
): Promise<string> {
  await lockOwner(client, deploymentId, handle, owner);
  const redirect = await client.query<{ target_owner_key: string }>(
    `SELECT target_owner_key
     FROM state_handle_owner_redirects
     WHERE deployment_id = $1 AND handle_name = $2 AND source_owner_key = $3 AND expires_at > $4`,
    [deploymentId, handle, owner, new Date(now.getTime() - STATE_OWNER_REDIRECT_GRACE_MS)],
  );
  const target = redirect.rows[0]?.target_owner_key;
  if (target === undefined) return owner;
  await lockOwner(client, deploymentId, handle, target);
  return target;
}

function assertVersion(row: StateRecordRow, def: ArtifactStateHandle): void {
  if (row.handle_version !== def.version) {
    throw new Error(
      `state handle version mismatch for "${row.handle_name}": stored ${row.handle_version}, current ${def.version}`,
    );
  }
}

function mutableFromRow(row: StateRecordRow): MutableStateHandleRecord {
  const value =
    typeof row.value === 'object' && row.value !== null && !Array.isArray(row.value)
      ? (row.value as Record<string, unknown>)
      : {};
  const expiresAt = row.expires_at === null ? undefined : new Date(row.expires_at).getTime();
  return {
    handle: row.handle_name,
    key: row.state_key,
    value,
    revision: Number(row.revision),
    status: row.status,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
