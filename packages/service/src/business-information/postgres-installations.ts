import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { postgresQueryExecutor } from '../store/postgres-transaction.js';
import type {
  BusinessGrant,
  BusinessGrantStore,
  GrantMutationResult,
  InstallationCreateResult,
  InstallationMutationResult,
  InstallationScope,
  SolutionInstallation,
  SolutionInstallationStore,
} from './contracts.js';
import type { ManagedDefinitionResolver } from './managed-releases.js';
import {
  effectiveInstallation,
  installationFingerprint,
  managedInstallationIntentMatches,
  normalizeInstallationInput,
  permissionsForBusinessRole,
  validateExpectedRevision,
} from './model.js';
import {
  bindPostgresInstallationApplication,
  lockInstallationApplication,
  pausePostgresInstallations,
} from './postgres-application-lifecycle.js';
import {
  type GrantRow,
  grantFromRow,
  type InstallationRow,
  installationFromRow,
} from './postgres-rows.js';
import { inTransaction } from './postgres-transaction.js';
import { validateEmail, validateScalar, validateScope } from './validation.js';

export interface PostgresInstallationStoreOptions {
  readonly now?: () => Date;
  readonly publicId?: () => string;
  /** Service-wide stable managed release resolver; injection exists for deterministic release tests. */
  readonly managedDefinition?: ManagedDefinitionResolver;
}

export class PostgresInstallationStore implements SolutionInstallationStore {
  readonly #pool: Pool;
  readonly #now: () => Date;
  readonly #publicId: () => string;
  readonly #managedDefinition: ManagedDefinitionResolver | undefined;

  constructor(pool: Pool, options: PostgresInstallationStoreOptions = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
    this.#publicId = options.publicId ?? (() => `sol_${randomUUID().replaceAll('-', '')}`);
    this.#managedDefinition = options.managedDefinition;
  }

  bindApplication(scope: InstallationScope, generation: string) {
    return bindPostgresInstallationApplication(this.#pool, validateScope(scope), generation);
  }
  pauseApplication(org: string, app: string, at: string, retired = false) {
    return pausePostgresInstallations(this.#pool, org, app, at, retired);
  }

  async createInstallation(
    input: Parameters<SolutionInstallationStore['createInstallation']>[0],
  ): Promise<InstallationCreateResult> {
    const normalized = normalizeInstallationInput(input, this.#managedDefinition);
    const fingerprint = installationFingerprint(normalized);
    return inTransaction(this.#pool, async (client) => {
      const now = this.#now();
      const publicId = validateScalar('public installation id', this.#publicId(), 128);
      const inserted = await client.query<InstallationRow>(
        `INSERT INTO business_solution_installations
          (org_slug, app_slug, environment, installation_id, public_id, profile_key,
           profile_version, managed_collections, retention_days, revision, create_fingerprint,
           created_at, created_by_subject, updated_at, updated_by_subject, definition_snapshot, application_generation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$11,$12,$13::jsonb,'pending')
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          normalized.scope.org,
          normalized.scope.app,
          normalized.scope.env,
          normalized.scope.installationId,
          publicId,
          normalized.profileKey,
          normalized.profileVersion,
          [...normalized.managedCollections],
          normalized.retentionDays,
          fingerprint,
          now,
          normalized.actorSubject,
          JSON.stringify(normalized.definition),
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        const existing = await client.query<InstallationRow>(
          `SELECT * FROM business_solution_installations
           WHERE org_slug=$1 AND installation_id=$2 FOR UPDATE`,
          [normalized.scope.org, normalized.scope.installationId],
        );
        const existingRow = existing.rows[0];
        if (existingRow === undefined) throw new Error('installation conflict row is unavailable');
        const existingInstallation = installationFromRow(existingRow);
        return {
          disposition:
            existingRow.app_slug === normalized.scope.app &&
            existingRow.environment === normalized.scope.env &&
            (existingRow.create_fingerprint === fingerprint ||
              managedInstallationIntentMatches(existingInstallation, normalized))
              ? 'replayed'
              : 'conflict',
          installation: effectiveInstallation(existingInstallation, this.#managedDefinition),
        };
      }
      await client.query(
        `INSERT INTO business_installation_grants
          (org_slug, app_slug, environment, installation_id, subject, email, role, revision,
           created_at, created_by_subject, updated_at, updated_by_subject)
         VALUES ($1,$2,$3,$4,$5,$6,'administrator',1,$7,$5,$7,$5)`,
        [
          normalized.scope.org,
          normalized.scope.app,
          normalized.scope.env,
          normalized.scope.installationId,
          normalized.actorSubject,
          normalized.actorEmail ?? null,
          now,
        ],
      );
      return {
        disposition: 'created',
        installation: effectiveInstallation(installationFromRow(row), this.#managedDefinition),
      };
    });
  }

  async getInstallation(scope: InstallationScope): Promise<SolutionInstallation | undefined> {
    const normalized = validateScope(scope);
    const result = await postgresQueryExecutor(this.#pool).query<InstallationRow>(
      `SELECT * FROM business_solution_installations
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4`,
      [normalized.org, normalized.app, normalized.env, normalized.installationId],
    );
    return result.rows[0] === undefined
      ? undefined
      : effectiveInstallation(installationFromRow(result.rows[0]), this.#managedDefinition);
  }

  async getInstallationById(
    org: string,
    installationId: string,
  ): Promise<SolutionInstallation | undefined> {
    const result = await postgresQueryExecutor(this.#pool).query<InstallationRow>(
      `SELECT * FROM business_solution_installations WHERE org_slug=$1 AND installation_id=$2`,
      [validateScalar('organization', org, 63), validateScalar('installation', installationId, 63)],
    );
    return result.rows[0] === undefined
      ? undefined
      : effectiveInstallation(installationFromRow(result.rows[0]), this.#managedDefinition);
  }

  async resolveInstallationByPublicId(publicId: string): Promise<SolutionInstallation | undefined> {
    const result = await postgresQueryExecutor(this.#pool).query<InstallationRow>(
      `SELECT * FROM business_solution_installations WHERE public_id=$1`,
      [validateScalar('public installation id', publicId, 128)],
    );
    return result.rows[0] === undefined
      ? undefined
      : effectiveInstallation(installationFromRow(result.rows[0]), this.#managedDefinition);
  }

  async listInstallations(org: string): Promise<readonly SolutionInstallation[]> {
    const result = await postgresQueryExecutor(this.#pool).query<InstallationRow>(
      `SELECT * FROM business_solution_installations
       WHERE org_slug=$1 ORDER BY created_at, installation_id`,
      [validateScalar('organization', org, 63)],
    );
    return result.rows.map((row) =>
      effectiveInstallation(installationFromRow(row), this.#managedDefinition),
    );
  }

  async listInstallationsForSubject(subject: string) {
    const grants = await postgresQueryExecutor(this.#pool).query<GrantRow>(
      `SELECT * FROM business_installation_grants
       WHERE subject=$1 AND revoked_at IS NULL
       ORDER BY created_at, org_slug, installation_id`,
      [validateScalar('identity subject', subject, 256)],
    );
    const joined = await Promise.all(
      grants.rows.map(async (row) => {
        const grant = grantFromRow(row);
        const installation = await this.getInstallation(grant.scope);
        if (installation === undefined) throw new Error('business grant installation is missing');
        return { installation, grant };
      }),
    );
    return joined;
  }

  async setIntakeState(
    input: Parameters<SolutionInstallationStore['setIntakeState']>[0],
  ): Promise<InstallationMutationResult> {
    const scope = validateScope(input.scope);
    validateExpectedRevision(input.expectedRevision);
    const actor = validateScalar('actor subject', input.actorSubject, 256);
    return inTransaction(this.#pool, async (client) => {
      const application = input.active
        ? await lockInstallationApplication(client, scope)
        : undefined;
      const currentResult = await client.query<InstallationRow>(
        `SELECT * FROM business_solution_installations
         WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         FOR UPDATE`,
        [scope.org, scope.app, scope.env, scope.installationId],
      );
      const current = currentResult.rows[0];
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      const currentRevision = Number(current.revision);
      if (currentRevision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision };
      }
      if (
        input.active &&
        application?.enforced &&
        (!application.active || application.generation !== current.application_generation)
      )
        return { ok: false, reason: 'application_unavailable', currentRevision };
      if (current.intake_active === input.active) {
        return { ok: false, reason: 'invalid_state', currentRevision };
      }
      const updated = await client.query<InstallationRow>(
        `UPDATE business_solution_installations
         SET intake_active=$5, revision=revision+1, updated_at=$6, updated_by_subject=$7
         WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         RETURNING *`,
        [scope.org, scope.app, scope.env, scope.installationId, input.active, this.#now(), actor],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error('installation intake update returned no row');
      return {
        ok: true,
        installation: effectiveInstallation(installationFromRow(row), this.#managedDefinition),
      };
    });
  }

  async getGrant(scope: InstallationScope, subject: string): Promise<BusinessGrant | undefined> {
    const normalized = validateScope(scope);
    const result = await postgresQueryExecutor(this.#pool).query<GrantRow>(
      `SELECT * FROM business_installation_grants
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4 AND subject=$5`,
      [
        normalized.org,
        normalized.app,
        normalized.env,
        normalized.installationId,
        validateScalar('grant subject', subject, 256),
      ],
    );
    return result.rows[0] === undefined ? undefined : grantFromRow(result.rows[0]);
  }

  async listGrants(scope: InstallationScope): Promise<readonly BusinessGrant[]> {
    const normalized = validateScope(scope);
    const result = await postgresQueryExecutor(this.#pool).query<GrantRow>(
      `SELECT * FROM business_installation_grants
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
       ORDER BY subject`,
      [normalized.org, normalized.app, normalized.env, normalized.installationId],
    );
    return result.rows.map(grantFromRow);
  }

  async setGrant(
    input: Parameters<BusinessGrantStore['setGrant']>[0],
  ): Promise<GrantMutationResult> {
    const scope = validateScope(input.scope);
    const subject = validateScalar('grant subject', input.subject, 256);
    const actor = validateScalar('actor subject', input.actorSubject, 256);
    const email = validateEmail(input.email);
    permissionsForBusinessRole(input.role);
    validateExpectedRevision(input.expectedRevision);
    return inTransaction(this.#pool, async (client) => {
      if (!(await lockInstallation(client, scope))) {
        return { ok: false, reason: 'not_found', currentRevision: 0 };
      }
      const current = await grantRow(client, scope, subject);
      const currentRevision = current === undefined ? 0 : Number(current.revision);
      if (currentRevision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision };
      }
      if (
        current?.role === 'administrator' &&
        current.revoked_at === null &&
        input.role !== 'administrator' &&
        (await liveAdministratorCount(client, scope)) === 1
      ) {
        return { ok: false, reason: 'last_administrator', currentRevision };
      }
      const now = this.#now();
      const result =
        current === undefined
          ? await client.query<GrantRow>(
              `INSERT INTO business_installation_grants
                (org_slug, app_slug, environment, installation_id, subject, email, role, revision,
                 created_at, created_by_subject, updated_at, updated_by_subject)
               VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$8,$9) RETURNING *`,
              [
                scope.org,
                scope.app,
                scope.env,
                scope.installationId,
                subject,
                email,
                input.role,
                now,
                actor,
              ],
            )
          : await client.query<GrantRow>(
              `UPDATE business_installation_grants
               SET email=$6, role=$7, revision=revision+1, updated_at=$8,
                   updated_by_subject=$9, revoked_at=NULL
               WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
                 AND subject=$5 AND revision=$10 RETURNING *`,
              [
                scope.org,
                scope.app,
                scope.env,
                scope.installationId,
                subject,
                email,
                input.role,
                now,
                actor,
                input.expectedRevision,
              ],
            );
      const row = result.rows[0];
      if (row === undefined) throw new Error('business grant mutation lost its installation lock');
      return { ok: true, grant: grantFromRow(row) };
    });
  }

  async revokeGrant(
    input: Parameters<BusinessGrantStore['revokeGrant']>[0],
  ): Promise<GrantMutationResult> {
    const scope = validateScope(input.scope);
    const subject = validateScalar('grant subject', input.subject, 256);
    const actor = validateScalar('actor subject', input.actorSubject, 256);
    validateExpectedRevision(input.expectedRevision);
    return inTransaction(this.#pool, async (client) => {
      if (!(await lockInstallation(client, scope))) {
        return { ok: false, reason: 'not_found', currentRevision: 0 };
      }
      const current = await grantRow(client, scope, subject);
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      const currentRevision = Number(current.revision);
      if (currentRevision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision };
      }
      if (
        current.role === 'administrator' &&
        current.revoked_at === null &&
        (await liveAdministratorCount(client, scope)) === 1
      ) {
        return { ok: false, reason: 'last_administrator', currentRevision };
      }
      const result = await client.query<GrantRow>(
        `UPDATE business_installation_grants
         SET revision=revision+1, updated_at=$6, updated_by_subject=$7, revoked_at=$6
         WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
           AND subject=$5 AND revision=$8 RETURNING *`,
        [
          scope.org,
          scope.app,
          scope.env,
          scope.installationId,
          subject,
          this.#now(),
          actor,
          input.expectedRevision,
        ],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error('business grant revocation lost its installation lock');
      return { ok: true, grant: grantFromRow(row) };
    });
  }
}

async function lockInstallation(client: PoolClient, scope: InstallationScope): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM business_solution_installations
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4 FOR NO KEY UPDATE`,
    [scope.org, scope.app, scope.env, scope.installationId],
  );
  return result.rowCount === 1;
}

async function grantRow(
  client: PoolClient,
  scope: InstallationScope,
  subject: string,
): Promise<GrantRow | undefined> {
  const result = await client.query<GrantRow>(
    `SELECT * FROM business_installation_grants
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4 AND subject=$5`,
    [scope.org, scope.app, scope.env, scope.installationId, subject],
  );
  return result.rows[0];
}

async function liveAdministratorCount(
  client: PoolClient,
  scope: InstallationScope,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM business_installation_grants
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
       AND role='administrator' AND revoked_at IS NULL`,
    [scope.org, scope.app, scope.env, scope.installationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
