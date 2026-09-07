import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';

/** RFC 8414 metadata with the Noodle device-flow and canonical issuer additions. */
export function noodleOAuthMetadata(
  provider: OAuthServerProvider,
  issuer: string,
  deviceGrant: string,
  oauthClientCredentialsReady = false,
  tokenExchangeReady = false,
): Record<string, unknown> {
  const base = createOAuthMetadata({ provider, issuerUrl: new URL(issuer) });
  // The SDK emits `issuer` as `URL.href`, which appends a trailing slash for a path-less origin
  // (`https://h` → `https://h/`). RFC 8414 §3.3 requires the metadata `issuer` to be identical to the
  // issuer used to build the well-known URL, and our token `iss` + the PRM `authorization_servers` entry
  // use the no-slash form — so normalize it back for consistency across all three.
  const grants = Array.isArray(base.grant_types_supported)
    ? base.grant_types_supported
    : ['authorization_code', 'refresh_token'];
  const tokenAuthMethods = Array.isArray(base.token_endpoint_auth_methods_supported)
    ? base.token_endpoint_auth_methods_supported
    : ['client_secret_post', 'none'];
  return {
    ...base,
    issuer,
    authorization_response_iss_parameter_supported: true,
    grant_types_supported: [
      ...new Set([
        ...grants,
        deviceGrant,
        ...(oauthClientCredentialsReady ? ['client_credentials'] : []),
        ...(tokenExchangeReady ? ['urn:ietf:params:oauth:grant-type:token-exchange'] : []),
      ]),
    ],
    ...(oauthClientCredentialsReady
      ? {
          token_endpoint_auth_methods_supported: [
            ...new Set([...tokenAuthMethods, 'private_key_jwt', 'client_secret_basic']),
          ],
          token_endpoint_auth_signing_alg_values_supported: ['RS256', 'ES256'],
        }
      : {}),
    device_authorization_endpoint: `${issuer}/device_authorization`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
  };
}
