import { createHash } from 'node:crypto';
import { canonicalJson } from '@noodle-borg/compiler';
import type { SealedSecret, SecretBox } from '@noodle-borg/runtime';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { InstallationScope } from './business-information/contracts.js';
import type {
  OperationCoordinationRecord,
  OperationCoordinationStore,
} from './operation-coordination.js';
import { postgresQueryExecutor, withPostgresTransaction } from './store/postgres-transaction.js';

const scopeSchema = z
  .object({
    org: z.string().min(1).max(256),
    app: z.string().min(1).max(256),
    env: z.string().min(1).max(256),
    installationId: z.string().min(1).max(256),
  })
  .strict();
const recordSchema = z
  .object({
    scope: scopeSchema,
    resource: z.string().regex(/^[a-f0-9]{64}$/u),
    token: z.string().uuid(),
    epoch: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    generation: z.string().min(1).max(256),
    reference: z
      .string()
      .regex(/^[A-Za-z0-9._:@/-]{1,256}$/u)
      .refine((value) => !value.includes('://')),
    operationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['executing', 'unknown']),
  })
  .strict()
  .refine(
    (record) => record.deadline > record.startedAt && record.deadline - record.startedAt <= 120000,
  );
const reviewText = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
const reviewSchema = z.object({ reviewer: reviewText, reason: reviewText }).strict();

interface CoordinationRow {
  readonly resource: string;
  readonly scope_key: string;
  readonly token: string;
  readonly protected: SealedSecret;
  readonly state: 'executing' | 'unknown';
}
const columns = 'resource,scope_key,token,protected,state';

/** Existing PostgreSQL operational authority. No expiry, local fallback, provider payloads or new service. */
export class PostgresOperationCoordinationStore implements OperationCoordinationStore {
  constructor(
    readonly pool: Pool,
    readonly secretBox: SecretBox,
    readonly now: () => number = Date.now,
  ) {}

  async ensureSchema(): Promise<void> {
    await withPostgresTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('operation-coordination-schema:' || current_schema(),0))",
      );
      await client.query(`CREATE TABLE IF NOT EXISTS external_operation_coordination (
      resource text PRIMARY KEY, scope_key text NOT NULL, token text NOT NULL,
      protected jsonb NOT NULL, state text NOT NULL CHECK(state IN ('executing','unknown'))
    )`);
      await client.query(`CREATE INDEX IF NOT EXISTS external_operation_coordination_scope
      ON external_operation_coordination(scope_key,resource)`);
      await client.query(`CREATE TABLE IF NOT EXISTS external_operation_coordination_resolutions (
      resource text NOT NULL, token text NOT NULL, scope_key text NOT NULL,
      protected jsonb NOT NULL, resolved_at bigint NOT NULL,
      PRIMARY KEY(resource,token)
    )`);
      await client.query(`CREATE OR REPLACE FUNCTION reject_external_operation_resolution_change() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'operation coordination resolutions are append-only'; END
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS external_operation_resolution_append_only ON external_operation_coordination_resolutions;
      CREATE TRIGGER external_operation_resolution_append_only BEFORE UPDATE OR DELETE ON external_operation_coordination_resolutions
      FOR EACH ROW EXECUTE FUNCTION reject_external_operation_resolution_change()`);
    });
  }

  /** Deployment-operator cutover only: source writers must be fenced before taking the reviewed snapshot. */
  async importUnknown(
    target: {
      readonly scope: InstallationScope;
      readonly epoch: string;
      readonly generation: string;
    },
    records: readonly OperationCoordinationRecord[],
  ): Promise<{ readonly imported: number; readonly unchanged: number }> {
    if (records.length > 100)
      throw new Error('Operation coordination import exceeds the bounded batch size');
    const key = scopeKey(target.scope);
    const parsed = records
      .map((value) => {
        const record = validateRecord(value);
        if (
          record.state !== 'unknown' ||
          scopeKey(record.scope) !== key ||
          record.epoch !== target.epoch ||
          record.generation !== target.generation
        )
          throw new Error('Operation coordination import target mismatch');
        return record;
      })
      .sort((left, right) => left.resource.localeCompare(right.resource));
    return withPostgresTransaction(this.pool, async () => {
      let imported = 0;
      let unchanged = 0;
      for (const record of parsed) {
        const result = await this.claim(record);
        if (result.acquired) imported += 1;
        else if (
          result.previous !== undefined &&
          canonicalJson(result.previous) === canonicalJson(record)
        )
          unchanged += 1;
        else throw new Error('Operation coordination import conflicts with existing custody');
      }
      return { imported, unchanged };
    });
  }

  async claim(
    record: OperationCoordinationRecord,
  ): Promise<{ readonly acquired: boolean; readonly previous?: OperationCoordinationRecord }> {
    const parsed = validateRecord(record);
    const sealed = await this.secretBox.seal(JSON.stringify(parsed));
    return withPostgresTransaction(this.pool, async (client) => {
      await lockResource(client, parsed.resource);
      const existing = await this.read(client, parsed.resource);
      if (existing !== undefined) {
        const previous = await this.open(existing, parsed.scope);
        return { acquired: false, previous };
      }
      await client.query(
        `INSERT INTO external_operation_coordination (${columns}) VALUES($1,$2,$3,$4::jsonb,$5)`,
        [
          parsed.resource,
          scopeKey(parsed.scope),
          parsed.token,
          JSON.stringify(sealed),
          parsed.state,
        ],
      );
      return { acquired: true };
    });
  }

  async markUnknown(resource: string, token: string): Promise<void> {
    await withPostgresTransaction(this.pool, async (client) => {
      await lockResource(client, resource);
      const row = await this.read(client, resource);
      if (row === undefined || row.token !== token) return;
      await this.open(row);
      await client.query(
        "UPDATE external_operation_coordination SET state='unknown' WHERE resource=$1 AND token=$2",
        [resource, token],
      );
    });
  }

  async release(resource: string, token: string, resolution: string): Promise<boolean> {
    if (!['completed', 'rejected', 'source_verified'].includes(resolution))
      throw new Error('Invalid operation coordination resolution');
    return withPostgresTransaction(this.pool, async (client) => {
      await lockResource(client, resource);
      const row = await this.read(client, resource);
      if (row === undefined || row.token !== token) return false;
      const record = await this.open(row);
      if (resolution === 'source_verified') await this.receipt(client, record, { resolution });
      return this.delete(client, resource, token);
    });
  }

  async list(
    scope: InstallationScope,
    limit = 100,
    beforeResource?: string,
  ): Promise<readonly OperationCoordinationRecord[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (beforeResource !== undefined && !/^[a-f0-9]{64}$/u.test(beforeResource))
    )
      throw new Error('Invalid operation coordination list bounds');
    const { rows } = await postgresQueryExecutor(this.pool).query<CoordinationRow>(
      `SELECT ${columns} FROM external_operation_coordination
       WHERE scope_key=$1 AND resource>$2 ORDER BY resource LIMIT $3`,
      [scopeKey(scope), beforeResource ?? '', limit],
    );
    return Promise.all(rows.map((row) => this.open(row, scope)));
  }

  async resolve(
    scope: InstallationScope,
    resource: string,
    token: string,
    review: { readonly reviewer: string; readonly reason: string },
  ): Promise<boolean> {
    const parsed = reviewSchema.safeParse(review);
    if (!parsed.success) throw new Error('Invalid operation coordination review');
    const key = scopeKey(scope);
    return withPostgresTransaction(this.pool, async (client) => {
      await lockResource(client, resource);
      const row = await this.read(client, resource);
      if (row === undefined || row.token !== token || row.scope_key !== key) return false;
      const record = await this.open(row, scope);
      if (record.state === 'executing' && record.deadline > this.now()) return false;
      await this.receipt(client, record, { resolution: 'reviewed', ...parsed.data });
      return this.delete(client, resource, token);
    });
  }

  private async read(client: PoolClient, resource: string): Promise<CoordinationRow | undefined> {
    const { rows } = await client.query<CoordinationRow>(
      `SELECT ${columns} FROM external_operation_coordination WHERE resource=$1 FOR UPDATE`,
      [resource],
    );
    return rows[0];
  }

  private async open(
    row: CoordinationRow,
    scope?: InstallationScope,
  ): Promise<OperationCoordinationRecord> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(await this.secretBox.open(row.protected));
    } catch {
      throw new Error('Invalid protected operation coordination record');
    }
    const record = validateRecord(decoded);
    if (
      record.resource !== row.resource ||
      record.token !== row.token ||
      scopeKey(record.scope) !== row.scope_key ||
      (scope !== undefined && canonicalJson(record.scope) !== canonicalJson(scope)) ||
      (row.state !== 'executing' && row.state !== 'unknown')
    )
      throw new Error('Operation coordination protected binding mismatch');
    // Unknown is an authoritative column transition; the immutable protected claim retains its origin.
    return { ...record, state: row.state };
  }

  private async receipt(
    client: PoolClient,
    record: OperationCoordinationRecord,
    resolution: {
      readonly resolution: string;
      readonly reviewer?: string;
      readonly reason?: string;
    },
  ): Promise<void> {
    const resolvedAt = this.now();
    const sealed = await this.secretBox.seal(JSON.stringify({ record, ...resolution, resolvedAt }));
    // Intentionally append-only: a duplicate token never overwrites a prior source/review decision.
    await client.query(
      `INSERT INTO external_operation_coordination_resolutions
      (resource,token,scope_key,protected,resolved_at) VALUES($1,$2,$3,$4::jsonb,$5)`,
      [record.resource, record.token, scopeKey(record.scope), JSON.stringify(sealed), resolvedAt],
    );
  }

  private async delete(client: PoolClient, resource: string, token: string): Promise<boolean> {
    const { rowCount } = await client.query(
      'DELETE FROM external_operation_coordination WHERE resource=$1 AND token=$2',
      [resource, token],
    );
    return rowCount === 1;
  }
}

function validateRecord(value: unknown): OperationCoordinationRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid operation coordination record');
  return parsed.data;
}
function scopeKey(scope: InstallationScope): string {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) throw new Error('Invalid operation coordination scope');
  return createHash('sha256').update(canonicalJson(parsed.data)).digest('hex');
}
async function lockResource(client: PoolClient, resource: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(resource)) throw new Error('Invalid operation coordination resource');
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('external-operation-coordination:' || $1, 0))",
    [resource],
  );
}
