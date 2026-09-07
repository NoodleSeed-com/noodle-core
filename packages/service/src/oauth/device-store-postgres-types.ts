import type { DeviceAuthorizationRecord, DeviceBrowserSessionRecord } from './device-store.js';

export interface DeviceAuthorizationRow {
  readonly device_code: string;
  readonly user_code: string;
  readonly client_id: string;
  readonly resource: string;
  readonly scope: string | null;
  readonly status: 'pending' | 'approved' | 'denied';
  readonly owner_subject: string | null;
  readonly owner_email: string | null;
  readonly owner_locale: string | null;
  readonly owner_time_zone: string | null;
  readonly identity_kind: 'platform' | 'customer' | null;
  readonly identity_provider: string | null;
  readonly customer_issuer: string | null;
  readonly developer_grant_id: string | null;
  readonly expires_at: Date;
  readonly next_poll_at: Date;
  readonly interval_seconds: number;
}

export interface DeviceBrowserSessionRow {
  readonly state: string;
  readonly device_code: string;
  readonly client_id: string;
  readonly resource: string;
  readonly code_challenge: string;
  readonly expires_at: Date;
}

export function deviceRowToRecord(row: DeviceAuthorizationRow): DeviceAuthorizationRecord {
  return {
    deviceCode: row.device_code,
    userCode: row.user_code,
    clientId: row.client_id,
    resource: row.resource,
    ...(row.scope !== null ? { scope: row.scope } : {}),
    status: row.status,
    ...(row.owner_subject !== null ? { ownerSubject: row.owner_subject } : {}),
    ...(row.owner_email !== null ? { ownerEmail: row.owner_email } : {}),
    ...(row.owner_locale !== null ? { ownerLocale: row.owner_locale } : {}),
    ...(row.owner_time_zone !== null ? { ownerTimeZone: row.owner_time_zone } : {}),
    ...(row.identity_kind !== null ? { identityKind: row.identity_kind } : {}),
    ...(row.identity_provider !== null ? { identityProvider: row.identity_provider } : {}),
    ...(row.customer_issuer !== null ? { customerIssuer: row.customer_issuer } : {}),
    ...(row.developer_grant_id !== null ? { developerGrantId: row.developer_grant_id } : {}),
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
    nextPollAt: Math.floor(new Date(row.next_poll_at).getTime() / 1000),
    intervalSeconds: row.interval_seconds,
  };
}

export function deviceBrowserRowToRecord(row: DeviceBrowserSessionRow): DeviceBrowserSessionRecord {
  return {
    state: row.state,
    deviceCode: row.device_code,
    clientId: row.client_id,
    resource: row.resource,
    codeChallenge: row.code_challenge,
    expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
  };
}
