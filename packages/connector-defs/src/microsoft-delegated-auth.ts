import type { ConnectorCompileError, SecretBinding } from './compile.js';
import type { HttpAuthDef } from './schema.js';

export function addMicrosoftDelegatedOAuthBinding(input: {
  readonly auth: Extract<HttpAuthDef, { kind: 'delegatedOAuth' }>;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation?: string;
  readonly path: string;
  readonly allowedOrigins: readonly string[];
  readonly secretBindings: SecretBinding[];
  readonly errors: ConnectorCompileError[];
}): void {
  const { clientId, clientSecret, tokenUrl } = input.auth;
  if (tokenUrl === undefined || clientId === undefined || clientSecret === undefined) {
    input.errors.push({
      code: 'delegated_oauth_metadata_required',
      path: input.path,
      message: 'Microsoft delegated OAuth requires tokenUrl, clientId, and clientSecret',
    });
    return;
  }

  const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
  const tokenOrigin = new URL(tokenUrl).origin;
  if (!allowed.has(tokenOrigin)) {
    input.errors.push({
      code: 'disallowed_token_origin',
      path: `${input.path}.tokenUrl`,
      message: `OAuth2 token URL origin "${tokenOrigin}" is not in http.allowedOrigins`,
    });
    return;
  }

  input.secretBindings.push({
    connectorId: input.connectorId,
    connectorVersion: input.connectorVersion,
    ...(input.operation !== undefined ? { operation: input.operation } : {}),
    secretRef: clientSecret,
    authKind: 'delegatedOAuth',
    delegated: {
      provider: input.auth.provider,
      tokenUrl,
      clientId,
      ...(input.auth.scopes !== undefined ? { scopes: input.auth.scopes } : {}),
      authMethod: input.auth.authMethod ?? 'client_secret_post',
    },
  });
}
