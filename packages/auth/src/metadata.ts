/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728), the document an MCP client fetches after a `401` to
 * discover which authorization server(s) protect a resource. The shape mirrors the MCP authorization spec
 * (`2025-11-25`) and the official SDK's `OAuthProtectedResourceMetadata`; re-verify against the live spec
 * before relying on optional fields (see `docs/references/mcp-source-notes.md`).
 */
export interface ProtectedResourceMetadata {
  /** Canonical resource identifier — the tenant MCP endpoint URL the token must be audience-bound to. */
  readonly resource: string;
  /** Authorization servers that can issue tokens for this resource (the Noodle self-hosted AS, OA-2). */
  readonly authorization_servers?: readonly string[];
  /** How the bearer token may be presented. Noodle accepts the `Authorization` header only. */
  readonly bearer_methods_supported?: readonly string[];
  /** Deterministic union of OAuth scopes used by protected operations on this resource. */
  readonly scopes_supported?: readonly string[];
}

/** Build the protected-resource-metadata document for one resource. */
export function protectedResourceMetadata(input: {
  readonly resource: string;
  readonly authorizationServers?: readonly string[];
  readonly scopesSupported?: readonly string[];
}): ProtectedResourceMetadata {
  return {
    resource: input.resource,
    ...(input.authorizationServers && input.authorizationServers.length > 0
      ? { authorization_servers: input.authorizationServers }
      : {}),
    ...(input.scopesSupported && input.scopesSupported.length > 0
      ? { scopes_supported: input.scopesSupported }
      : {}),
    bearer_methods_supported: ['header'],
  };
}

/**
 * Construct the RFC 9728 protected-resource-metadata URL for a resource URL: the well-known prefix is
 * inserted **before** the resource path (e.g. `https://h/o/a/b/mcp` →
 * `https://h/.well-known/oauth-protected-resource/o/a/b/mcp`). Mirrors the MCP SDK's
 * `getOAuthProtectedResourceMetadataUrl`.
 */
export function protectedResourceMetadataUrl(resource: string | URL): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}
