import { canonicalizeAuthorizationClaimValues } from '@noodle-borg/auth';
import { postgresEpochSeconds } from './postgres-time.js';
import type {
  AuthorizationCodeRecord,
  DelegatedCredentialRecord,
  PendingAuthorizationRecord,
  RefreshIdentity,
  RefreshTokenRecord,
} from './store.js';

export interface PendingRow {
  readonly state: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly client_state: string | null;
  readonly resource: string;
  readonly scope: string | null;
  readonly upstream_provider: PendingAuthorizationRecord['upstreamProvider'];
  readonly expires_at: Date;
}

export interface AuthCodeRow {
  readonly code: string;
  readonly client_id: string;
  readonly code_challenge: string;
  readonly redirect_uri: string;
  readonly resource: string;
  readonly owner_subject: string;
  readonly owner_email: string | null;
  readonly owner_locale: string | null;
  readonly owner_time_zone: string | null;
  readonly scope: string | null;
  readonly roles: unknown | null;
  readonly identity_kind: 'platform' | 'customer' | null;
  readonly identity_provider: string | null;
  readonly customer_issuer: string | null;
  readonly developer_grant_id: string | null;
  readonly auth_time: Date | null;
  readonly upstream_expires_at: Date | null;
  readonly expires_at: Date;
}

export interface RefreshRow {
  readonly token: string;
  readonly client_id: string;
  readonly owner_subject: string;
  readonly owner_email: string | null;
  readonly owner_locale: string | null;
  readonly owner_time_zone: string | null;
  readonly resource: string;
  readonly scope: string | null;
  readonly roles: unknown | null;
  readonly identity_kind: 'platform' | 'customer' | null;
  readonly identity_provider: string | null;
  readonly customer_issuer: string | null;
  readonly developer_grant_id: string | null;
  readonly auth_time: Date | null;
  readonly upstream_expires_at: Date | null;
  readonly expires_at: Date;
  readonly family_id: string | null;
  readonly rotated_at: Date | null;
  readonly superseded_by: string | null;
}

export interface DelegatedCredentialRow {
  readonly resource: string;
  readonly provider: string;
  readonly subject: string;
  readonly credential: DelegatedCredentialRecord['credential'];
  readonly updated_at: Date;
}

export function refreshRowToRecord(row: RefreshRow): RefreshTokenRecord {
  return {
    token: row.token,
    clientId: row.client_id,
    ownerSubject: row.owner_subject,
    ...(row.owner_email !== null ? { ownerEmail: row.owner_email } : {}),
    ...(row.owner_locale !== null ? { ownerLocale: row.owner_locale } : {}),
    ...(row.owner_time_zone !== null ? { ownerTimeZone: row.owner_time_zone } : {}),
    resource: row.resource,
    ...(row.scope !== null ? { scope: row.scope } : {}),
    ...(row.roles != null ? { roles: storedRoles(row.roles) } : {}),
    ...(row.identity_kind !== null ? { identityKind: row.identity_kind } : {}),
    ...(row.identity_provider !== null ? { identityProvider: row.identity_provider } : {}),
    ...(row.customer_issuer !== null ? { customerIssuer: row.customer_issuer } : {}),
    ...(row.developer_grant_id !== null ? { developerGrantId: row.developer_grant_id } : {}),
    ...(row.auth_time !== null ? { authTime: postgresEpochSeconds(row.auth_time) } : {}),
    ...(row.upstream_expires_at != null
      ? { upstreamExpiresAt: postgresEpochSeconds(row.upstream_expires_at) }
      : {}),
    expiresAt: postgresEpochSeconds(row.expires_at),
    ...(row.family_id !== null ? { familyId: row.family_id } : {}),
    ...(row.rotated_at !== null ? { rotatedAt: postgresEpochSeconds(row.rotated_at) } : {}),
    ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
  };
}

export function rowIdentity(row: RefreshRow): RefreshIdentity {
  return {
    ownerSubject: row.owner_subject,
    ...(row.owner_email !== null ? { ownerEmail: row.owner_email } : {}),
    ...(row.owner_locale !== null ? { ownerLocale: row.owner_locale } : {}),
    ...(row.owner_time_zone !== null ? { ownerTimeZone: row.owner_time_zone } : {}),
    resource: row.resource,
    ...(row.scope !== null ? { scope: row.scope } : {}),
    ...(row.roles != null ? { roles: storedRoles(row.roles) } : {}),
    ...(row.family_id !== null ? { familyId: row.family_id } : {}),
    ...(row.identity_kind !== null ? { identityKind: row.identity_kind } : {}),
    ...(row.identity_provider !== null ? { identityProvider: row.identity_provider } : {}),
    ...(row.customer_issuer !== null ? { customerIssuer: row.customer_issuer } : {}),
    ...(row.developer_grant_id !== null ? { developerGrantId: row.developer_grant_id } : {}),
    ...(row.auth_time !== null ? { authTime: postgresEpochSeconds(row.auth_time) } : {}),
    ...(row.upstream_expires_at != null
      ? { upstreamExpiresAt: postgresEpochSeconds(row.upstream_expires_at) }
      : {}),
  };
}

export function sameFamily(a: RefreshRow, b: RefreshRow): boolean {
  if (a.family_id === null || b.family_id === null) return a.token === b.token;
  return a.family_id === b.family_id;
}

export function authCodeRowToRecord(row: AuthCodeRow): AuthorizationCodeRecord {
  return {
    code: row.code,
    clientId: row.client_id,
    codeChallenge: row.code_challenge,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    ownerSubject: row.owner_subject,
    ...(row.owner_email !== null ? { ownerEmail: row.owner_email } : {}),
    ...(row.owner_locale !== null ? { ownerLocale: row.owner_locale } : {}),
    ...(row.owner_time_zone !== null ? { ownerTimeZone: row.owner_time_zone } : {}),
    ...(row.scope !== null ? { scope: row.scope } : {}),
    ...(row.roles != null ? { roles: storedRoles(row.roles) } : {}),
    ...(row.identity_kind !== null ? { identityKind: row.identity_kind } : {}),
    ...(row.identity_provider !== null ? { identityProvider: row.identity_provider } : {}),
    ...(row.customer_issuer !== null ? { customerIssuer: row.customer_issuer } : {}),
    ...(row.developer_grant_id !== null ? { developerGrantId: row.developer_grant_id } : {}),
    ...(row.auth_time !== null ? { authTime: postgresEpochSeconds(row.auth_time) } : {}),
    ...(row.upstream_expires_at != null
      ? { upstreamExpiresAt: postgresEpochSeconds(row.upstream_expires_at) }
      : {}),
    expiresAt: postgresEpochSeconds(row.expires_at),
  };
}

function storedRoles(value: unknown): readonly string[] {
  return canonicalizeAuthorizationClaimValues(value, 'role');
}
