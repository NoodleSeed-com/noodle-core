import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PlatformHumanIdentityContribution } from '@noodle-borg/module';
import type { Pool, PoolClient } from 'pg';
import { createModuleSqlTransaction } from '../modules/context.js';
import type {
  DeviceAuthorizationIdentity,
  DeviceAuthorizationPoll,
  DeviceAuthorizationRecord,
  DeviceBrowserSessionRecord,
} from './device-store.js';
import {
  type DeviceAuthorizationRow,
  type DeviceBrowserSessionRow,
  deviceBrowserRowToRecord,
  deviceRowToRecord,
} from './device-store-postgres-types.js';
import { publicOAuthScope } from './fresh-auth.js';
import { postgresEpochSeconds, postgresTimestampIsLive } from './postgres-time.js';
import type {
  AuthorizationCodeRecord,
  ConsentGrantIdentityKind,
  ConsentGrantRecord,
  DelegatedCredentialLookup,
  DelegatedCredentialRecord,
  OAuthStore,
  PendingAuthorizationRecord,
  RefreshRotation,
  RefreshRotationInput,
  RefreshTokenRecord,
} from './store.js';
import {
  type AuthCodeRow,
  authCodeRowToRecord,
  type DelegatedCredentialRow,
  type PendingRow,
  type RefreshRow,
  refreshRowToRecord,
  rowIdentity,
  sameFamily,
} from './store-postgres-rows.js';
import { ensureOAuthStoreSchema } from './store-postgres-schema.js';

/** Relational {@link OAuthStore} for the self-hosted authorization server (OA-2,
 * [ADR 0042](../../../../docs/decisions/0042-self-hosted-oauth-authorization-server.md)). Shares the injected
 * `pg.Pool` with {@link PostgresArtifactStore} so the AS state lives in the same strongly-consistent store
 * that backs deployments — any Cloud Run instance can complete a flow another started.
 *
 * Single-use semantics are enforced in SQL: `DELETE … RETURNING` (codes, pending auth, refresh tokens) is
 * row-atomic, so two concurrent redemptions of the same value yield exactly one winner; the loser gets zero
 * rows. Expired rows are still deleted on consume (and returned as `undefined`), which doubles as cleanup.
 */
export class PostgresOAuthStore implements OAuthStore {
  readonly #pool: Pool;
  readonly #platformIdentity: Pick<
    PlatformHumanIdentityContribution,
    'initializeOAuthPersistence' | 'assertRefreshPrincipal'
  >;

  constructor(
    pool: Pool,
    options: Pick<
      PlatformHumanIdentityContribution,
      'initializeOAuthPersistence' | 'assertRefreshPrincipal'
    > = {},
  ) {
    this.#pool = pool;
    this.#platformIdentity = options;
  }

  /** Create the OAuth tables if absent (idempotent). Run once at startup before serving AS endpoints. */
  async ensureSchema(): Promise<void> {
    await ensureOAuthStoreSchema(this.#pool);
    await this.#platformIdentity.initializeOAuthPersistence?.();
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await this.#pool.query<{ client: OAuthClientInformationFull }>(
      'SELECT client FROM oauth_clients WHERE client_id = $1',
      [clientId],
    );
    return rows[0]?.client;
  }

  async getClientPurpose(clientId: string): Promise<'console' | 'portal' | 'dynamic' | undefined> {
    const { rows } = await this.#pool.query<{ first_party_owner: 'console' | 'portal' | null }>(
      'SELECT first_party_owner FROM oauth_clients WHERE client_id=$1',
      [clientId],
    );
    return rows[0] === undefined ? undefined : (rows[0].first_party_owner ?? 'dynamic');
  }

  async putClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    const result = await this.#pool.query<{ readonly client_id: string }>(
      `INSERT INTO oauth_clients (client_id, client) VALUES ($1, $2::jsonb)
       ON CONFLICT (client_id) DO UPDATE SET client = EXCLUDED.client
         WHERE oauth_clients.first_party_owner IS NULL
       RETURNING client_id`,
      [client.client_id, JSON.stringify(client)],
    );
    if (result.rows[0] === undefined) {
      throw new Error('OAuth client ID is reserved by a first-party client');
    }
    return client;
  }

  async putFirstPartyClient(
    owner: 'console' | 'portal',
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    const result = await this.#pool.query<{ readonly client_id: string }>(
      `INSERT INTO oauth_clients (client_id, client, first_party_owner)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (client_id) DO UPDATE SET client = EXCLUDED.client
         WHERE oauth_clients.first_party_owner = EXCLUDED.first_party_owner
       RETURNING client_id`,
      [client.client_id, JSON.stringify(client), owner],
    );
    if (result.rows[0] === undefined) {
      throw new Error('OAuth client ID is already registered through DCR');
    }
    return client;
  }

  async createPendingAuthorization(record: PendingAuthorizationRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO oauth_pending_authorizations
         (state, client_id, redirect_uri, code_challenge, client_state, resource, scope, upstream_provider, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
      [
        record.state,
        record.clientId,
        record.redirectUri,
        record.codeChallenge,
        record.clientState ?? null,
        record.resource,
        record.scope ?? null,
        record.upstreamProvider,
        record.expiresAt,
      ],
    );
  }

  async consumePendingAuthorization(
    state: string,
    expectedUpstreamProvider: PendingAuthorizationRecord['upstreamProvider'],
  ): Promise<PendingAuthorizationRecord | undefined> {
    const { rows } = await this.#pool.query<PendingRow>(
      `DELETE FROM oauth_pending_authorizations
        WHERE state = $1 AND upstream_provider = $2
        RETURNING *`,
      [state, expectedUpstreamProvider],
    );
    const row = rows[0];
    if (!row || !postgresTimestampIsLive(row.expires_at)) return undefined;
    return {
      state: row.state,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      ...(row.client_state !== null ? { clientState: row.client_state } : {}),
      resource: row.resource,
      ...(row.scope !== null ? { scope: row.scope } : {}),
      upstreamProvider: row.upstream_provider,
      expiresAt: postgresEpochSeconds(row.expires_at),
    };
  }

  async createAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO oauth_authorization_codes
         (code, client_id, code_challenge, redirect_uri, resource, owner_subject, owner_email,
          owner_locale, owner_time_zone, scope, roles, identity_kind, identity_provider,
          customer_issuer, developer_grant_id, auth_time, upstream_expires_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14,
         $15, to_timestamp($16), to_timestamp($17), to_timestamp($18))`,
      [
        record.code,
        record.clientId,
        record.codeChallenge,
        record.redirectUri,
        record.resource,
        record.ownerSubject,
        record.ownerEmail ?? null,
        record.ownerLocale ?? null,
        record.ownerTimeZone ?? null,
        record.scope ?? null,
        record.roles === undefined ? null : JSON.stringify(record.roles),
        record.identityKind ?? null,
        record.identityProvider ?? null,
        record.customerIssuer ?? null,
        record.developerGrantId ?? null,
        record.authTime ?? null,
        record.upstreamExpiresAt ?? null,
        record.expiresAt,
      ],
    );
  }

  async getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const { rows } = await this.#pool.query<AuthCodeRow>(
      'SELECT * FROM oauth_authorization_codes WHERE code = $1 AND expires_at > now()',
      [code],
    );
    const row = rows[0];
    return row ? authCodeRowToRecord(row) : undefined;
  }

  async redeemAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const { rows } = await this.#pool.query<AuthCodeRow>(
      'DELETE FROM oauth_authorization_codes WHERE code = $1 RETURNING *',
      [code],
    );
    const row = rows[0];
    if (!row || !postgresTimestampIsLive(row.expires_at)) return undefined;
    return authCodeRowToRecord(row);
  }

  async createDeviceAuthorization(record: DeviceAuthorizationRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO oauth_device_authorizations
         (device_code, user_code, client_id, resource, scope, status, expires_at, next_poll_at,
          interval_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), to_timestamp($8), $9)`,
      [
        record.deviceCode,
        record.userCode,
        record.clientId,
        record.resource,
        record.scope ?? null,
        record.status,
        record.expiresAt,
        record.nextPollAt,
        record.intervalSeconds,
      ],
    );
  }

  async getDeviceAuthorizationByUserCode(
    userCode: string,
  ): Promise<DeviceAuthorizationRecord | undefined> {
    const { rows } = await this.#pool.query<DeviceAuthorizationRow>(
      `SELECT * FROM oauth_device_authorizations
        WHERE user_code = $1 AND status = 'pending' AND expires_at > now()`,
      [userCode],
    );
    return rows[0] === undefined ? undefined : deviceRowToRecord(rows[0]);
  }

  async createDeviceBrowserSession(record: DeviceBrowserSessionRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO oauth_device_browser_sessions
         (state, device_code, client_id, resource, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
      [
        record.state,
        record.deviceCode,
        record.clientId,
        record.resource,
        record.codeChallenge,
        record.expiresAt,
      ],
    );
  }

  async consumeDeviceBrowserSession(
    state: string,
  ): Promise<DeviceBrowserSessionRecord | undefined> {
    const { rows } = await this.#pool.query<DeviceBrowserSessionRow>(
      'DELETE FROM oauth_device_browser_sessions WHERE state = $1 RETURNING *',
      [state],
    );
    const row = rows[0];
    if (row === undefined || !postgresTimestampIsLive(row.expires_at)) return undefined;
    return deviceBrowserRowToRecord(row);
  }

  async approveDeviceAuthorization(
    deviceCode: string,
    identity: DeviceAuthorizationIdentity,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE oauth_device_authorizations
          SET status = 'approved', owner_subject = $2, owner_email = $3, owner_locale = $4,
              owner_time_zone = $5, identity_kind = $6, identity_provider = $7,
              customer_issuer = $8, developer_grant_id = $9
        WHERE device_code = $1 AND status = 'pending' AND expires_at > now()`,
      [
        deviceCode,
        identity.ownerSubject,
        identity.ownerEmail ?? null,
        identity.ownerLocale ?? null,
        identity.ownerTimeZone ?? null,
        identity.identityKind ?? null,
        identity.identityProvider ?? null,
        identity.customerIssuer ?? null,
        identity.developerGrantId ?? null,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async denyDeviceAuthorization(deviceCode: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE oauth_device_authorizations SET status = 'denied'
        WHERE device_code = $1 AND status = 'pending' AND expires_at > now()`,
      [deviceCode],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async pollDeviceAuthorization(input: {
    readonly deviceCode: string;
    readonly clientId: string;
    readonly resource?: string;
    readonly nowSeconds: number;
  }): Promise<DeviceAuthorizationPoll> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<DeviceAuthorizationRow>(
        'SELECT * FROM oauth_device_authorizations WHERE device_code = $1 FOR UPDATE',
        [input.deviceCode],
      );
      const row = rows[0];
      if (row === undefined || postgresEpochSeconds(row.expires_at) <= input.nowSeconds) {
        if (row !== undefined) {
          await client.query('DELETE FROM oauth_device_authorizations WHERE device_code = $1', [
            input.deviceCode,
          ]);
        }
        await client.query('COMMIT');
        return { status: 'expired_token' };
      }
      if (
        row.client_id !== input.clientId ||
        (input.resource !== undefined && row.resource !== input.resource)
      ) {
        await client.query('COMMIT');
        return { status: 'invalid_grant' };
      }
      if (row.status === 'denied' || row.status === 'approved') {
        if (row.status === 'denied') {
          await client.query('DELETE FROM oauth_device_authorizations WHERE device_code = $1', [
            input.deviceCode,
          ]);
        }
        await client.query('COMMIT');
        return row.status === 'denied'
          ? { status: 'access_denied' }
          : { status: 'approved', record: deviceRowToRecord(row) };
      }
      if (postgresEpochSeconds(row.next_poll_at) > input.nowSeconds) {
        await client.query(
          `UPDATE oauth_device_authorizations
              SET next_poll_at = next_poll_at + (interval_seconds * interval '1 second')
            WHERE device_code = $1`,
          [input.deviceCode],
        );
        await client.query('COMMIT');
        return { status: 'slow_down' };
      }
      await client.query(
        `UPDATE oauth_device_authorizations
            SET next_poll_at = to_timestamp($2 + interval_seconds)
          WHERE device_code = $1`,
        [input.deviceCode, input.nowSeconds],
      );
      await client.query('COMMIT');
      return { status: 'authorization_pending' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeDeviceTokenIssuance(deviceCode: string, clientId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `DELETE FROM oauth_device_authorizations
        WHERE device_code = $1 AND client_id = $2 AND status = 'approved'`,
      [deviceCode, clientId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async createRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, owner_subject, owner_email, owner_locale, owner_time_zone, resource,
          scope, roles, identity_kind, identity_provider, customer_issuer, developer_grant_id,
          auth_time, upstream_expires_at, expires_at, family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
         to_timestamp($14), to_timestamp($15), to_timestamp($16), $17)`,
      [
        record.token,
        record.clientId,
        record.ownerSubject,
        record.ownerEmail ?? null,
        record.ownerLocale ?? null,
        record.ownerTimeZone ?? null,
        record.resource,
        record.scope ?? null,
        record.roles === undefined ? null : JSON.stringify(record.roles),
        record.identityKind ?? null,
        record.identityProvider ?? null,
        record.customerIssuer ?? null,
        record.developerGrantId ?? null,
        record.authTime ?? null,
        record.upstreamExpiresAt ?? null,
        record.expiresAt,
        record.familyId ?? null,
      ],
    );
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const { rows } = await this.#pool.query<RefreshRow>(
      'SELECT * FROM oauth_refresh_tokens WHERE token = $1',
      [token],
    );
    const row = rows[0];
    if (!row || !postgresTimestampIsLive(row.expires_at)) return undefined;
    return refreshRowToRecord(row);
  }

  async consumeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const { rows } = await this.#pool.query<RefreshRow>(
      'DELETE FROM oauth_refresh_tokens WHERE token = $1 RETURNING *',
      [token],
    );
    const row = rows[0];
    if (!row || !postgresTimestampIsLive(row.expires_at)) return undefined;
    return refreshRowToRecord(row);
  }

  async createConsentGrant(grant: ConsentGrantRecord): Promise<void> {
    await this.#pool.query(
      `WITH legacy_compatibility AS (
         INSERT INTO oauth_consent_grants
           (client_id, owner_subject, resource, identity_kind)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (client_id, owner_subject, resource) DO NOTHING
       )
       INSERT INTO oauth_consent_grant_provenance
         (client_id, owner_subject, resource, identity_kind)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, owner_subject, resource, identity_kind) DO NOTHING`,
      [grant.clientId, grant.ownerSubject, grant.resource, grant.identityKind],
    );
  }

  async hasConsentGrant(
    clientId: string,
    ownerSubject: string,
    resource: string,
    identityKind: ConsentGrantIdentityKind,
  ): Promise<boolean> {
    const { rows } = await this.#pool.query(
      `SELECT 1
         FROM oauth_consent_grant_provenance
        WHERE client_id = $1
          AND owner_subject = $2
          AND resource = $3
          AND identity_kind = $4
       UNION ALL
       SELECT 1
         FROM oauth_consent_grants
        WHERE client_id = $1
          AND owner_subject = $2
          AND resource = $3
          AND identity_kind = $4
        LIMIT 1`,
      [clientId, ownerSubject, resource, identityKind],
    );
    return rows.length > 0;
  }

  async putDelegatedCredential(record: DelegatedCredentialRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO oauth_delegated_credentials
         (resource, provider, subject, credential, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (resource, provider, subject)
       DO UPDATE SET credential = EXCLUDED.credential, updated_at = EXCLUDED.updated_at`,
      [
        record.resource,
        record.provider,
        record.subject,
        JSON.stringify(record.credential),
        record.updatedAt,
      ],
    );
  }

  async getDelegatedCredential(
    lookup: DelegatedCredentialLookup,
  ): Promise<DelegatedCredentialRecord | undefined> {
    const { rows } = await this.#pool.query<DelegatedCredentialRow>(
      `SELECT resource, provider, subject, credential, updated_at
        FROM oauth_delegated_credentials
        WHERE resource = $1 AND provider = $2 AND subject = $3`,
      [lookup.resource, lookup.provider, lookup.subject],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      resource: row.resource,
      provider: row.provider,
      subject: row.subject,
      credential: row.credential,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /**
   * Atomic refresh-token rotation (see {@link OAuthStore.rotateRefreshToken}). The claim and the branch run
   * in one transaction: the conditional `UPDATE` is row-atomic, so two concurrent rotations of the same token
   * yield one `rotated` winner and the loser falls through to the `grace` branch once the winner commits.
   */
  async rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotation> {
    const {
      oldTokenHash,
      clientId,
      newTokenHash,
      newExpiresAt,
      graceSeconds,
      recoverySeconds,
      nowSeconds,
    } = input;
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      if (this.#platformIdentity.assertRefreshPrincipal !== undefined) {
        const status = await this.#platformIdentity.assertRefreshPrincipal(
          createModuleSqlTransaction(client),
          {
            oldTokenHash,
            clientId,
          },
        );
        if (status !== 'continue') {
          await client.query('COMMIT');
          return { status };
        }
      }
      const claimed = await client.query<RefreshRow>(
        `UPDATE oauth_refresh_tokens
            SET rotated_at = to_timestamp($2), superseded_by = $3
          WHERE token = $1 AND client_id = $4 AND rotated_at IS NULL AND expires_at > to_timestamp($5)
          RETURNING *`,
        [oldTokenHash, nowSeconds, newTokenHash, clientId, nowSeconds],
      );
      const won = claimed.rows[0];
      if (won) {
        const sanitized = await this.#sanitizeRefreshRowScope(client, won);
        await this.#insertSuccessor(client, sanitized, newTokenHash, newExpiresAt, clientId);
        await client.query('COMMIT');
        return { status: 'rotated', identity: rowIdentity(sanitized) };
      }
      // 2) Nothing claimed → classify: unknown / grace / reuse.
      const found = await client.query<RefreshRow>(
        'SELECT * FROM oauth_refresh_tokens WHERE token = $1 AND client_id = $2',
        [oldTokenHash, clientId],
      );
      const row = found.rows[0];
      // Not found, or live-but-never-rotated means the claim failed only because it is expired → unknown.
      if (!row || row.rotated_at === null) {
        await client.query('COMMIT');
        return { status: 'unknown' };
      }
      if (nowSeconds - postgresEpochSeconds(row.rotated_at) <= graceSeconds) {
        const sanitized = await this.#sanitizeRefreshRowScope(client, row);
        await this.#insertSuccessor(client, sanitized, newTokenHash, newExpiresAt, clientId);
        await client.query('COMMIT');
        return { status: 'grace', identity: rowIdentity(sanitized) };
      }
      if (
        nowSeconds - postgresEpochSeconds(row.rotated_at) <= recoverySeconds &&
        row.superseded_by !== null
      ) {
        const successor = await client.query<RefreshRow>(
          `SELECT * FROM oauth_refresh_tokens
            WHERE token = $1 AND client_id = $2 AND rotated_at IS NULL AND expires_at > to_timestamp($3)
            FOR UPDATE`,
          [row.superseded_by, clientId, nowSeconds],
        );
        const abandoned = successor.rows[0];
        if (abandoned && sameFamily(row, abandoned)) {
          const sanitized = await this.#sanitizeRefreshRowScope(client, row);
          await client.query('DELETE FROM oauth_refresh_tokens WHERE token = $1', [
            abandoned.token,
          ]);
          await client.query(
            'UPDATE oauth_refresh_tokens SET superseded_by = $2 WHERE token = $1',
            [oldTokenHash, newTokenHash],
          );
          await this.#insertSuccessor(client, sanitized, newTokenHash, newExpiresAt, clientId);
          await client.query('COMMIT');
          return { status: 'recovered', identity: rowIdentity(sanitized) };
        }
      }
      // Out-of-window reuse → revoke the whole family (or just this token if it predates families).
      if (row.family_id !== null) {
        await client.query('DELETE FROM oauth_refresh_tokens WHERE family_id = $1', [
          row.family_id,
        ]);
      } else {
        await client.query('DELETE FROM oauth_refresh_tokens WHERE token = $1', [oldTokenHash]);
      }
      await client.query('COMMIT');
      return { status: 'reuse' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async #sanitizeRefreshRowScope(client: PoolClient, old: RefreshRow): Promise<RefreshRow> {
    const scope = publicOAuthScope(old.scope ?? undefined) ?? null;
    if (scope === old.scope) return old;
    await client.query('UPDATE oauth_refresh_tokens SET scope = $2 WHERE token = $1', [
      old.token,
      scope,
    ]);
    return { ...old, scope };
  }

  async #insertSuccessor(
    client: PoolClient,
    old: RefreshRow,
    newTokenHash: string,
    newExpiresAt: number,
    clientId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO oauth_refresh_tokens
         (token, client_id, owner_subject, owner_email, owner_locale, owner_time_zone, resource,
          scope, roles, identity_kind, identity_provider, customer_issuer, developer_grant_id,
          auth_time, upstream_expires_at, expires_at, family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14,
         $15, to_timestamp($16), $17)`,
      [
        newTokenHash,
        clientId,
        old.owner_subject,
        old.owner_email,
        old.owner_locale,
        old.owner_time_zone,
        old.resource,
        old.scope,
        old.roles === null ? null : JSON.stringify(old.roles),
        old.identity_kind,
        old.identity_provider,
        old.customer_issuer,
        old.developer_grant_id,
        old.auth_time,
        old.upstream_expires_at,
        newExpiresAt,
        old.family_id,
      ],
    );
  }
}
