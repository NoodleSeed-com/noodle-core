import type { Pool, PoolClient } from 'pg';
import type { BusinessGrantStore, InstallationScope } from './contracts.js';
import {
  normalizeInvitationInput,
  validateInvitationClaim,
  validateInvitationMutation,
} from './invitations.js';
import { permissionsForBusinessRole } from './model.js';
import {
  type GrantRow,
  grantFromRow,
  type InvitationRow,
  invitationFromRow,
} from './postgres-rows.js';
import { inTransaction } from './postgres-transaction.js';
import { validateScope } from './validation.js';

export class PostgresBusinessInvitations {
  readonly #now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: { readonly now?: () => Date } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  async create(
    input: Parameters<BusinessGrantStore['createInvitation']>[0],
  ): ReturnType<BusinessGrantStore['createInvitation']> {
    permissionsForBusinessRole(input.role);
    const normalized = normalizeInvitationInput(input);
    return inTransaction(this.pool, async (client) => {
      if (!(await lockInstallation(client, normalized.scope))) {
        throw new Error('invitation installation is missing');
      }
      const replay = await client.query<InvitationRow>(
        `SELECT * FROM business_installation_invitations
         WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
           AND idempotency_digest=$5`,
        scopeValues(normalized.scope, normalized.idempotencyDigest),
      );
      const existing = replay.rows[0];
      if (existing !== undefined) {
        return {
          disposition:
            existing.create_fingerprint === normalized.createFingerprint ? 'replayed' : 'conflict',
          invitation: invitationFromRow(existing),
        };
      }
      const inserted = await client.query<InvitationRow>(
        `INSERT INTO business_installation_invitations
           (org_slug, app_slug, environment, installation_id, invitation_id, email, role,
            token_digest, idempotency_digest, create_fingerprint, revision, created_at,
            expires_at, created_by_subject)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$13) RETURNING *`,
        [
          normalized.scope.org,
          normalized.scope.app,
          normalized.scope.env,
          normalized.scope.installationId,
          normalized.invitationId,
          normalized.email,
          normalized.role,
          normalized.tokenDigest,
          normalized.idempotencyDigest,
          normalized.createFingerprint,
          this.#now(),
          normalized.expiresAt,
          normalized.actorSubject,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('invitation insert returned no row');
      return { disposition: 'created', invitation: invitationFromRow(row) };
    });
  }

  async list(scope: InstallationScope) {
    const normalized = validateScope(scope);
    const result = await this.pool.query<InvitationRow>(
      `SELECT * FROM business_installation_invitations
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
       ORDER BY created_at DESC, invitation_id`,
      scopeValues(normalized),
    );
    return result.rows.map(invitationFromRow);
  }

  async revoke(
    input: Parameters<BusinessGrantStore['revokeInvitation']>[0],
  ): ReturnType<BusinessGrantStore['revokeInvitation']> {
    const normalized = validateInvitationMutation(input);
    return inTransaction(this.pool, async (client) => {
      const current = await invitationById(client, normalized.scope, normalized.invitationId);
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      const currentRevision = Number(current.revision);
      if (currentRevision !== normalized.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision };
      }
      if (current.accepted_at !== null || current.revoked_at !== null) {
        return { ok: false, reason: 'already_used', currentRevision };
      }
      const updated = await client.query<InvitationRow>(
        `UPDATE business_installation_invitations
         SET revision=revision+1, revoked_at=$6, revoked_by_subject=$7
         WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
           AND invitation_id=$5 AND revision=$8 RETURNING *`,
        [
          normalized.scope.org,
          normalized.scope.app,
          normalized.scope.env,
          normalized.scope.installationId,
          normalized.invitationId,
          this.#now(),
          normalized.actorSubject,
          normalized.expectedRevision,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new Error('invitation revocation lost its row lock');
      return { ok: true, invitation: invitationFromRow(row) };
    });
  }

  async claim(
    input: Parameters<BusinessGrantStore['claimInvitation']>[0],
  ): ReturnType<BusinessGrantStore['claimInvitation']> {
    const normalized = validateInvitationClaim(input);
    return inTransaction(this.pool, async (client) => {
      const selected = await client.query<InvitationRow>(
        'SELECT * FROM business_installation_invitations WHERE token_digest=$1 FOR UPDATE',
        [normalized.tokenDigest],
      );
      const current = selected.rows[0];
      if (current === undefined) return { ok: false, reason: 'not_found' };
      if (current.accepted_at !== null) return { ok: false, reason: 'already_used' };
      if (current.revoked_at !== null) return { ok: false, reason: 'revoked' };
      if (current.expires_at.getTime() <= this.#now().getTime()) {
        return { ok: false, reason: 'expired' };
      }
      if (current.email !== normalized.email) return { ok: false, reason: 'email_mismatch' };
      const scope = scopeFromInvitation(current);
      if (!(await lockInstallation(client, scope))) return { ok: false, reason: 'not_found' };
      const previous = await grantBySubject(client, scope, normalized.subject);
      if (
        previous?.role === 'administrator' &&
        previous.revoked_at === null &&
        current.role !== 'administrator' &&
        (await liveAdministratorCount(client, scope)) === 1
      ) {
        return { ok: false, reason: 'last_administrator' };
      }
      const now = this.#now();
      const grant =
        previous === undefined
          ? await client.query<GrantRow>(
              `INSERT INTO business_installation_grants
               (org_slug, app_slug, environment, installation_id, subject, email, role, revision,
                created_at, created_by_subject, updated_at, updated_by_subject)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$8,$5) RETURNING *`,
              [
                scope.org,
                scope.app,
                scope.env,
                scope.installationId,
                normalized.subject,
                normalized.email,
                current.role,
                now,
                current.created_by_subject,
              ],
            )
          : await client.query<GrantRow>(
              `UPDATE business_installation_grants
             SET email=$6, role=$7, revision=revision+1, updated_at=$8,
                 updated_by_subject=$5, revoked_at=NULL
             WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
               AND subject=$5 RETURNING *`,
              [
                scope.org,
                scope.app,
                scope.env,
                scope.installationId,
                normalized.subject,
                normalized.email,
                current.role,
                now,
              ],
            );
      const claimed = await client.query<InvitationRow>(
        `UPDATE business_installation_invitations
         SET revision=revision+1, accepted_at=$2, accepted_by_subject=$3
         WHERE token_digest=$1 RETURNING *`,
        [normalized.tokenDigest, now, normalized.subject],
      );
      const grantRow = grant.rows[0];
      const invitationRow = claimed.rows[0];
      if (grantRow === undefined || invitationRow === undefined) {
        throw new Error('invitation claim returned incomplete state');
      }
      return {
        ok: true,
        invitation: invitationFromRow(invitationRow),
        grant: grantFromRow(grantRow),
      };
    });
  }
}

function scopeValues(scope: InstallationScope, tail?: string): string[] {
  return [scope.org, scope.app, scope.env, scope.installationId, ...(tail ? [tail] : [])];
}

function scopeFromInvitation(row: InvitationRow): InstallationScope {
  return {
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    installationId: row.installation_id,
  };
}

async function lockInstallation(client: PoolClient, scope: InstallationScope): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM business_solution_installations
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4 FOR NO KEY UPDATE`,
    scopeValues(scope),
  );
  return result.rowCount === 1;
}

async function invitationById(client: PoolClient, scope: InstallationScope, invitationId: string) {
  const result = await client.query<InvitationRow>(
    `SELECT * FROM business_installation_invitations
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
       AND invitation_id=$5 FOR UPDATE`,
    scopeValues(scope, invitationId),
  );
  return result.rows[0];
}

async function grantBySubject(client: PoolClient, scope: InstallationScope, subject: string) {
  const result = await client.query<GrantRow>(
    `SELECT * FROM business_installation_grants
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
       AND subject=$5 FOR UPDATE`,
    scopeValues(scope, subject),
  );
  return result.rows[0];
}

async function liveAdministratorCount(
  client: PoolClient,
  scope: InstallationScope,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM business_installation_grants
     WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
       AND role='administrator' AND revoked_at IS NULL`,
    scopeValues(scope),
  );
  return Number(result.rows[0]?.count ?? 0);
}
