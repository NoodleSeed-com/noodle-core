import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { validateSlug } from '../store/validate.js';
import { validatePublicJwk } from './service-principal-credentials.js';
import {
  type ActiveServicePrincipalClient,
  type ActiveServicePrincipalCredential,
  type AssertionJtiInput,
  type CreateServicePrincipalGrantInput,
  type CreateServicePrincipalInput,
  type CreateStoredCredentialInput,
  type CredentialMutation,
  currentServicePrincipalDate,
  type GrantMutation,
  normalizeServicePrincipalExpiry,
  normalizeServicePrincipalScopes,
  type PrincipalMutation,
  type PrincipalRef,
  publicServicePrincipalCredential,
  type ServicePrincipalAccessBinding,
  type ServicePrincipalCredentialRecord,
  type ServicePrincipalGrantRecord,
  type ServicePrincipalRecord,
  type ServicePrincipalStore,
  type ServicePrincipalView,
  validateServicePrincipalActor,
  validateServicePrincipalDisplayName,
  validateServicePrincipalEpoch,
  validateServicePrincipalSecretDigest,
} from './service-principal-store.js';
import { ensureServicePrincipalSchema } from './service-principal-store-postgres-schema.js';

interface PrincipalRow {
  readonly principal_id: string;
  readonly org_slug: string;
  readonly name: string;
  readonly status: 'active' | 'revoked';
  readonly created_by_subject: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_by_subject: string | null;
}

interface GrantRow {
  readonly grant_id: string;
  readonly principal_id: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly scopes: string[];
  readonly status: 'active' | 'revoked';
  readonly created_by_subject: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_by_subject: string | null;
}

interface CredentialRow {
  readonly credential_id: string;
  readonly principal_id: string;
  readonly kind: 'public_jwk' | 'client_secret';
  readonly label: string;
  readonly algorithm: 'RS256' | 'ES256' | null;
  readonly kid: string | null;
  readonly public_jwk: Record<string, unknown> | null;
  readonly secret_digest: string | null;
  readonly status: 'active' | 'revoked';
  readonly created_by_subject: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_by_subject: string | null;
}

/** Durable, organization-isolated service-principal lifecycle and assertion replay store. */
export class PostgresServicePrincipalStore implements ServicePrincipalStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, options: { readonly now?: () => Date } = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
  }

  async ensureSchema(): Promise<void> {
    await ensureServicePrincipalSchema(this.#pool);
  }

  async createPrincipal(input: CreateServicePrincipalInput): Promise<ServicePrincipalRecord> {
    const now = currentServicePrincipalDate(this.#now);
    const values = {
      principalId: `spn_${randomUUID()}`,
      org: validateSlug('org', input.org),
      name: validateServicePrincipalDisplayName('service-principal name', input.name),
      actor: validateServicePrincipalActor(input.actorSubject),
    };
    const { rows } = await this.#pool.query<PrincipalRow>(
      `INSERT INTO oauth_service_principals
        (principal_id, org_slug, name, status, created_by_subject, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $5)
       RETURNING *`,
      [values.principalId, values.org, values.name, values.actor, now],
    );
    return principalFromRow(requireRow(rows[0], 'service-principal create'));
  }

  async listPrincipals(org: string): Promise<readonly ServicePrincipalRecord[]> {
    const normalizedOrg = validateSlug('org', org);
    const { rows } = await this.#pool.query<PrincipalRow>(
      `SELECT * FROM oauth_service_principals
       WHERE org_slug = $1 ORDER BY principal_id`,
      [normalizedOrg],
    );
    return rows.map(principalFromRow);
  }

  async getPrincipal(input: PrincipalRef): Promise<ServicePrincipalView | undefined> {
    const org = validateSlug('org', input.org);
    const { rows } = await this.#pool.query<PrincipalRow>(
      `SELECT * FROM oauth_service_principals
       WHERE principal_id = $1 AND org_slug = $2`,
      [input.principalId, org],
    );
    const principal = rows[0];
    if (principal === undefined) return undefined;
    const [grants, credentials] = await Promise.all([
      this.#pool.query<GrantRow>(
        `SELECT * FROM oauth_service_principal_grants
         WHERE principal_id = $1 ORDER BY grant_id`,
        [input.principalId],
      ),
      this.#pool.query<CredentialRow>(
        `SELECT * FROM oauth_service_principal_credentials
         WHERE principal_id = $1 ORDER BY credential_id`,
        [input.principalId],
      ),
    ]);
    return {
      principal: principalFromRow(principal),
      grants: grants.rows.map(grantFromRow),
      credentials: credentials.rows.map(credentialFromRow).map(publicServicePrincipalCredential),
    };
  }

  async revokePrincipal(input: PrincipalMutation): Promise<boolean> {
    const org = validateSlug('org', input.org);
    const actor = validateServicePrincipalActor(input.actorSubject);
    const now = currentServicePrincipalDate(this.#now);
    const { rows } = await this.#pool.query<PrincipalRow>(
      `UPDATE oauth_service_principals SET
         status = 'revoked', updated_at = CASE WHEN status = 'active' THEN $3 ELSE updated_at END,
         revoked_at = COALESCE(revoked_at, $3),
         revoked_by_subject = COALESCE(revoked_by_subject, $4)
       WHERE principal_id = $1 AND org_slug = $2
       RETURNING *`,
      [input.principalId, org, now, actor],
    );
    return rows[0] !== undefined;
  }

  async createGrant(input: CreateServicePrincipalGrantInput): Promise<ServicePrincipalGrantRecord> {
    const org = validateSlug('org', input.org);
    const app = validateSlug('app', input.app);
    const environment = validateSlug('env', input.environment);
    const scopes = normalizeServicePrincipalScopes(input.scopes);
    const actor = validateServicePrincipalActor(input.actorSubject);
    const now = currentServicePrincipalDate(this.#now);
    return this.#transaction(async (client) => {
      await requireActivePrincipal(client, input.principalId, org);
      const existing = await client.query(
        `SELECT 1 FROM oauth_service_principal_grants
         WHERE principal_id = $1 AND app_slug = $2 AND environment = $3 AND status = 'active'`,
        [input.principalId, app, environment],
      );
      if (existing.rowCount !== 0) {
        throw new Error(
          'service principal already has an active grant for this app and environment',
        );
      }
      try {
        const { rows } = await client.query<GrantRow>(
          `INSERT INTO oauth_service_principal_grants
            (grant_id, principal_id, org_slug, app_slug, environment, scopes, status,
             created_by_subject, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8)
           RETURNING *`,
          [`spg_${randomUUID()}`, input.principalId, org, app, environment, scopes, actor, now],
        );
        return grantFromRow(requireRow(rows[0], 'service-principal grant create'));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new Error(
            'service principal already has an active grant for this app and environment',
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  async revokeGrant(input: GrantMutation): Promise<boolean> {
    const org = validateSlug('org', input.org);
    const actor = validateServicePrincipalActor(input.actorSubject);
    const now = currentServicePrincipalDate(this.#now);
    return this.#transaction(async (client) => {
      const principal = await ownedPrincipal(client, input.principalId, org, true);
      if (principal === undefined) return false;
      const { rows } = await client.query<GrantRow>(
        `UPDATE oauth_service_principal_grants SET
           status = 'revoked', updated_at = CASE WHEN status = 'active' THEN $3 ELSE updated_at END,
           revoked_at = COALESCE(revoked_at, $3),
           revoked_by_subject = COALESCE(revoked_by_subject, $4)
         WHERE grant_id = $1 AND principal_id = $2
         RETURNING *`,
        [input.grantId, input.principalId, now, actor],
      );
      return rows[0] !== undefined;
    });
  }

  async createCredential(
    input: CreateStoredCredentialInput,
  ): Promise<ServicePrincipalCredentialRecord> {
    const org = validateSlug('org', input.org);
    const actor = validateServicePrincipalActor(input.actorSubject);
    const label = validateServicePrincipalDisplayName('credential label', input.label);
    const now = currentServicePrincipalDate(this.#now);
    const expiresAt = normalizeServicePrincipalExpiry(input.expiresAt, now);
    const material =
      input.kind === 'client_secret'
        ? {
            algorithm: null,
            kid: null,
            publicJwk: null,
            secretDigest: validateServicePrincipalSecretDigest(input.secretDigest),
          }
        : await validatePublicJwk(input.publicJwk, input.algorithm).then((validated) => ({
            algorithm: validated.algorithm,
            kid: typeof validated.publicJwk.kid === 'string' ? validated.publicJwk.kid : null,
            publicJwk: validated.publicJwk,
            secretDigest: null,
          }));
    return this.#transaction(async (client) => {
      await requireActivePrincipal(client, input.principalId, org);
      const { rows: counts } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM oauth_service_principal_credentials
         WHERE principal_id = $1 AND kind = $2 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > $3)`,
        [input.principalId, input.kind, now],
      );
      if (Number(requireRow(counts[0], 'service-principal credential count').count) >= 5) {
        throw new Error(`service principal may have at most five active ${input.kind} credentials`);
      }
      const { rows } = await client.query<CredentialRow>(
        `INSERT INTO oauth_service_principal_credentials
          (credential_id, principal_id, org_slug, kind, label, algorithm, kid, public_jwk,
           secret_digest, status, created_by_subject, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $11, $12)
         RETURNING *`,
        [
          `spc_${randomUUID()}`,
          input.principalId,
          org,
          input.kind,
          label,
          material.algorithm,
          material.kid,
          material.publicJwk,
          material.secretDigest,
          actor,
          now,
          expiresAt ?? null,
        ],
      );
      return publicServicePrincipalCredential(
        credentialFromRow(requireRow(rows[0], 'service-principal credential create')),
      );
    });
  }

  async revokeCredential(input: CredentialMutation): Promise<boolean> {
    const org = validateSlug('org', input.org);
    const actor = validateServicePrincipalActor(input.actorSubject);
    const now = currentServicePrincipalDate(this.#now);
    return this.#transaction(async (client) => {
      const principal = await ownedPrincipal(client, input.principalId, org, true);
      if (principal === undefined) return false;
      const { rows } = await client.query<CredentialRow>(
        `UPDATE oauth_service_principal_credentials SET
           status = 'revoked', updated_at = CASE WHEN status = 'active' THEN $3 ELSE updated_at END,
           revoked_at = COALESCE(revoked_at, $3),
           revoked_by_subject = COALESCE(revoked_by_subject, $4)
         WHERE credential_id = $1 AND principal_id = $2
         RETURNING *`,
        [input.credentialId, input.principalId, now, actor],
      );
      return rows[0] !== undefined;
    });
  }

  async loadActiveClient(
    clientId: string,
    now: number,
  ): Promise<ActiveServicePrincipalClient | undefined> {
    validateServicePrincipalEpoch('authorization time', now);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows } = await client.query<PrincipalRow>(
        `SELECT * FROM oauth_service_principals
         WHERE principal_id = $1 AND status = 'active'`,
        [clientId],
      );
      const principal = rows[0];
      if (principal === undefined) {
        await client.query('COMMIT');
        return undefined;
      }
      const [grants, credentials] = await Promise.all([
        client.query<GrantRow>(
          `SELECT * FROM oauth_service_principal_grants
           WHERE principal_id = $1 AND status = 'active' ORDER BY grant_id`,
          [clientId],
        ),
        client.query<CredentialRow>(
          `SELECT * FROM oauth_service_principal_credentials
           WHERE principal_id = $1 AND status = 'active'
             AND (expires_at IS NULL OR expires_at > $2) ORDER BY credential_id`,
          [clientId, new Date(now)],
        ),
      ]);
      await client.query('COMMIT');
      return {
        principal: principalFromRow(principal),
        grants: grants.rows.map(grantFromRow),
        credentials: credentials.rows.map(credentialFromRow),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async validateAccessBinding(input: ServicePrincipalAccessBinding): Promise<boolean> {
    validateServicePrincipalEpoch('authorization time', input.now);
    const { rowCount } = await this.#pool.query(
      `SELECT 1
       FROM oauth_service_principals p
       JOIN oauth_service_principal_grants g
         ON g.principal_id = p.principal_id AND g.org_slug = p.org_slug
       JOIN oauth_service_principal_credentials c
         ON c.principal_id = p.principal_id AND c.org_slug = p.org_slug
       WHERE p.principal_id = $1 AND p.org_slug = $2 AND p.status = 'active'
         AND g.grant_id = $3 AND g.app_slug = $4 AND g.environment = $5 AND g.status = 'active'
         AND c.credential_id = $6 AND c.status = 'active'
         AND (c.expires_at IS NULL OR c.expires_at > $7)`,
      [
        input.principalId,
        input.org,
        input.grantId,
        input.app,
        input.environment,
        input.credentialId,
        new Date(input.now),
      ],
    );
    return rowCount === 1;
  }

  async consumeAssertionJti(input: AssertionJtiInput): Promise<boolean> {
    validateServicePrincipalEpoch('assertion time', input.now);
    validateServicePrincipalEpoch('assertion expiry', input.expiresAt);
    if (input.expiresAt <= input.now) throw new Error('assertion expiry must be in the future');
    if (input.jti.length < 1 || input.jti.length > 200) {
      throw new Error('assertion jti must be between 1 and 200 characters');
    }
    return this.#transaction(async (client) => {
      await client.query('DELETE FROM oauth_client_assertion_nonces WHERE expires_at <= $1', [
        new Date(input.now),
      ]);
      const result = await client.query(
        `INSERT INTO oauth_client_assertion_nonces
          (credential_id, jti, expires_at, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (credential_id, jti) DO NOTHING
         RETURNING credential_id`,
        [input.credentialId, input.jti, new Date(input.expiresAt), new Date(input.now)],
      );
      return result.rowCount === 1;
    });
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function ownedPrincipal(
  client: PoolClient,
  principalId: string,
  org: string,
  strict: boolean,
): Promise<PrincipalRow | undefined> {
  const { rows } = await client.query<PrincipalRow>(
    'SELECT * FROM oauth_service_principals WHERE principal_id = $1 FOR UPDATE',
    [principalId],
  );
  const principal = rows[0];
  if (principal === undefined || principal.org_slug === org) return principal;
  if (strict) throw new Error('service principal belongs to a different organization');
  return undefined;
}

async function requireActivePrincipal(
  client: PoolClient,
  principalId: string,
  org: string,
): Promise<PrincipalRow> {
  const principal = await ownedPrincipal(client, principalId, org, true);
  if (principal === undefined) throw new Error('service principal does not exist');
  if (principal.status !== 'active') throw new Error('service principal is revoked');
  return principal;
}

function principalFromRow(row: PrincipalRow): ServicePrincipalRecord {
  return {
    principalId: row.principal_id,
    org: row.org_slug,
    name: row.name,
    status: row.status,
    createdBySubject: row.created_by_subject,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
    ...(row.revoked_by_subject === null ? {} : { revokedBySubject: row.revoked_by_subject }),
  };
}

function grantFromRow(row: GrantRow): ServicePrincipalGrantRecord {
  return {
    grantId: row.grant_id,
    principalId: row.principal_id,
    org: row.org_slug,
    app: row.app_slug,
    environment: row.environment,
    scopes: Object.freeze([...row.scopes]),
    status: row.status,
    createdBySubject: row.created_by_subject,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
    ...(row.revoked_by_subject === null ? {} : { revokedBySubject: row.revoked_by_subject }),
  };
}

function credentialFromRow(row: CredentialRow): ActiveServicePrincipalCredential {
  const lifecycle = {
    credentialId: row.credential_id,
    principalId: row.principal_id,
    label: row.label,
    status: row.status,
    createdBySubject: row.created_by_subject,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
    ...(row.revoked_by_subject === null ? {} : { revokedBySubject: row.revoked_by_subject }),
  };
  if (row.kind === 'client_secret') {
    if (row.secret_digest === null) throw new Error('stored client secret is missing its digest');
    return { ...lifecycle, kind: 'client_secret', secretDigest: row.secret_digest };
  }
  if (row.algorithm === null || row.public_jwk === null) {
    throw new Error('stored public-key credential is missing its signing material');
  }
  return {
    ...lifecycle,
    kind: 'public_jwk',
    algorithm: row.algorithm,
    publicJwk: structuredClone(row.public_jwk),
    ...(row.kid === null ? {} : { kid: row.kid }),
  };
}

function requireRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`${label} returned no row`);
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}
