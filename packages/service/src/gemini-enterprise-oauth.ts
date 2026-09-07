// Extracted verbatim from serve.ts (size-gate split): Gemini Enterprise OAuth default-resource shim.
const GEMINI_ENTERPRISE_REDIRECT_URIS = [
  'https://vertexaisearch.cloud.google.com/oauth-redirect',
  'https://vertexaisearch.cloud.google.com/static/oauth/oauth.html',
] as const;

/**
 * Gemini Enterprise's custom MCP setup has historically omitted RFC 8707 `resource` on OAuth requests.
 * Keep ordinary OAuth clients resource-mandatory: accept a default only for Gemini's known redirect shape
 * and only when the registered client name carries the explicit HTTPS MCP resource URL.
 */
export function geminiEnterpriseDefaultResourceForClient(
  client: {
    readonly client_name?: string | undefined;
    readonly redirect_uris?: readonly string[] | undefined;
  },
  issuer: string,
): string | undefined {
  if (!isGeminiEnterpriseOAuthClient(client)) return undefined;
  const resource = resourceUrlFromClientName(client.client_name);
  if (resource === undefined) return undefined;
  const normalizedIssuer = issuer.replace(/\/+$/, '');
  return resource.origin === normalizedIssuer && resource.pathname.endsWith('/mcp')
    ? resource.href
    : undefined;
}

function isGeminiEnterpriseOAuthClient(client: {
  readonly redirect_uris?: readonly string[] | undefined;
}): boolean {
  return (
    Array.isArray(client.redirect_uris) &&
    GEMINI_ENTERPRISE_REDIRECT_URIS.every((uri) => client.redirect_uris?.includes(uri))
  );
}

function resourceUrlFromClientName(clientName: string | undefined): URL | undefined {
  if (clientName === undefined) return undefined;
  const match = /https:\/\/[^\s]+/.exec(clientName);
  if (match === null) return undefined;
  try {
    return new URL(match[0]);
  } catch {
    return undefined;
  }
}
