import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  canonicalScopes,
  type McpOAuthClientRegistration,
  type McpOAuthDiscovery,
  type McpOAuthPendingAuthorization,
  type McpOAuthTokens,
} from '@noodle-borg/auth';
import { decodeJwt } from 'jose';
import { microsoftCallbackError, microsoftTokenError } from './devtools-microsoft-errors.js';

export { MicrosoftDevtoolsAuthError } from './devtools-microsoft-errors.js';

const MICROSOFT_CALLBACK_PATH = '/auth/callback/microsoft';
const MICROSOFT_REQUIRED_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;
const MAX_TOKEN_RESPONSE_BYTES = 256 * 1_024;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

export interface DevtoolsMicrosoftAuthConfig {
  readonly kind: 'microsoft';
  readonly tenantId: string;
  readonly clientId: string;
  /** Resolved only inside the loopback Node host; never serialized to the browser. */
  readonly clientSecret: string;
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
  readonly scopes?: readonly string[];
  readonly authMethod?: 'client_secret_basic' | 'client_secret_post';
  /** Opaque local-only revision used to clear credentials when auth configuration changes. */
  readonly configurationKey?: string;
  /** Test/self-host seam. Production authorization endpoints must use HTTPS. */
  readonly allowInsecureLocalhost?: boolean;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

/**
 * Confidential Microsoft authorization-code client for the loopback Devtools host. The Graph access
 * token and client secret never cross into the browser; the ID token is retained as the local MCP bearer
 * and is independently signature/issuer/audience verified by the loopback service before tool access.
 */
export class MicrosoftDevtoolsAuthDriver {
  readonly #auth: DevtoolsMicrosoftAuthConfig;
  readonly #resource: string;
  readonly #redirectUri: string;
  readonly #issuer: string;
  readonly #authorizationEndpoint: string;
  readonly #tokenEndpoint: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #stateFactory: () => string;
  readonly #codeVerifierFactory: () => string;
  readonly #nonceFactory: () => string;
  readonly #pendingNonces = new Map<string, string>();

  constructor(options: {
    readonly auth: DevtoolsMicrosoftAuthConfig;
    readonly resource: string;
    readonly redirectUri: string;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => number;
    readonly stateFactory?: () => string;
    readonly codeVerifierFactory?: () => string;
    readonly nonceFactory?: () => string;
  }) {
    this.#auth = validateAuth(options.auth);
    this.#resource = validateResource(options.resource);
    this.#redirectUri = validateMicrosoftRedirect(options.redirectUri);
    this.#issuer = microsoftIssuer(this.#auth.tenantId);
    this.#authorizationEndpoint = validateEndpoint(
      this.#auth.authorizeUrl ?? microsoftAuthorizeUrl(this.#auth.tenantId),
      'Microsoft authorization endpoint',
      this.#auth.allowInsecureLocalhost === true,
    );
    this.#tokenEndpoint = validateEndpoint(
      this.#auth.tokenUrl ?? microsoftTokenUrl(this.#auth.tenantId),
      'Microsoft token endpoint',
      this.#auth.allowInsecureLocalhost === true,
    );
    this.#fetch = options.fetchFn ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#stateFactory = options.stateFactory ?? (() => randomBytes(32).toString('base64url'));
    this.#codeVerifierFactory =
      options.codeVerifierFactory ?? (() => randomBytes(32).toString('base64url'));
    this.#nonceFactory = options.nonceFactory ?? (() => randomBytes(32).toString('base64url'));
  }

  async discover(): Promise<McpOAuthDiscovery> {
    return {
      resource: this.#resource,
      issuer: this.#issuer,
      authorizationEndpoint: this.#authorizationEndpoint,
      tokenEndpoint: this.#tokenEndpoint,
      // Microsoft clients are pre-registered in Entra; this sentinel is never fetched.
      registrationEndpoint: 'urn:noodleseed:devtools:microsoft:pre-registered',
      scopes: microsoftScopes(this.#auth.scopes),
      authorizationResponseIssuerRequired: false,
    };
  }

  async register(
    discovery: McpOAuthDiscovery,
    _scopes: readonly string[] = discovery.scopes,
  ): Promise<McpOAuthClientRegistration> {
    this.#assertDiscovery(discovery);
    // The shared OAuth shape models public DCR. This driver owns confidential client authentication
    // internally, so no registration or secret is returned through this value.
    return { clientId: this.#auth.clientId, tokenEndpointAuthMethod: 'none' };
  }

  beginAuthorization(
    discovery: McpOAuthDiscovery,
    registration: McpOAuthClientRegistration,
    scopes: readonly string[] = discovery.scopes,
  ): McpOAuthPendingAuthorization {
    this.#assertDiscovery(discovery);
    this.#assertRegistration(registration);
    const state = this.#stateFactory();
    const codeVerifier = this.#codeVerifierFactory();
    const nonce = this.#nonceFactory();
    assertEntropyValue(state, 'state');
    assertEntropyValue(codeVerifier, 'PKCE verifier');
    assertEntropyValue(nonce, 'nonce');
    const selectedScopes = microsoftScopes(scopes);
    const authorizationUrl = new URL(this.#authorizationEndpoint);
    authorizationUrl.searchParams.set('client_id', this.#auth.clientId);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('response_mode', 'query');
    authorizationUrl.searchParams.set('redirect_uri', this.#redirectUri);
    authorizationUrl.searchParams.set('scope', selectedScopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set(
      'code_challenge',
      createHash('sha256').update(codeVerifier).digest('base64url'),
    );
    this.#pendingNonces.clear();
    this.#pendingNonces.set(state, nonce);
    return {
      authorizationUrl: authorizationUrl.href,
      state,
      codeVerifier,
      scopes: selectedScopes,
    };
  }

  async exchangeCallback(
    discovery: McpOAuthDiscovery,
    registration: McpOAuthClientRegistration,
    pending: McpOAuthPendingAuthorization,
    callbackUrl: string,
  ): Promise<McpOAuthTokens> {
    this.#assertDiscovery(discovery);
    this.#assertRegistration(registration);
    assertCallback(callbackUrl, this.#redirectUri);
    const callback = new URL(callbackUrl);
    if (!constantTimeStringEqual(callback.searchParams.get('state') ?? '', pending.state)) {
      throw new Error('Microsoft callback state is invalid');
    }
    const expectedNonce = this.#pendingNonces.get(pending.state);
    this.#pendingNonces.delete(pending.state);
    if (expectedNonce === undefined) throw new Error('Microsoft authorization request expired');
    if (callback.searchParams.has('error')) {
      throw microsoftCallbackError(callback.searchParams.get('error'));
    }
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Microsoft callback did not include an authorization code');
    return this.#requestTokens(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.codeVerifier,
        redirect_uri: this.#redirectUri,
        scope: pending.scopes.join(' '),
      }),
      pending.scopes,
      expectedNonce,
    );
  }

  async refresh(
    discoveryOrCurrent: McpOAuthDiscovery | McpOAuthTokens,
    registration?: McpOAuthClientRegistration,
    currentMaybe?: McpOAuthTokens,
  ): Promise<McpOAuthTokens> {
    const current = currentMaybe ?? (discoveryOrCurrent as McpOAuthTokens);
    if (currentMaybe !== undefined) {
      this.#assertDiscovery(discoveryOrCurrent as McpOAuthDiscovery);
      if (registration === undefined) throw new Error('Microsoft client registration is missing');
      this.#assertRegistration(registration);
    }
    if (!current.refreshToken) throw new Error('Microsoft session does not have a refresh token');
    const refreshed = await this.#requestTokens(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        scope: current.scope.join(' '),
      }),
      current.scope,
    );
    return {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
    };
  }

  async #requestTokens(
    params: URLSearchParams,
    fallbackScopes: readonly string[],
    expectedNonce?: string,
  ): Promise<McpOAuthTokens> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if ((this.#auth.authMethod ?? 'client_secret_post') === 'client_secret_basic') {
      headers.authorization = `Basic ${Buffer.from(
        `${this.#auth.clientId}:${this.#auth.clientSecret}`,
      ).toString('base64')}`;
    } else {
      params.set('client_id', this.#auth.clientId);
      params.set('client_secret', this.#auth.clientSecret);
    }
    let response: Response;
    try {
      response = await this.#fetch(this.#tokenEndpoint, {
        method: 'POST',
        headers,
        body: params.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        `Microsoft token endpoint could not be reached: ${new URL(this.#tokenEndpoint).origin}`,
      );
    }
    if (!response.ok) {
      let json: JsonObject | undefined;
      try {
        json = await readBoundedJson(response);
      } catch (error) {
        if (error instanceof Error && /too large/u.test(error.message)) throw error;
      }
      throw microsoftTokenError(response.status, json);
    }
    const json = await readBoundedJson(response);
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      throw new Error('Microsoft returned an invalid token response');
    }
    if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
      throw new Error('Microsoft token response did not include an ID token');
    }
    if (typeof json.token_type !== 'string' || json.token_type.toLowerCase() !== 'bearer') {
      throw new Error('Microsoft returned an unsupported token type');
    }
    const claims = validateIdTokenShape(
      json.id_token,
      this.#auth.clientId,
      this.#issuer,
      this.#now(),
      expectedNonce,
    );
    const responseScopes =
      typeof json.scope === 'string' ? json.scope.split(/\s+/u) : fallbackScopes;
    const expiresIn =
      typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
        ? Math.max(0, json.expires_in)
        : undefined;
    return {
      // Deliberately discard the Graph/API access token. The local MCP front door accepts only the ID
      // token, which it verifies against Microsoft's keys and this configured client ID.
      accessToken: json.id_token,
      ...(typeof json.refresh_token === 'string' && json.refresh_token.length > 0
        ? { refreshToken: json.refresh_token }
        : {}),
      tokenType: 'Bearer',
      ...(typeof claims.exp === 'number'
        ? { expiresAt: claims.exp * 1_000 }
        : expiresIn === undefined
          ? {}
          : { expiresAt: this.#now() + expiresIn * 1_000 }),
      scope: canonicalScopes(responseScopes),
    };
  }

  #assertDiscovery(discovery: McpOAuthDiscovery): void {
    if (
      discovery.resource !== this.#resource ||
      discovery.issuer !== this.#issuer ||
      discovery.authorizationEndpoint !== this.#authorizationEndpoint ||
      discovery.tokenEndpoint !== this.#tokenEndpoint
    ) {
      throw new Error('Microsoft OAuth state belongs to a different configuration');
    }
  }

  #assertRegistration(registration: McpOAuthClientRegistration): void {
    if (registration.clientId !== this.#auth.clientId) {
      throw new Error('Microsoft OAuth client does not match the configured app');
    }
  }
}

export function microsoftIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0`;
}

function microsoftAuthorizeUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
}

function microsoftTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

function microsoftScopes(scopes: readonly string[] | undefined): readonly string[] {
  return canonicalScopes([...MICROSOFT_REQUIRED_SCOPES, ...(scopes ?? [])]);
}

function validateAuth(auth: DevtoolsMicrosoftAuthConfig): DevtoolsMicrosoftAuthConfig {
  if (auth.tenantId.trim().length === 0) throw new Error('Microsoft tenant ID is required');
  if (auth.clientId.trim().length === 0) throw new Error('Microsoft client ID is required');
  if (auth.clientSecret.length === 0) throw new Error('Microsoft client secret is required');
  return auth;
}

function validateResource(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) {
    throw new Error('Microsoft MCP resource must not contain credentials or a fragment');
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) {
    return url.href;
  }
  throw new Error('Microsoft MCP resource must use HTTPS or an HTTP loopback URL');
}

function validateMicrosoftRedirect(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !isLoopback(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== MICROSOFT_CALLBACK_PATH
  ) {
    throw new Error(
      `Microsoft redirect must be an HTTP loopback URL at ${MICROSOFT_CALLBACK_PATH}`,
    );
  }
  return url.href;
}

function validateEndpoint(value: string, label: string, allowInsecureLocalhost: boolean): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  if (
    url.protocol !== 'https:' &&
    !(allowInsecureLocalhost && url.protocol === 'http:' && isLoopback(url.hostname))
  ) {
    throw new Error(`${label} must use HTTPS`);
  }
  return url.href;
}

function assertCallback(callbackValue: string, redirectValue: string): void {
  const callback = new URL(callbackValue);
  const redirect = new URL(redirectValue);
  const sameLoopbackAlias = isLoopback(callback.hostname) && isLoopback(redirect.hostname);
  if (
    callback.protocol !== redirect.protocol ||
    callback.port !== redirect.port ||
    callback.pathname !== redirect.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    (!sameLoopbackAlias && callback.hostname !== redirect.hostname)
  ) {
    throw new Error('Microsoft callback URL does not match the registered redirect');
  }
}

function validateIdTokenShape(
  idToken: string,
  clientId: string,
  issuer: string,
  nowMs: number,
  expectedNonce?: string,
) {
  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(idToken);
  } catch {
    throw new Error('Microsoft returned an invalid ID token');
  }
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!Array.isArray(audiences) || !audiences.includes(clientId)) {
    throw new Error('Microsoft ID token audience is invalid');
  }
  if (claims.iss !== issuer) {
    throw new Error('Microsoft ID token issuer is invalid');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(nowMs / 1_000)) {
    throw new Error('Microsoft ID token is expired');
  }
  if (
    expectedNonce !== undefined &&
    !constantTimeStringEqual(typeof claims.nonce === 'string' ? claims.nonce : '', expectedNonce)
  ) {
    throw new Error('Microsoft ID token nonce is invalid');
  }
  return claims;
}

async function readBoundedJson(response: Response): Promise<JsonObject> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_TOKEN_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Microsoft token response is too large');
  }
  if (response.body === null) throw new Error('Microsoft token endpoint returned invalid JSON');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Microsoft token response is too large');
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(chunks.join(''));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new Error('Microsoft token endpoint returned invalid JSON');
  }
}

function assertEntropyValue(value: string, label: string): void {
  if (value.length < 16 || !/^[A-Za-z0-9._~-]+$/u.test(value)) {
    throw new Error(`Microsoft ${label} is invalid`);
  }
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
