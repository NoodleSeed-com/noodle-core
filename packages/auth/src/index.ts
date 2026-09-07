/**
 * `@noodle-borg/auth` — end-user OAuth primitives for the runtime as an OAuth resource server.
 *
 * OA-1 ships the resource-server half: a `jose`-based access-token verifier (ADR 0023) and the
 * protected-resource-metadata helpers an MCP client uses for discovery. OA-2 ([ADR 0042]) adds the
 * authorization-server's Express-free crypto core: signing-key custody + access-token minting. The
 * Express-typed `OAuthServerProvider` shell and Google-federation routes live in `packages/service` so this
 * package stays Express-free.
 */

export {
  type AuthorizationClaimMap,
  canonicalizeAuthorizationClaimValues,
  MAX_AUTHORIZATION_CLAIM_VALUES,
  MAX_ROLE_LENGTH,
  MAX_SCOPE_LENGTH,
  projectCustomerRoutingClaims,
  projectMappedAuthorizationClaim,
  projectNoodleRoles,
  projectStandardScopes,
} from './claims.js';
export {
  CONTROL_PLANE_EXCHANGE_AUDIENCE,
  CONTROL_PLANE_EXCHANGE_GRANT_TYPE,
  type ControlPlaneExchangeAuditEvent,
  type ControlPlaneExchangeConfig,
  type ControlPlaneExchangeDecision,
  type ControlPlaneExchangeDeps,
  type ControlPlaneExchangeRequest,
  type ControlPlaneExchangeTenantRef,
  decideControlPlaneTokenExchange,
  InMemoryTokenExchangeJtiStore,
  type TokenExchangeJtiStore,
} from './control-plane-token-exchange.js';
export {
  type DiscoveredIssuerMetadata,
  discoverIssuerMetadata,
  type IssuerMetadataCandidate,
  type IssuerMetadataKind,
  issuerMetadataCandidates,
} from './discovery.js';
export { type AccessTokenClaims, mintAccessToken } from './jwt-issuer.js';
export {
  type BearerChallenge,
  canonicalScopes,
  McpOAuthClient,
  type McpOAuthClientOptions,
  type McpOAuthClientRegistration,
  type McpOAuthDiscovery,
  type McpOAuthPendingAuthorization,
  type McpOAuthTokens,
  parseBearerChallenge,
} from './mcp-oauth-client.js';
export {
  type ProtectedResourceMetadata,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from './metadata.js';
export {
  classifyStoredOAuthRedirectPolicy,
  matchOAuthAuthorizationRedirect,
  type NormalizedOAuthRedirectClientMetadata,
  normalizeOAuthClientMetadata,
  type OAuthApplicationType,
  type OAuthRedirectClientMetadata,
  type OAuthRedirectMatchResult,
  OAuthRedirectPolicyError,
  type OAuthRedirectPolicyErrorReason,
  type OAuthTokenEndpointAuthMethod,
  type StoredRedirectPolicyClass,
} from './oauth-client-redirect-policy.js';
export {
  createStaticSigningKeyProvider,
  type SigningKey,
  type SigningKeyProvider,
  type StaticSigningKeyOptions,
} from './signer.js';
export {
  createJwtVerifier,
  type JwtVerifierConfig,
  type TokenVerifier,
  type VerifiedIdentity,
  type VerifiedServicePrincipalBinding,
  type VerifiedTokenEnvelope,
} from './verify.js';
