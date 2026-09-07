import type { HttpAuthScheme } from '@noodle-borg/connector-http';
import type { SecretBinding } from './compile.js';
import type { ConnectorCompileError } from './compile-expr.js';
import { addMicrosoftDelegatedOAuthBinding } from './microsoft-delegated-auth.js';
import type { HttpAuthDef } from './schema.js';

/**
 * Strip a declarative auth def down to the runtime `HttpAuthScheme` the connector applies — dropping the
 * `secret` *reference*. The reference lives only in the {@link SecretBinding} table; the runtime scheme
 * carries the shape (bearer / api-key header), and the broker supplies the token at invoke time.
 */
export function toAuthScheme(auth: HttpAuthDef): HttpAuthScheme {
  if (auth.kind === 'apiKey') return { kind: 'apiKey', header: auth.header };
  if (auth.kind === 'delegatedSessionCookie') return { kind: 'cookie' };
  return { kind: 'bearer' };
}

export function addAuthBinding(input: {
  readonly auth: HttpAuthDef | undefined;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation?: string;
  readonly customerEndpoint?: string;
  readonly path: string;
  readonly allowedOrigins: readonly string[];
  readonly independentTokenOrigin?: boolean;
  readonly secretBindings: SecretBinding[];
  readonly errors: ConnectorCompileError[];
}): void {
  if (input.auth === undefined) return;
  if (input.auth.kind === 'delegatedOAuth') {
    if (input.auth.provider === 'microsoft') {
      addMicrosoftDelegatedOAuthBinding({
        auth: input.auth,
        connectorId: input.connectorId,
        connectorVersion: input.connectorVersion,
        ...(input.operation !== undefined ? { operation: input.operation } : {}),
        path: input.path,
        allowedOrigins: input.allowedOrigins,
        secretBindings: input.secretBindings,
        errors: input.errors,
      });
      return;
    }
    if (input.auth.provider !== 'firebase') {
      input.errors.push({
        code: 'unsupported_delegated_provider',
        path: `${input.path}.provider`,
        message:
          `delegatedOAuth provider "${input.auth.provider}" is not a managed provider (firebase, microsoft); ` +
          'use auth.kind delegatedTokenExchange for a customer-owned token endpoint (ADR 0152)',
      });
      return;
    }
    input.secretBindings.push({
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      authKind: 'delegatedOAuth',
      delegated: { provider: input.auth.provider },
    });
    return;
  }
  if (input.auth.kind === 'delegatedTokenExchange') {
    if (input.independentTokenOrigin !== true) {
      const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
      const tokenOrigin = new URL(input.auth.tokenUrl).origin;
      if (!allowed.has(tokenOrigin)) {
        input.errors.push({
          code: 'disallowed_token_origin',
          path: `${input.path}.tokenUrl`,
          message: `Delegated token exchange URL origin "${tokenOrigin}" is not in http.allowedOrigins`,
        });
        return;
      }
    }
    input.secretBindings.push({
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      ...(input.customerEndpoint !== undefined ? { customerEndpoint: input.customerEndpoint } : {}),
      secretRef: input.auth.clientSecret,
      authKind: 'delegatedTokenExchange',
      tokenExchange: {
        tokenUrl: input.auth.tokenUrl,
        clientId: input.auth.clientId,
        ...(input.auth.scopes !== undefined ? { scopes: input.auth.scopes } : {}),
        ...(input.auth.audience !== undefined ? { audience: input.auth.audience } : {}),
        authMethod: input.auth.authMethod ?? 'client_secret_basic',
      },
    });
    return;
  }
  if (input.auth.kind === 'delegatedSessionCookie') {
    const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
    const sessionOrigin = new URL(input.auth.sessionUrl).origin;
    if (!allowed.has(sessionOrigin)) {
      input.errors.push({
        code: 'disallowed_session_origin',
        path: `${input.path}.sessionUrl`,
        message: `Delegated session URL origin "${sessionOrigin}" is not in http.allowedOrigins`,
      });
      return;
    }
    input.secretBindings.push({
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      authKind: 'delegatedSessionCookie',
      delegated: {
        provider: input.auth.provider,
        sessionUrl: input.auth.sessionUrl,
        tokenField: input.auth.tokenField ?? 'idToken',
      },
    });
    return;
  }
  if (input.auth.kind === 'clientCredentials') {
    const allowed = new Set(input.allowedOrigins.map((origin) => new URL(origin).origin));
    const tokenOrigin = new URL(input.auth.tokenUrl).origin;
    if (!allowed.has(tokenOrigin)) {
      input.errors.push({
        code: 'disallowed_token_origin',
        path: `${input.path}.tokenUrl`,
        message: `Client-credentials token URL origin "${tokenOrigin}" is not in http.allowedOrigins`,
      });
      return;
    }
    input.secretBindings.push({
      connectorId: input.connectorId,
      connectorVersion: input.connectorVersion,
      ...(input.operation !== undefined ? { operation: input.operation } : {}),
      secretRef: input.auth.clientSecret,
      authKind: 'clientCredentials',
      clientCredentials: {
        profile: input.auth.profile,
        tokenUrl: input.auth.tokenUrl,
        clientId: input.auth.clientId,
        ...(input.auth.scopes !== undefined ? { scopes: input.auth.scopes } : {}),
        ...(input.auth.audience !== undefined ? { audience: input.auth.audience } : {}),
        ...(input.auth.profile === 'oauth2'
          ? { authMethod: input.auth.authMethod ?? 'client_secret_basic' }
          : {}),
        ...(input.auth.custom !== undefined ? { custom: input.auth.custom } : {}),
      },
    });
    return;
  }
  input.secretBindings.push({
    connectorId: input.connectorId,
    connectorVersion: input.connectorVersion,
    ...(input.operation !== undefined ? { operation: input.operation } : {}),
    secretRef: input.auth.secret,
  });
}
