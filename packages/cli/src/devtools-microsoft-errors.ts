import { DevtoolsAuthError } from './devtools-auth-types.js';

export class MicrosoftDevtoolsAuthError extends DevtoolsAuthError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'MicrosoftDevtoolsAuthError';
  }
}

export function microsoftCallbackError(error: string | null): MicrosoftDevtoolsAuthError {
  if (error === 'access_denied') {
    return new MicrosoftDevtoolsAuthError(
      'access_denied',
      'Microsoft sign-in was cancelled or denied. Start a fresh sign-in when you are ready.',
    );
  }
  return new MicrosoftDevtoolsAuthError(
    'microsoft_authorization_failed',
    'Microsoft did not authorize this sign-in. Return to Devtools and start a fresh sign-in.',
  );
}

export function microsoftTokenError(
  status: number,
  response: Readonly<Record<string, unknown>> | undefined,
): MicrosoftDevtoolsAuthError {
  const code = microsoftProviderCode(response);
  const remediation = code === undefined ? undefined : MICROSOFT_ERROR_REMEDIATION[code];
  return new MicrosoftDevtoolsAuthError(
    code ?? 'microsoft_token_exchange_failed',
    remediation ??
      `Microsoft rejected the token exchange (HTTP ${status}). Check the app registration and start a fresh sign-in.`,
  );
}

function microsoftProviderCode(
  response: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (response === undefined) return undefined;
  const firstNumeric = Array.isArray(response.error_codes)
    ? response.error_codes.find(
        (value): value is number =>
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= 9_999_999_999,
      )
    : undefined;
  if (firstNumeric !== undefined) return `AADSTS${firstNumeric}`;
  const description = response.error_description;
  if (typeof description === 'string') {
    const match = /\bAADSTS(\d{3,10})\b/u.exec(description);
    if (match?.[1] !== undefined) return `AADSTS${match[1]}`;
  }
  const standardError = response.error;
  return typeof standardError === 'string' && SAFE_OAUTH_ERROR_CODES.has(standardError)
    ? standardError
    : undefined;
}

const SAFE_OAUTH_ERROR_CODES = new Set([
  'access_denied',
  'invalid_client',
  'invalid_grant',
  'interaction_required',
  'temporarily_unavailable',
]);

const MICROSOFT_ERROR_REMEDIATION: Readonly<Record<string, string>> = {
  AADSTS50020:
    'This account is not available in the configured tenant. Use an invited tenant account or update the tenant setting.',
  AADSTS65001:
    'Microsoft requires consent for this app or scope. Grant consent, then start a fresh sign-in.',
  AADSTS700016:
    'Microsoft could not find this app registration in the configured tenant. Check the tenant ID and client ID.',
  AADSTS7000215:
    'Microsoft rejected the client secret. Create a fresh secret value for this app registration.',
  AADSTS7000222:
    'The Microsoft client secret has expired. Create and configure a fresh secret value.',
  invalid_client:
    'Microsoft rejected the app credentials. Check the client ID and client secret value.',
  invalid_grant: 'The Microsoft authorization grant is no longer valid. Start a fresh sign-in.',
  interaction_required:
    'Microsoft requires user interaction. Return to Devtools and sign in again.',
  temporarily_unavailable: 'Microsoft sign-in is temporarily unavailable. Try again shortly.',
};
