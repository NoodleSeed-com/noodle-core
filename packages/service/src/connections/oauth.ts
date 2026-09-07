import { createHash } from 'node:crypto';
import { guardedFetch } from '@noodle-borg/connector-http';
import * as oauth from 'oauth4webapi';
import { ConnectionError, type ConnectionTokens, type PendingConnection } from './types.js';

/** Deployment registration only. Never compiled into an application artifact or exposed by Portal. */
export interface ConnectionProvider {
  readonly id: string;
  readonly label: string;
  readonly server: oauth.AuthorizationServer;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly authorizationParameters?: Readonly<Record<string, string>>;
}
export type ConnectionFetch = (url: URL, init: RequestInit) => Promise<Response>;
const TOKEN_LIMIT = 16_384;
const RESPONSE_LIMIT = 64 * 1024;

export function providerDigest(provider: ConnectionProvider): string {
  validateProvider(provider);
  return createHash('sha256')
    .update(
      JSON.stringify([
        provider.id,
        provider.server.issuer,
        provider.server.authorization_endpoint,
        provider.server.token_endpoint,
        provider.server.jwks_uri,
        provider.server.revocation_endpoint,
        provider.server.authorization_response_iss_parameter_supported,
        provider.clientId,
        provider.redirectUri,
        [...provider.scopes].sort(),
        [...provider.allowedOrigins].sort(),
      ]),
    )
    .digest('hex');
}
export function validateProvider(provider: ConnectionProvider): void {
  if (
    !provider.scopes.includes('openid') ||
    provider.scopes.length > 100 ||
    !provider.clientId ||
    !provider.clientSecret ||
    !provider.server.jwks_uri ||
    !provider.server.authorization_endpoint ||
    !provider.server.token_endpoint
  )
    throw new ConnectionError('connection_invalid');
  for (const value of [
    provider.server.issuer,
    provider.server.authorization_endpoint,
    provider.server.token_endpoint,
    provider.server.jwks_uri,
    provider.server.revocation_endpoint,
  ].filter((item) => item !== undefined)) {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !provider.allowedOrigins.includes(url.origin)
    )
      throw new ConnectionError('connection_invalid');
  }
  for (const scope of provider.scopes)
    if (!/^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/.test(scope))
      throw new ConnectionError('connection_invalid');
  const redirect = new URL(provider.redirectUri);
  if (
    (redirect.protocol !== 'https:' &&
      !(
        redirect.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
      )) ||
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    redirect.search
  )
    throw new ConnectionError('connection_invalid');
}
function client(provider: ConnectionProvider): oauth.Client {
  return { client_id: provider.clientId };
}
function requestOptions(provider: ConnectionProvider, transport?: ConnectionFetch) {
  return {
    [oauth.customFetch]: async (
      input: string,
      init: oauth.CustomFetchOptions<string, URLSearchParams | undefined>,
    ) => {
      const url = new URL(input);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !provider.allowedOrigins.includes(url.origin)
      )
        throw new ConnectionError('connection_denied');
      const response = await (transport ?? guardedFetch)(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
      if (response.status >= 300 && response.status < 400)
        throw new ConnectionError('connection_unavailable');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > RESPONSE_LIMIT) throw new ConnectionError('connection_unavailable');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: response.headers,
      });
    },
  };
}
export async function authorizationUrl(
  provider: ConnectionProvider,
  state: string,
  verifier: string,
  nonce: string,
): Promise<string> {
  validateProvider(provider);
  const url = new URL(provider.server.authorization_endpoint ?? '');
  for (const [key, value] of Object.entries(provider.authorizationParameters ?? {})) {
    if (!['access_type', 'prompt', 'include_granted_scopes'].includes(key))
      throw new ConnectionError('connection_invalid');
    url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    scope: provider.scopes.join(' '),
    state,
    nonce,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  }))
    url.searchParams.set(key, value);
  return url.href;
}
function tokens(
  result: oauth.TokenEndpointResponse,
  provider: ConnectionProvider,
  subject: string,
  now: number,
  previousRefresh?: string,
): ConnectionTokens {
  const scopes = (result.scope ?? provider.scopes.join(' ')).split(' ').filter(Boolean);
  const refreshToken = result.refresh_token ?? previousRefresh;
  if (
    result.token_type.toLowerCase() !== 'bearer' ||
    !refreshToken ||
    refreshToken.length > TOKEN_LIMIT ||
    result.access_token.length > TOKEN_LIMIT ||
    /[\r\n]/.test(result.access_token) ||
    typeof result.expires_in !== 'number' ||
    result.expires_in <= 0 ||
    result.expires_in > 86_400 ||
    scopes.some((scope) => !provider.scopes.includes(scope)) ||
    !provider.scopes.every((scope) => scopes.includes(scope))
  )
    throw new ConnectionError('connection_unavailable');
  return {
    subject,
    accessToken: result.access_token,
    refreshToken,
    scopes: [...new Set(scopes)].sort(),
    expiresAt: now + result.expires_in * 1000,
  };
}
export async function exchangeCode(
  provider: ConnectionProvider,
  pending: PendingConnection,
  code: string,
  state: string,
  now: number,
  transport?: ConnectionFetch,
  previous?: ConnectionTokens,
  iss?: string,
): Promise<ConnectionTokens> {
  const options = requestOptions(provider, transport);
  const params = oauth.validateAuthResponse(
    provider.server,
    client(provider),
    new URLSearchParams({ code, state, ...(iss === undefined ? {} : { iss }) }),
    state,
  );
  const response = await oauth.authorizationCodeGrantRequest(
    provider.server,
    client(provider),
    oauth.ClientSecretPost(provider.clientSecret),
    params,
    provider.redirectUri,
    pending.verifier,
    options,
  );
  const result = await oauth.processAuthorizationCodeResponse(
    provider.server,
    client(provider),
    response,
    { expectedNonce: pending.nonce, requireIdToken: true },
  );
  await oauth.validateApplicationLevelSignature(provider.server, response, options);
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!claims?.sub || claims.sub.length > 1024) throw new ConnectionError('connection_unavailable');
  return tokens(
    result,
    provider,
    claims.sub,
    now,
    previous?.subject === claims.sub ? previous.refreshToken : undefined,
  );
}
export async function refreshTokens(
  provider: ConnectionProvider,
  previous: ConnectionTokens,
  now: number,
  transport?: ConnectionFetch,
): Promise<ConnectionTokens> {
  const options = requestOptions(provider, transport);
  const response = await oauth.refreshTokenGrantRequest(
    provider.server,
    client(provider),
    oauth.ClientSecretPost(provider.clientSecret),
    previous.refreshToken,
    options,
  );
  const result = await oauth.processRefreshTokenResponse(
    provider.server,
    client(provider),
    response,
  );
  if (result.id_token !== undefined) {
    await oauth.validateApplicationLevelSignature(provider.server, response, options);
    if (oauth.getValidatedIdTokenClaims(result)?.sub !== previous.subject)
      throw new ConnectionError('connection_unavailable');
  }
  return tokens(result, provider, previous.subject, now, previous.refreshToken);
}
export async function revokeToken(
  provider: ConnectionProvider,
  refreshToken: string,
  transport?: ConnectionFetch,
): Promise<void> {
  if (!provider.server.revocation_endpoint) return;
  const response = await oauth.revocationRequest(
    provider.server,
    client(provider),
    oauth.ClientSecretPost(provider.clientSecret),
    refreshToken,
    requestOptions(provider, transport),
  );
  await oauth.processRevocationResponse(response);
}
