import type { JWTPayload } from 'jose';

import { hasCanonicalOAuthIdentityPreferences } from './identity-preferences.js';

/** Signed, short-lived context carried from an upstream-human callback to the consent decision. */
export interface ConsentClaims {
  readonly kind: 'consent';
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly ownerSubject: string;
  readonly clientState?: string;
  readonly ownerEmail?: string;
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
  readonly scope?: string;
  readonly authTime?: number;
  readonly upstreamProvider?: 'google' | 'workos';
}

export interface DeveloperGrantClaims extends Omit<ConsentClaims, 'kind'> {
  readonly kind: 'developer-grant';
}

export function isConsentClaims(payload: JWTPayload): payload is JWTPayload & ConsentClaims {
  return (
    (payload as { kind?: unknown }).kind === 'consent' &&
    typeof (payload as { clientId?: unknown }).clientId === 'string' &&
    typeof (payload as { redirectUri?: unknown }).redirectUri === 'string' &&
    typeof (payload as { codeChallenge?: unknown }).codeChallenge === 'string' &&
    typeof (payload as { resource?: unknown }).resource === 'string' &&
    typeof (payload as { ownerSubject?: unknown }).ownerSubject === 'string' &&
    validUpstreamProvider(payload.upstreamProvider) &&
    validAuthenticationTime(payload.authTime) &&
    hasCanonicalOAuthIdentityPreferences({
      locale: payload.ownerLocale,
      timeZone: payload.ownerTimeZone,
    })
  );
}

export function isDeveloperGrantClaims(
  payload: JWTPayload,
): payload is JWTPayload & DeveloperGrantClaims {
  return (
    (payload as { kind?: unknown }).kind === 'developer-grant' &&
    typeof (payload as { clientId?: unknown }).clientId === 'string' &&
    typeof (payload as { redirectUri?: unknown }).redirectUri === 'string' &&
    typeof (payload as { codeChallenge?: unknown }).codeChallenge === 'string' &&
    typeof (payload as { resource?: unknown }).resource === 'string' &&
    typeof (payload as { ownerSubject?: unknown }).ownerSubject === 'string' &&
    validUpstreamProvider(payload.upstreamProvider) &&
    validAuthenticationTime(payload.authTime) &&
    hasCanonicalOAuthIdentityPreferences({
      locale: payload.ownerLocale,
      timeZone: payload.ownerTimeZone,
    })
  );
}

function validUpstreamProvider(value: unknown): boolean {
  return value === undefined || value === 'google' || value === 'workos';
}

function validAuthenticationTime(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= Math.floor(Date.now() / 1_000))
  );
}
