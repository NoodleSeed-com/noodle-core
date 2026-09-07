import type { DelegatedOAuthBinding, SecretBinding } from '@noodle-borg/connector-defs';
import type { CredentialRequest, DownstreamCredential } from '@noodle-borg/runtime';

export function requireFirebaseCaller(
  request: CredentialRequest,
  provider: string,
): NonNullable<CredentialRequest['caller']> & { readonly audience: string } {
  const caller = request.caller;
  if (
    caller === undefined ||
    caller.identityKind !== 'customer' ||
    caller.identityProvider !== provider ||
    caller.audience === undefined
  ) {
    throw new Error('delegated credential requires a matching customer caller');
  }
  return caller as NonNullable<CredentialRequest['caller']> & { readonly audience: string };
}

export function requireFirebaseProvider(provider: string | undefined): void {
  if (provider === undefined || provider !== 'firebase') {
    throw new Error('unsupported delegated credential provider');
  }
}

export type MicrosoftDelegatedBinding = DelegatedOAuthBinding & {
  readonly provider: 'microsoft';
  readonly tokenUrl: string;
  readonly clientId: string;
};

export function requireMicrosoftDelegatedBinding(
  binding: SecretBinding,
): MicrosoftDelegatedBinding {
  const delegated = binding.delegated;
  if (
    delegated?.provider !== 'microsoft' ||
    delegated.tokenUrl === undefined ||
    delegated.clientId === undefined
  ) {
    throw new Error('Microsoft delegated OAuth is not configured');
  }
  return delegated as MicrosoftDelegatedBinding;
}

export function requireMicrosoftCaller(
  request: CredentialRequest,
): NonNullable<CredentialRequest['caller']> & { readonly audience: string } {
  const caller = request.caller;
  if (
    caller === undefined ||
    caller.identityProvider !== 'microsoft' ||
    caller.audience === undefined
  ) {
    throw new Error('delegated Microsoft credential requires a matching Microsoft caller');
  }
  return caller as NonNullable<CredentialRequest['caller']> & { readonly audience: string };
}

export interface FirebaseRefreshResult {
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export interface MicrosoftRefreshResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
}

export async function fetchFirebaseRefreshToken(input: {
  readonly apiKey: string;
  readonly refreshToken: string;
  readonly fetchImpl: typeof fetch;
}): Promise<FirebaseRefreshResult> {
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', input.refreshToken);
  const response = await input.fetchImpl(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(input.apiKey)}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'noodle-borg/0.0',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`Firebase refresh failed with status ${response.status}`);
  const json = (await response.json()) as {
    id_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
    throw new Error('Firebase refresh response did not include id_token');
  }
  if (typeof json.refresh_token !== 'string' || json.refresh_token.length === 0) {
    throw new Error('Firebase refresh response did not include refresh_token');
  }
  const expiresIn =
    typeof json.expires_in === 'string'
      ? Number.parseInt(json.expires_in, 10)
      : typeof json.expires_in === 'number'
        ? json.expires_in
        : 3600;
  return {
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
  };
}

export async function fetchMicrosoftRefreshToken(input: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[] | undefined;
  readonly authMethod: 'client_secret_basic' | 'client_secret_post';
  readonly fetchImpl: typeof fetch;
}): Promise<MicrosoftRefreshResult> {
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', input.refreshToken);
  if (input.scopes !== undefined && input.scopes.length > 0) {
    params.set('scope', input.scopes.join(' '));
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'noodle-borg/0.0',
  };
  if (input.authMethod === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`;
  } else {
    params.set('client_id', input.clientId);
    params.set('client_secret', input.clientSecret);
  }

  const response = await input.fetchImpl(input.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Microsoft refresh failed with status ${response.status}`);
  const json = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('Microsoft refresh response did not include access_token');
  }
  const refreshToken =
    typeof json.refresh_token === 'string' && json.refresh_token.length > 0
      ? json.refresh_token
      : undefined;
  const expiresIn =
    typeof json.expires_in === 'string'
      ? Number.parseInt(json.expires_in, 10)
      : typeof json.expires_in === 'number'
        ? json.expires_in
        : 3600;
  return {
    accessToken: json.access_token,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
  };
}

export async function exchangeFirebaseTokenForSessionCookie(input: {
  readonly sessionUrl: string;
  readonly tokenField: string;
  readonly idToken: string;
  readonly fetchImpl: typeof fetch;
  readonly now: number;
}): Promise<DownstreamCredential> {
  const response = await input.fetchImpl(input.sessionUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'noodle-borg/0.0',
    },
    body: JSON.stringify({ [input.tokenField]: input.idToken }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`delegated session endpoint failed with status ${response.status}`);
  const cookies = extractSetCookieHeaders(response.headers);
  const cookie = cookies.map(cookiePair).filter(Boolean).join('; ');
  if (cookie.length === 0) throw new Error('delegated session endpoint did not return a cookie');
  const expiresAt = cookieExpiry(cookies, input.now);
  return {
    kind: 'cookie',
    cookie,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function extractSetCookieHeaders(headers: Headers): string[] {
  const maybeHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const values = maybeHeaders.getSetCookie?.();
  if (values !== undefined && values.length > 0) return values;
  const single = headers.get('set-cookie');
  return single === null ? [] : [single];
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]?.trim() ?? '';
}

function cookieExpiry(setCookies: readonly string[], now: number): number | undefined {
  const expiries = setCookies
    .map((value) => maxAgeExpiry(value, now))
    .filter((value): value is number => value !== undefined);
  if (expiries.length === 0) return undefined;
  return Math.min(...expiries);
}

function maxAgeExpiry(setCookie: string, now: number): number | undefined {
  const match = /(?:^|;)\s*max-age=(\d+)/i.exec(setCookie);
  if (match === null) return undefined;
  const seconds = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return now + seconds * 1000;
}
