import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DeviceAuthorizationRecord, DeviceBrowserSessionRecord } from './device-store.js';
import { storedOAuthOwnerPreferences } from './identity-preferences.js';
import type { OAuthStore } from './store.js';
import type { OAuthTokenIssuer } from './token-issuer.js';
import { hashToken } from './tokens.js';

export async function completeDeviceAuthorization(input: {
  readonly store: OAuthStore;
  readonly issuer: string;
  readonly session: DeviceBrowserSessionRecord;
  readonly authorizationCode: string;
}): Promise<boolean> {
  const record = await input.store.redeemAuthorizationCode(hashToken(input.authorizationCode));
  if (
    record === undefined ||
    record.clientId !== input.session.clientId ||
    record.redirectUri !== `${input.issuer.replace(/\/+$/, '')}/oauth/device/callback` ||
    record.resource !== input.session.resource ||
    record.codeChallenge !== input.session.codeChallenge
  ) {
    return false;
  }
  return input.store.approveDeviceAuthorization(input.session.deviceCode, {
    ownerSubject: record.ownerSubject,
    ...(record.ownerEmail !== undefined ? { ownerEmail: record.ownerEmail } : {}),
    ...storedOAuthOwnerPreferences({
      locale: record.ownerLocale,
      timeZone: record.ownerTimeZone,
    }),
    ...(record.identityKind !== undefined ? { identityKind: record.identityKind } : {}),
    ...(record.identityProvider !== undefined ? { identityProvider: record.identityProvider } : {}),
    ...(record.customerIssuer !== undefined ? { customerIssuer: record.customerIssuer } : {}),
    ...(record.developerGrantId !== undefined ? { developerGrantId: record.developerGrantId } : {}),
  });
}

export function issueDeviceTokens(input: {
  readonly tokenIssuer: OAuthTokenIssuer;
  readonly record: DeviceAuthorizationRecord;
}): Promise<OAuthTokens> {
  const record = input.record;
  if (record.ownerSubject === undefined) {
    throw new InvalidGrantError('device authorization is missing an approved identity');
  }
  return input.tokenIssuer.issueTokens({
    clientId: record.clientId,
    ownerSubject: record.ownerSubject,
    resource: record.resource,
    ...(record.ownerEmail !== undefined ? { ownerEmail: record.ownerEmail } : {}),
    ...storedOAuthOwnerPreferences({
      locale: record.ownerLocale,
      timeZone: record.ownerTimeZone,
    }),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    ...(record.identityKind !== undefined ? { identityKind: record.identityKind } : {}),
    ...(record.identityProvider !== undefined ? { identityProvider: record.identityProvider } : {}),
    ...(record.customerIssuer !== undefined ? { customerIssuer: record.customerIssuer } : {}),
    ...(record.developerGrantId !== undefined ? { developerGrantId: record.developerGrantId } : {}),
  });
}
