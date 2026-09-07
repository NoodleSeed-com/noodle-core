import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { issuerMetadataCandidates } from './discovery.js';
import { protectedResourceMetadataUrl } from './metadata.js';

export interface McpOAuthClientOptions {
  readonly resource: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly fetchFn?: typeof fetch;
  readonly clientName?: string;
  /** Test/self-host seam. Production authorization servers must use HTTPS. */
  readonly allowInsecureLocalhost?: boolean;
}

export interface McpOAuthDiscovery {
  readonly resource: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
  readonly scopes: readonly string[];
  readonly authorizationResponseIssuerRequired: boolean;
}

export interface McpOAuthClientRegistration {
  readonly clientId: string;
  readonly tokenEndpointAuthMethod: 'none';
}

export interface McpOAuthPendingAuthorization {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly scopes: readonly string[];
}

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: 'Bearer';
  readonly expiresAt?: number;
  readonly scope: readonly string[];
}

export interface BearerChallenge {
  readonly error?: string;
  readonly scopes: readonly string[];
}

interface JsonObject {
  readonly [key: string]: unknown;
}

const MAX_OAUTH_JSON_BYTES = 256 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Express-free MCP OAuth client primitives. The caller owns session storage; this class keeps only immutable
 * resource/client configuration and never persists credentials.
 */
export class McpOAuthClient {
  readonly #resource: string;
  readonly #issuer: string;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;
  readonly #clientName: string;
  readonly #allowInsecureLocalhost: boolean;

  constructor(options: McpOAuthClientOptions) {
    this.#allowInsecureLocalhost = options.allowInsecureLocalhost === true;
    this.#resource = this.#validateResource(options.resource);
    this.#issuer = this.#validateIssuer(options.issuer);
    this.#redirectUri = this.#validateRedirect(options.redirectUri);
    this.#fetch = options.fetchFn ?? fetch;
    this.#clientName = options.clientName ?? 'Noodle Seed Devtools';
  }

  async discover(): Promise<McpOAuthDiscovery> {
    const protectedResource = await this.#getJson(protectedResourceMetadataUrl(this.#resource));
    if (protectedResource.resource !== this.#resource) {
      throw new Error('protected resource metadata does not match the MCP resource');
    }
    const authorizationServers = stringArray(protectedResource.authorization_servers);
    if (!authorizationServers.includes(this.#issuer)) {
      throw new Error('protected resource metadata does not advertise the configured issuer');
    }

    let firstError: Error | undefined;
    for (const candidate of issuerMetadataCandidates(this.#issuer)) {
      try {
        const metadata = await this.#getJson(candidate.url);
        if (metadata.issuer !== this.#issuer) {
          throw new Error('issuer metadata does not exactly match the configured issuer');
        }
        const authorizationEndpoint = this.#requiredEndpoint(
          metadata.authorization_endpoint,
          'authorization endpoint',
        );
        const tokenEndpoint = this.#requiredEndpoint(metadata.token_endpoint, 'token endpoint');
        const registrationEndpoint = this.#requiredEndpoint(
          metadata.registration_endpoint,
          'registration endpoint',
        );
        const responseTypes = stringArray(metadata.response_types_supported);
        if (!responseTypes.includes('code')) {
          throw new Error('authorization server does not support the authorization-code flow');
        }
        const grantTypes = stringArray(metadata.grant_types_supported);
        if (!grantTypes.includes('authorization_code') || !grantTypes.includes('refresh_token')) {
          throw new Error('authorization server does not advertise code and refresh grants');
        }
        const challengeMethods = stringArray(metadata.code_challenge_methods_supported);
        if (!challengeMethods.includes('S256')) {
          throw new Error('authorization server does not support PKCE S256');
        }
        const tokenAuthMethods = stringArray(metadata.token_endpoint_auth_methods_supported);
        if (!tokenAuthMethods.includes('none')) {
          throw new Error('authorization server does not support public OAuth clients');
        }
        return {
          resource: this.#resource,
          issuer: this.#issuer,
          authorizationEndpoint,
          tokenEndpoint,
          registrationEndpoint,
          scopes: canonicalScopes(stringArray(protectedResource.scopes_supported)),
          authorizationResponseIssuerRequired:
            metadata.authorization_response_iss_parameter_supported === true,
        };
      } catch (error) {
        firstError ??= safeError(error, 'authorization server discovery failed');
      }
    }
    throw firstError ?? new Error('authorization server discovery failed');
  }

  async register(
    discovery: McpOAuthDiscovery,
    scopes: readonly string[] = discovery.scopes,
  ): Promise<McpOAuthClientRegistration> {
    this.#assertDiscovery(discovery);
    const selectedScopes = canonicalScopes(scopes);
    const body = {
      application_type: 'native',
      client_name: this.#clientName,
      redirect_uris: [this.#redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(selectedScopes.length > 0 ? { scope: selectedScopes.join(' ') } : {}),
    };
    const response = await this.#getJson(discovery.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (typeof response.client_id !== 'string' || response.client_id.length === 0) {
      throw new Error('authorization server returned an invalid client registration');
    }
    if (response.token_endpoint_auth_method !== 'none') {
      throw new Error('authorization server did not register a public client');
    }
    const registeredRedirects = stringArray(response.redirect_uris);
    if (registeredRedirects.length > 0 && !registeredRedirects.includes(this.#redirectUri)) {
      throw new Error('authorization server registered a different callback URL');
    }
    return { clientId: response.client_id, tokenEndpointAuthMethod: 'none' };
  }

  beginAuthorization(
    discovery: McpOAuthDiscovery,
    registration: McpOAuthClientRegistration,
    scopes: readonly string[] = discovery.scopes,
  ): McpOAuthPendingAuthorization {
    this.#assertDiscovery(discovery);
    assertPublicRegistration(registration);
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const selectedScopes = canonicalScopes(scopes);
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', registration.clientId);
    authorizationUrl.searchParams.set('redirect_uri', this.#redirectUri);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set(
      'code_challenge',
      createHash('sha256').update(codeVerifier).digest('base64url'),
    );
    authorizationUrl.searchParams.set('resource', this.#resource);
    if (selectedScopes.length > 0) {
      authorizationUrl.searchParams.set('scope', selectedScopes.join(' '));
    }
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
    assertPublicRegistration(registration);
    const callback = new URL(callbackUrl);
    const expectedCallback = new URL(this.#redirectUri);
    if (
      callback.origin !== expectedCallback.origin ||
      callback.pathname !== expectedCallback.pathname
    ) {
      throw new Error('OAuth callback URL does not match the registered redirect');
    }
    if (!constantTimeStringEqual(callback.searchParams.get('state') ?? '', pending.state)) {
      throw new Error('OAuth callback state is invalid');
    }
    const responseIssuer = callback.searchParams.get('iss');
    if (
      (discovery.authorizationResponseIssuerRequired && responseIssuer === null) ||
      (responseIssuer !== null && responseIssuer !== discovery.issuer)
    ) {
      throw new Error('OAuth callback issuer is invalid');
    }
    if (callback.searchParams.has('error')) {
      throw new Error('authorization server denied the sign-in request');
    }
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('OAuth callback did not include an authorization code');
    return this.#requestTokens(
      discovery,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.codeVerifier,
        redirect_uri: this.#redirectUri,
        client_id: registration.clientId,
        resource: this.#resource,
      }),
      pending.scopes,
    );
  }

  async refresh(
    discovery: McpOAuthDiscovery,
    registration: McpOAuthClientRegistration,
    current: McpOAuthTokens,
  ): Promise<McpOAuthTokens> {
    this.#assertDiscovery(discovery);
    assertPublicRegistration(registration);
    if (!current.refreshToken) throw new Error('OAuth session does not have a refresh token');
    const refreshed = await this.#requestTokens(
      discovery,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: registration.clientId,
        resource: this.#resource,
      }),
      current.scope,
    );
    return {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
    };
  }

  async #requestTokens(
    discovery: McpOAuthDiscovery,
    body: URLSearchParams,
    fallbackScope: readonly string[],
  ): Promise<McpOAuthTokens> {
    const response = await this.#getJson(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
    if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
      throw new Error('authorization server returned an invalid token response');
    }
    if (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer') {
      throw new Error('authorization server returned an unsupported token type');
    }
    const expiresIn =
      typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)
        ? Math.max(0, response.expires_in)
        : undefined;
    const responseScopes =
      typeof response.scope === 'string' ? response.scope.split(/\s+/u) : fallbackScope;
    return {
      accessToken: response.access_token,
      ...(typeof response.refresh_token === 'string' && response.refresh_token.length > 0
        ? { refreshToken: response.refresh_token }
        : {}),
      tokenType: 'Bearer',
      ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
      scope: canonicalScopes(responseScopes),
    };
  }

  async #getJson(url: string, init?: RequestInit): Promise<JsonObject> {
    let response: Response;
    const headers = new Headers(init?.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    try {
      response = await this.#fetch(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: init?.signal ?? AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`OAuth endpoint could not be reached: ${new URL(url).origin}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OAuth endpoint returned HTTP ${response.status}: ${new URL(url).origin}`);
    }
    const text = await readBoundedText(response);
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isJsonObject(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new Error('OAuth endpoint returned invalid JSON');
    }
  }

  #requiredEndpoint(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new Error(`issuer metadata is missing ${label}`);
    return this.#validateEndpoint(value, label);
  }

  #validateResource(value: string): string {
    const url = new URL(value);
    if (url.username || url.password || url.hash) {
      throw new Error('MCP OAuth resource must not contain credentials or a fragment');
    }
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) {
      return url.href;
    }
    throw new Error('MCP OAuth resource must use HTTPS or an HTTP loopback URL');
  }

  #validateRedirect(value: string): string {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      !isLoopback(url.hostname) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error('MCP OAuth redirect must use an HTTP loopback URL');
    }
    return url.href;
  }

  #validateEndpoint(value: string, label: string): string {
    const url = new URL(value);
    if (url.username || url.password || url.hash) {
      throw new Error(`${label} must not contain credentials or a fragment`);
    }
    if (
      url.protocol !== 'https:' &&
      !(this.#allowInsecureLocalhost && url.protocol === 'http:' && isLoopback(url.hostname))
    ) {
      throw new Error(`${label} must use HTTPS`);
    }
    return url.href;
  }

  #validateIssuer(value: string): string {
    const url = new URL(value);
    this.#validateEndpoint(value, 'authorization server issuer');
    if (url.search || url.hash) {
      throw new Error('authorization server issuer must not contain a query or fragment');
    }
    // The issuer identifier is compared byte-for-byte with metadata and the callback `iss`.
    return value;
  }

  #assertDiscovery(discovery: McpOAuthDiscovery): void {
    if (discovery.resource !== this.#resource || discovery.issuer !== this.#issuer) {
      throw new Error('OAuth discovery state belongs to a different resource or issuer');
    }
  }
}

/** Parse only the challenge fields needed for reauthorization; ignore realms and metadata URLs. */
export function parseBearerChallenge(header: string | null): BearerChallenge | undefined {
  if (!header || !/^Bearer(?:\s|$)/iu.test(header)) return undefined;
  const fields = new Map<string, string>();
  const raw = header.replace(/^Bearer\s*/iu, '');
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/gu;
  for (const match of raw.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    const value = match[2]?.replace(/\\(["\\])/gu, '$1') ?? match[3];
    if (key && value !== undefined) fields.set(key, value);
  }
  const error = fields.get('error');
  return {
    ...(error !== undefined ? { error } : {}),
    scopes: canonicalScopes((fields.get('scope') ?? '').split(/\s+/u)),
  };
}

export function canonicalScopes(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function assertPublicRegistration(registration: McpOAuthClientRegistration): void {
  if (registration.clientId.length === 0 || registration.tokenEndpointAuthMethod !== 'none') {
    throw new Error('OAuth client registration is not a public client');
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OAUTH_JSON_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('OAuth JSON response is too large');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_OAUTH_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('OAuth JSON response is too large');
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

function safeError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
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
