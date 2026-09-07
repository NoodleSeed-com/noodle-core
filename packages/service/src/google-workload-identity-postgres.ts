import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GoogleWorkloadIdentityRecord } from './google-workload-identity.js';
import type {
  GoogleWorkloadIdentityStore,
  PrepareGoogleWorkloadIdentityInput,
  RevokeGoogleWorkloadIdentityInput,
  StoredGoogleWorkloadIdentity,
} from './google-workload-identity-store.js';
import { hasAsciiControlCharacters } from './google-workload-identity-validation.js';
import { type TenantRef, validateTenantRef } from './store.js';

interface WorkloadIdentityRow {
  readonly identity_id: string;
  readonly revision: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly subject: string;
  readonly active: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly created_by_subject: string;
  readonly created_by_email: string | null;
  readonly revoked_at: Date | null;
  readonly revoked_by_subject: string | null;
  readonly revoked_by_email: string | null;
}

/** Durable, multi-instance lifecycle for environment-scoped Google workload identities. */
export class PostgresGoogleWorkloadIdentityStore implements GoogleWorkloadIdentityStore {
  readonly #pool: Pool;
  readonly #now: () => Date;
  readonly #randomId: () => string;

  constructor(
    pool: Pool,
    options: {
      readonly now?: () => Date;
      readonly randomId?: () => string;
    } = {},
  ) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? (() => `gwi_${randomBytes(18).toString('base64url')}`);
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS google_workload_identities (
        org_slug             text NOT NULL,
        app_slug             text NOT NULL,
        environment          text NOT NULL,
        identity_id          text NOT NULL,
        revision             text NOT NULL,
        subject              text NOT NULL,
        active               boolean NOT NULL,
        created_at           timestamptz NOT NULL,
        updated_at           timestamptz NOT NULL,
        created_by_subject   text NOT NULL,
        created_by_email     text,
        revoked_at           timestamptz,
        revoked_by_subject   text,
        revoked_by_email     text,
        PRIMARY KEY (org_slug, app_slug, environment),
        UNIQUE (identity_id),
        UNIQUE (subject)
      )
    `);
  }

  async prepare(input: PrepareGoogleWorkloadIdentityInput): Promise<StoredGoogleWorkloadIdentity> {
    const tenant = validateTenantRef(input);
    const actorSubject = validateActor(input.actorSubject);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await lockTenant(client, tenant);
      const existing = await getRow(client, tenant, true);
      if (existing?.active) {
        await client.query('COMMIT');
        return rowToRecord(existing);
      }
      const id = validateOpaqueId(this.#randomId());
      const now = this.#now();
      const { rows } = await client.query<WorkloadIdentityRow>(
        `INSERT INTO google_workload_identities
          (org_slug, app_slug, environment, identity_id, revision, subject, active,
           created_at, updated_at, created_by_subject, created_by_email,
           revoked_at, revoked_by_subject, revoked_by_email)
         VALUES ($1, $2, $3, $4, $4, $5, true, $6, $6, $7, $8, NULL, NULL, NULL)
         ON CONFLICT (org_slug, app_slug, environment) DO UPDATE SET
           identity_id = EXCLUDED.identity_id,
           revision = EXCLUDED.revision,
           subject = EXCLUDED.subject,
           active = true,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           created_by_subject = EXCLUDED.created_by_subject,
           created_by_email = EXCLUDED.created_by_email,
           revoked_at = NULL,
           revoked_by_subject = NULL,
           revoked_by_email = NULL
         RETURNING *`,
        [
          tenant.org,
          tenant.app,
          tenant.env,
          id,
          `noodle:google-workload:${id}`,
          now,
          actorSubject,
          input.actorEmail ?? null,
        ],
      );
      await client.query('COMMIT');
      return rowToRecord(requireRow(rows[0]));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(tenantInput: TenantRef): Promise<StoredGoogleWorkloadIdentity | undefined> {
    const tenant = validateTenantRef(tenantInput);
    const { rows } = await this.#pool.query<WorkloadIdentityRow>(
      `SELECT * FROM google_workload_identities
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3`,
      [tenant.org, tenant.app, tenant.env],
    );
    return rows[0] === undefined ? undefined : rowToRecord(rows[0]);
  }

  async revoke(
    input: RevokeGoogleWorkloadIdentityInput,
  ): Promise<StoredGoogleWorkloadIdentity | undefined> {
    const tenant = validateTenantRef(input);
    const actorSubject = validateActor(input.actorSubject);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await lockTenant(client, tenant);
      const existing = await getRow(client, tenant, true);
      if (existing === undefined || !existing.active) {
        await client.query('COMMIT');
        return existing === undefined ? undefined : rowToRecord(existing);
      }
      const now = this.#now();
      const { rows } = await client.query<WorkloadIdentityRow>(
        `UPDATE google_workload_identities SET
           revision = identity_id || ':revoked',
           active = false,
           updated_at = $4,
           revoked_at = $4,
           revoked_by_subject = $5,
           revoked_by_email = $6
         WHERE org_slug = $1 AND app_slug = $2 AND environment = $3
         RETURNING *`,
        [tenant.org, tenant.app, tenant.env, now, actorSubject, input.actorEmail ?? null],
      );
      await client.query('COMMIT');
      return rowToRecord(requireRow(rows[0]));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolve(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
  }): Promise<GoogleWorkloadIdentityRecord | undefined> {
    const parts = input.tenantId.split('/');
    if (parts.length !== 3) return undefined;
    try {
      return await this.get({
        org: parts[0] as string,
        app: parts[1] as string,
        env: parts[2] as string,
      });
    } catch {
      return undefined;
    }
  }
}

async function lockTenant(client: PoolClient, tenant: TenantRef): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `${tenant.org}/${tenant.app}/${tenant.env}/google-workload-identity`,
  ]);
}

async function getRow(
  client: PoolClient,
  tenant: TenantRef,
  forUpdate: boolean,
): Promise<WorkloadIdentityRow | undefined> {
  const { rows } = await client.query<WorkloadIdentityRow>(
    `SELECT * FROM google_workload_identities
     WHERE org_slug = $1 AND app_slug = $2 AND environment = $3${forUpdate ? ' FOR UPDATE' : ''}`,
    [tenant.org, tenant.app, tenant.env],
  );
  return rows[0];
}

function rowToRecord(row: WorkloadIdentityRow): StoredGoogleWorkloadIdentity {
  return {
    id: row.identity_id,
    revision: row.revision,
    tenantId: `${row.org_slug}/${row.app_slug}/${row.environment}`,
    environmentId: row.environment,
    subject: row.subject,
    active: row.active,
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBySubject: row.created_by_subject,
    ...(row.created_by_email === null ? {} : { createdByEmail: row.created_by_email }),
    ...(row.revoked_at === null
      ? {}
      : {
          revokedAt: new Date(row.revoked_at).toISOString(),
          ...(row.revoked_by_subject === null ? {} : { revokedBySubject: row.revoked_by_subject }),
          ...(row.revoked_by_email === null ? {} : { revokedByEmail: row.revoked_by_email }),
        }),
  };
}

function requireRow(row: WorkloadIdentityRow | undefined): WorkloadIdentityRow {
  if (row === undefined) throw new Error('Google workload identity write returned no row');
  return row;
}

function validateActor(value: string): string {
  if (value.length < 1 || value.length > 512 || hasAsciiControlCharacters(value)) {
    throw new Error('invalid workload identity actor');
  }
  return value;
}

function validateOpaqueId(value: string): string {
  if (!/^[A-Za-z0-9_-]{4,96}$/.test(value)) {
    throw new Error('invalid workload identity id');
  }
  return value;
}
