import {
  CapabilityPolicyConflict,
  type CapabilityPolicyRecord,
  type CapabilityPolicyStore,
  type CapabilityPolicyUpdate,
  type CapabilityScope,
  capabilityPolicyRecordSchema,
  capabilityScopeKey,
  checkedPolicyUpdate,
} from './policy-store.js';

/** Standard PostgreSQL query boundary. No driver/cloud SDK is reachable from portable exports. */
export interface CapabilitySqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface CapabilitySqlPool {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<CapabilitySqlClient>;
}

export class PostgresCapabilityPolicyStore implements CapabilityPolicyStore {
  readonly durable = true;
  constructor(private readonly pool: CapabilitySqlPool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS capability_policies (
      scope_key text PRIMARY KEY, revision bigint NOT NULL CHECK (revision > 0),
      policy jsonb NOT NULL, actor text NOT NULL, updated_at timestamptz NOT NULL,
      mutation_id text NOT NULL, fingerprint text NOT NULL
    )`);
  }
  async get(scope: CapabilityScope): Promise<CapabilityPolicyRecord | undefined> {
    const result = await this.pool.query('SELECT * FROM capability_policies WHERE scope_key = $1', [
      capabilityScopeKey(scope),
    ]);
    return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
  }
  async replace(
    scope: CapabilityScope,
    input: CapabilityPolicyUpdate,
  ): Promise<CapabilityPolicyRecord> {
    const key = capabilityScopeKey(scope);
    const update = checkedPolicyUpdate(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const current = (
        await client.query('SELECT * FROM capability_policies WHERE scope_key = $1 FOR UPDATE', [
          key,
        ])
      ).rows[0];
      if (current?.mutation_id === update.mutationId) {
        if (current.fingerprint !== update.fingerprint) throw new CapabilityPolicyConflict();
        await client.query('COMMIT');
        return decode(current);
      }
      if ((current === undefined ? 0 : Number(current.revision)) !== update.expectedRevision)
        throw new CapabilityPolicyConflict();
      const result = await client.query(
        `INSERT INTO capability_policies
        (scope_key, revision, policy, actor, updated_at, mutation_id, fingerprint)
        VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP, $5, $6)
        ON CONFLICT (scope_key) DO UPDATE SET revision = EXCLUDED.revision, policy = EXCLUDED.policy,
          actor = EXCLUDED.actor, updated_at = EXCLUDED.updated_at,
          mutation_id = EXCLUDED.mutation_id, fingerprint = EXCLUDED.fingerprint RETURNING *`,
        [
          key,
          update.expectedRevision + 1,
          JSON.stringify(update.policy),
          update.actor,
          update.mutationId,
          update.fingerprint,
        ],
      );
      const record = decode(result.rows[0]);
      await client.query('COMMIT');
      return record;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function decode(row: Record<string, unknown> | undefined): CapabilityPolicyRecord {
  if (row === undefined) throw new Error('capability_policy_unavailable');
  return capabilityPolicyRecordSchema.parse({
    revision: Number(row.revision),
    policy: row.policy,
    actor: row.actor,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  });
}
