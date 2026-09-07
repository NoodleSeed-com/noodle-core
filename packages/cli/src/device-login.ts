import { presentUrl, type UrlOpener } from './browser.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceAuthorizationMetadata {
  readonly registrationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
}

export interface DeviceLoginToken {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

/** Discover RFC 8628. Missing/older metadata means the caller may use its existing PKCE flow. */
export async function discoverDeviceAuthorization(input: {
  readonly issuer: string;
  readonly fetchImpl: typeof fetch;
}): Promise<DeviceAuthorizationMetadata | undefined> {
  let response: Response;
  try {
    response = await input.fetchImpl(
      `${normalizeIssuer(input.issuer)}/.well-known/oauth-authorization-server`,
      { headers: { accept: 'application/json' } },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OAuth authorization-server metadata discovery failed: ${detail}`);
  }
  if (!response.ok) {
    throw new Error(`OAuth authorization-server metadata discovery failed (${response.status})`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.device_authorization_endpoint !== 'string') return undefined;
  if (
    Array.isArray(body.grant_types_supported) &&
    !body.grant_types_supported.includes(DEVICE_GRANT)
  ) {
    throw new Error('OAuth metadata advertises a device endpoint without the device grant type');
  }
  if (
    typeof body.issuer !== 'string' ||
    normalizeIssuer(body.issuer) !== normalizeIssuer(input.issuer) ||
    typeof body.registration_endpoint !== 'string' ||
    typeof body.token_endpoint !== 'string'
  ) {
    throw new Error('OAuth device metadata is incomplete or does not match the configured issuer');
  }
  const issuerOrigin = new URL(normalizeIssuer(input.issuer)).origin;
  const endpoints = [
    body.registration_endpoint,
    body.token_endpoint,
    body.device_authorization_endpoint,
  ];
  if (endpoints.some((endpoint) => new URL(endpoint).origin !== issuerOrigin)) {
    throw new Error('OAuth device endpoints must use the configured authorization-server origin');
  }
  return {
    registrationEndpoint: body.registration_endpoint,
    tokenEndpoint: body.token_endpoint,
    deviceAuthorizationEndpoint: body.device_authorization_endpoint,
  };
}

/** Register, present the copyable code/link, and poll entirely over outbound HTTPS. */
export async function deviceOAuthLogin(input: {
  readonly issuer: string;
  readonly resource: string;
  readonly metadata: DeviceAuthorizationMetadata;
  readonly fetchImpl: typeof fetch;
  readonly openBrowser?: UrlOpener;
  readonly print?: (line: string) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}): Promise<DeviceLoginToken> {
  const print = input.print ?? console.log;
  const clientId = await registerClient(input);
  const started = await beginDeviceAuthorization(input, clientId);
  print('Sign in to Noodle Seed');
  print(`Code ${started.userCode}`);
  await presentUrl(started.verificationUriComplete ?? started.verificationUri, {
    ...(input.openBrowser !== undefined ? { open: input.openBrowser } : {}),
    print,
  });
  print('Waiting for sign-in…');
  return pollForTokens(input, clientId, started);
}

async function registerClient(input: {
  readonly issuer: string;
  readonly metadata: DeviceAuthorizationMetadata;
  readonly fetchImpl: typeof fetch;
}): Promise<string> {
  const response = await input.fetchImpl(input.metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Noodle CLI',
      application_type: 'native',
      redirect_uris: [`${normalizeIssuer(input.issuer)}/oauth/device/callback`],
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_GRANT, 'authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const body = (await response.json()) as { client_id?: unknown; error?: unknown };
  if (!response.ok || typeof body.client_id !== 'string') {
    throw new Error(oauthError(body, `OAuth client registration failed (${response.status})`));
  }
  return body.client_id;
}

interface StartedDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
}

async function beginDeviceAuthorization(
  input: {
    readonly resource: string;
    readonly metadata: DeviceAuthorizationMetadata;
    readonly fetchImpl: typeof fetch;
  },
  clientId: string,
): Promise<StartedDeviceAuthorization> {
  const response = await input.fetchImpl(input.metadata.deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      resource: input.resource,
      scope: 'openid email',
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (
    !response.ok ||
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    typeof body.verification_uri !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    throw new Error(oauthError(body, `Device authorization failed (${response.status})`));
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    ...(typeof body.verification_uri_complete === 'string'
      ? { verificationUriComplete: body.verification_uri_complete }
      : {}),
    expiresIn: body.expires_in,
    interval: typeof body.interval === 'number' && body.interval >= 0 ? body.interval : 5,
  };
}

async function pollForTokens(
  input: {
    readonly resource: string;
    readonly metadata: DeviceAuthorizationMetadata;
    readonly fetchImpl: typeof fetch;
    readonly wait?: (milliseconds: number) => Promise<void>;
    readonly now?: () => number;
  },
  clientId: string,
  started: StartedDeviceAuthorization,
): Promise<DeviceLoginToken> {
  const wait =
    input.wait ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = input.now ?? Date.now;
  const deadline = now() + started.expiresIn * 1000;
  let interval = started.interval;
  while (now() <= deadline) {
    await wait(interval * 1000);
    let response: Response;
    try {
      response = await input.fetchImpl(input.metadata.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: started.deviceCode,
          client_id: clientId,
          resource: input.resource,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      interval = Math.min(Math.max(interval, 5) * 2, 60);
      continue;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (
      response.ok &&
      typeof body.access_token === 'string' &&
      typeof body.refresh_token === 'string'
    ) {
      return {
        clientId,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
      };
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(oauthError(body, `OAuth device token exchange failed (${response.status})`));
  }
  throw new Error('Device authorization expired; run noodle login again');
}

function oauthError(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error_description === 'string') return body.error_description;
  if (typeof body.error === 'string') return body.error;
  return fallback;
}

function normalizeIssuer(value: string): string {
  return value.replace(/\/+$/, '');
}
