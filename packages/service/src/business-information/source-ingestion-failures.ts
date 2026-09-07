const AUTHORIZATION_LOSS_CODES = new Set([
  'credential_unavailable',
  'source_authorization_lost',
  'authentication_required',
  'authorization_required',
  'unauthorized',
  'forbidden',
  'invalid_grant',
  'invalid_token',
  'access_denied',
  'access_revoked',
  'upstream_authentication_lost',
]);

export function normalizeSourceFailureCode(code: string): string {
  return AUTHORIZATION_LOSS_CODES.has(code) ? 'source_authorization_lost' : code;
}

export function sourceFailureHealth(errorCode: string): 'failed' | 'reauth_required' {
  return normalizeSourceFailureCode(errorCode) === 'source_authorization_lost'
    ? 'reauth_required'
    : 'failed';
}

export function sourceErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z0-9_]{1,80}$/.test(error.code)
  ) {
    return normalizeSourceFailureCode(error.code);
  }
  return 'source_scan_failed';
}
