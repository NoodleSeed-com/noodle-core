import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getAuthMetadata, type ServiceAuthMetadata } from './auth-discovery.js';
import { presentUrl, type UrlOpener } from './browser.js';
import type { ConfigLocation, NoodleConfig } from './config.js';
import { readConfig, resolveServiceUrl, writeConfig } from './config.js';
import { DEFAULT_SERVICE_URL } from './deploy.js';
import { deviceOAuthLogin, discoverDeviceAuthorization } from './device-login.js';
import { assertPluginServiceOrigin, readPluginCompatibility } from './plugin-mode/compatibility.js';

export {
  ServiceRequestError,
  serviceBinary,
  serviceJson,
} from './control-plane-request.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface LoginResult {
  readonly serviceUrl: string;
  readonly email?: string;
  readonly subject?: string;
}

export class RefreshTokenRejectedError extends Error {
  constructor() {
    super('The saved refresh token was rejected.');
    this.name = 'RefreshTokenRejectedError';
  }
}

export async function browserLogin(input: {
  readonly serviceUrl: string;
  readonly home: ConfigLocation;
  readonly resource?: string;
  readonly openBrowser?: UrlOpener;
  readonly fetchImpl?: typeof fetch;
}): Promise<LoginResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const serviceUrl = normalizeServiceUrl(input.serviceUrl);
  const metadata = await getAuthMetadata(serviceUrl, fetchImpl);
  if (metadata.authType === 'noodle-oauth-pkce' && metadata.authorizationServerIssuer) {
    return noodleOAuthLogin({
      serviceUrl,
      metadata,
      home: input.home,
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      fetchImpl,
      ...(input.openBrowser ? { openBrowser: input.openBrowser } : {}),
    });
  }
  if (!metadata.googleClientId) {
    writeConfig({ ...readConfig(input.home), serviceUrl }, input.home);
    return { serviceUrl };
  }
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const callback = await waitForCallback(state);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', metadata.googleClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  await presentUrl(authUrl.toString(), {
    ...(input.openBrowser !== undefined ? { open: input.openBrowser } : {}),
  });
  const code = await callback.code;
  const token = await exchangeCode({
    clientId: metadata.googleClientId,
    code,
    verifier,
    redirectUri,
    fetchImpl,
  });
  const identity = decodeIdentity(token.idToken);
  const config: NoodleConfig = {
    ...readConfig(input.home),
    serviceUrl,
    googleClientId: metadata.googleClientId,
    idToken: token.idToken,
    idTokenExpiresAt: expiresAt(token.expiresIn),
    ...(token.refreshToken !== undefined ? { refreshToken: token.refreshToken } : {}),
    ...(identity !== undefined ? { identity } : {}),
  };
  writeConfig(config, input.home);
  return { serviceUrl, ...(identity ?? {}) };
}

export async function resolveControlPlaneToken(input: {
  readonly serviceFlag?: string | undefined;
  readonly authFlag?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly home: ConfigLocation;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<{
  readonly serviceUrl: string;
  readonly token?: string;
  readonly config: NoodleConfig;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let config = readConfig(input.home);
  const serviceUrl = normalizeServiceUrl(
    resolveServiceUrl(input.serviceFlag, input.env, config) ?? DEFAULT_SERVICE_URL,
  );
  const compatibilityFile = input.env.NOODLE_PLUGIN_COMPATIBILITY_FILE;
  if (compatibilityFile !== undefined) {
    assertPluginServiceOrigin(readPluginCompatibility(compatibilityFile), serviceUrl);
  }
  const override = input.authFlag ?? input.env.NOODLE_AUTH_TOKEN;
  if (override !== undefined) return { serviceUrl, token: override, config };
  if (
    config.authToken !== undefined &&
    (config.authTokenExpiresAt === undefined || !isExpiring(config.authTokenExpiresAt))
  ) {
    return { serviceUrl, token: config.authToken, config };
  }
  if (
    config.oauthRefreshToken !== undefined &&
    config.oauthClientId !== undefined &&
    config.oauthIssuer !== undefined
  ) {
    const refreshed = await refreshNoodleAccessToken({
      issuer: config.oauthIssuer,
      clientId: config.oauthClientId,
      refreshToken: config.oauthRefreshToken,
      resource: config.oauthResource ?? serviceUrl,
      fetchImpl,
    });
    const identity = decodeIdentity(refreshed.accessToken);
    config = {
      ...config,
      serviceUrl,
      authToken: refreshed.accessToken,
      authTokenExpiresAt: expiresAt(refreshed.expiresIn),
      oauthRefreshToken: refreshed.refreshToken,
      ...(identity !== undefined ? { identity } : {}),
    };
    writeConfig(config, input.home);
    return { serviceUrl, token: refreshed.accessToken, config };
  }
  if (config.idToken !== undefined && !isExpiring(config.idTokenExpiresAt)) {
    return { serviceUrl, token: config.idToken, config };
  }
  if (config.refreshToken !== undefined && config.googleClientId !== undefined) {
    const refreshed = await refreshIdToken({
      clientId: config.googleClientId,
      refreshToken: config.refreshToken,
      fetchImpl,
    });
    const identity = decodeIdentity(refreshed.idToken);
    config = {
      ...config,
      serviceUrl,
      idToken: refreshed.idToken,
      idTokenExpiresAt: expiresAt(refreshed.expiresIn),
      ...(identity !== undefined ? { identity } : {}),
    };
    writeConfig(config, input.home);
    return { serviceUrl, token: refreshed.idToken, config };
  }
  return { serviceUrl, config };
}

export async function revokeNoodleToken(input: {
  readonly issuer: string;
  readonly clientId: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  const response = await (input.fetchImpl ?? fetch)(`${normalizeServiceUrl(input.issuer)}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      token: input.token,
      token_type_hint: 'access_token',
    }),
  });
  if (!response.ok) throw new Error(`OAuth token revocation failed (${response.status})`);
}

function normalizeServiceUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function isExpiring(iso: string | undefined): boolean {
  if (iso === undefined) return true;
  return Date.parse(iso) - Date.now() < 60_000;
}

function expiresAt(expiresIn: number): string {
  return new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString();
}

function decodeIdentity(idToken: string): { subject: string; email: string } | undefined {
  const parts = idToken.split('.');
  const payload = parts[1];
  if (payload === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      email?: unknown;
    };
    return typeof decoded.sub === 'string' && typeof decoded.email === 'string'
      ? { subject: decoded.sub, email: decoded.email.toLowerCase() }
      : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

async function noodleOAuthLogin(input: {
  readonly serviceUrl: string;
  readonly metadata: ServiceAuthMetadata;
  readonly home: ConfigLocation;
  readonly resource?: string;
  readonly openBrowser?: UrlOpener;
  readonly fetchImpl: typeof fetch;
}): Promise<LoginResult> {
  const issuer = normalizeServiceUrl(input.metadata.authorizationServerIssuer as string);
  const resource = validateOAuthResource(
    input.serviceUrl,
    input.resource ?? input.metadata.controlPlaneResource ?? input.serviceUrl,
  );
  const deviceMetadata = await discoverDeviceAuthorization({ issuer, fetchImpl: input.fetchImpl });
  if (deviceMetadata !== undefined) {
    const token = await deviceOAuthLogin({
      issuer,
      resource,
      metadata: deviceMetadata,
      fetchImpl: input.fetchImpl,
      ...(input.openBrowser !== undefined ? { openBrowser: input.openBrowser } : {}),
    });
    const identity = decodeIdentity(token.accessToken);
    writeConfig(
      {
        ...readConfig(input.home),
        serviceUrl: input.serviceUrl,
        authToken: token.accessToken,
        authTokenExpiresAt: expiresAt(token.expiresIn),
        oauthIssuer: issuer,
        oauthClientId: token.clientId,
        oauthRefreshToken: token.refreshToken,
        oauthResource: resource,
        ...(identity !== undefined ? { identity } : {}),
      },
      input.home,
    );
    return { serviceUrl: input.serviceUrl, ...(identity ?? {}) };
  }
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(24));
  const callback = await waitForCallback(state);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  const client = await registerNoodleOAuthClient({
    issuer,
    redirectUri,
    fetchImpl: input.fetchImpl,
  });
  const authUrl = new URL(`${issuer}/authorize`);
  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('resource', resource);
  await presentUrl(authUrl.toString(), {
    ...(input.openBrowser !== undefined ? { open: input.openBrowser } : {}),
  });
  const code = await callback.code;
  const token = await exchangeNoodleCode({
    issuer,
    clientId: client.clientId,
    code,
    verifier,
    redirectUri,
    resource,
    fetchImpl: input.fetchImpl,
  });
  const identity = decodeIdentity(token.accessToken);
  const config: NoodleConfig = {
    ...readConfig(input.home),
    serviceUrl: input.serviceUrl,
    authToken: token.accessToken,
    authTokenExpiresAt: expiresAt(token.expiresIn),
    oauthIssuer: issuer,
    oauthClientId: client.clientId,
    oauthRefreshToken: token.refreshToken,
    oauthResource: resource,
    ...(identity !== undefined ? { identity } : {}),
  };
  writeConfig(config, input.home);
  return { serviceUrl: input.serviceUrl, ...(identity ?? {}) };
}

function validateOAuthResource(serviceUrl: string, resource: string): string {
  const normalizedService = normalizeServiceUrl(serviceUrl);
  const normalizedResource = normalizeServiceUrl(resource);
  const service = new URL(normalizedService);
  const candidate = new URL(normalizedResource);
  const isControlPlane = candidate.href === service.href;
  const isDeveloperCli =
    candidate.origin === service.origin && candidate.pathname === '/developer/cli';
  if (
    candidate.username !== '' ||
    candidate.password !== '' ||
    candidate.search !== '' ||
    candidate.hash !== '' ||
    (!isControlPlane && !isDeveloperCli)
  ) {
    throw new Error('OAuth resource must be the service or its canonical /developer/cli resource');
  }
  return normalizedResource;
}

async function registerNoodleOAuthClient(input: {
  readonly issuer: string;
  readonly redirectUri: string;
  readonly fetchImpl: typeof fetch;
}): Promise<{ clientId: string }> {
  const res = await input.fetchImpl(`${input.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Noodle CLI',
      redirect_uris: [input.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const body = (await res.json()) as { client_id?: unknown; error?: unknown };
  if (!res.ok || typeof body.client_id !== 'string') {
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `OAuth client registration failed (${res.status})`,
    );
  }
  return { clientId: body.client_id };
}

async function exchangeNoodleCode(input: {
  readonly issuer: string;
  readonly clientId: string;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly fetchImpl: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
    resource: input.resource,
  });
  return parseNoodleTokenResponse(
    await input.fetchImpl(`${input.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    }),
  );
}

async function refreshNoodleAccessToken(input: {
  readonly issuer: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly resource: string;
  readonly fetchImpl: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
    resource: input.resource,
  });
  return parseNoodleTokenResponse(
    await input.fetchImpl(`${normalizeServiceUrl(input.issuer)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    }),
    true,
  );
}

async function parseNoodleTokenResponse(
  res: Response,
  refresh = false,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const body = (await res.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error_description?: unknown;
    error?: unknown;
  };
  if (!res.ok || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    if (refresh && isRejectedRefreshToken(body)) throw new RefreshTokenRejectedError();
    const message =
      typeof body.error_description === 'string'
        ? body.error_description
        : typeof body.error === 'string'
          ? body.error
          : `OAuth token exchange failed (${res.status})`;
    throw new Error(message);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
  };
}

function isRejectedRefreshToken(body: {
  readonly error_description?: unknown;
  readonly error?: unknown;
}): boolean {
  if (body.error === 'invalid_grant' || body.error === 'invalid_token') return true;
  const message =
    typeof body.error_description === 'string'
      ? body.error_description
      : typeof body.error === 'string'
        ? body.error
        : '';
  return /(?:invalid|expired).*refresh token|refresh token.*(?:invalid|expired)/i.test(message);
}

async function exchangeCode(input: {
  readonly clientId: string;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly fetchImpl: typeof fetch;
}): Promise<{ idToken: string; refreshToken?: string; expiresIn: number }> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.verifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  });
  return parseGoogleTokenResponse(
    await input.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    }),
  );
}

async function refreshIdToken(input: {
  readonly clientId: string;
  readonly refreshToken: string;
  readonly fetchImpl: typeof fetch;
}): Promise<{ idToken: string; expiresIn: number }> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
  return parseGoogleTokenResponse(
    await input.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    }),
    true,
  );
}

async function parseGoogleTokenResponse(
  res: Response,
  refresh = false,
): Promise<{ idToken: string; refreshToken?: string; expiresIn: number }> {
  const body = (await res.json()) as {
    id_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error_description?: unknown;
    error?: unknown;
  };
  if (!res.ok || typeof body.id_token !== 'string') {
    if (refresh && isRejectedRefreshToken(body)) throw new RefreshTokenRejectedError();
    const message =
      typeof body.error_description === 'string'
        ? body.error_description
        : typeof body.error === 'string'
          ? body.error
          : `Google token exchange failed (${res.status})`;
    throw new Error(message);
  }
  return {
    idToken: body.id_token,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
  };
}

async function waitForCallback(expectedState: string): Promise<{
  readonly port: number;
  readonly code: Promise<string>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const gotState = url.searchParams.get('state');
    const gotCode = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error !== null) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Login failed. You can close this tab.');
      rejectCode(new Error(error));
    } else if (gotState !== expectedState || gotCode === null) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid login callback. You can close this tab.');
      rejectCode(new Error('invalid login callback'));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Login complete. You can close this tab.');
      resolveCode(gotCode);
    }
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, code };
}
