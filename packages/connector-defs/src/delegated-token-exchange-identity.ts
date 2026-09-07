import type { SecretBinding } from './compile.js';
import type { ConnectorCompileError } from './compile-expr.js';

/** Compiled server fields that can establish the verified customer caller used by token exchange. */
export interface ServerCustomerIdentitySources {
  readonly auth?: unknown;
  readonly assistant?: unknown;
}

/** Identity producers supplied by a trusted compile context rather than by the authored server. */
export interface DelegatedTokenExchangeIdentityContext {
  /** The loopback-only Devtools runtime injects and verifies the local caller used for exchange. */
  readonly localDevtoolsCustomerIdentity?: boolean;
}

/**
 * Cross-check delegated token exchange bindings against the server surface that supplies their caller.
 * The runtime still fails closed; this preflight moves an otherwise inevitable runtime failure to compile
 * and deploy boundaries. Diagnostics identify connector operations but never auth endpoints or secrets.
 */
export function delegatedTokenExchangeIdentityErrors(
  bindings: readonly SecretBinding[],
  server: ServerCustomerIdentitySources,
  context: DelegatedTokenExchangeIdentityContext = {},
): readonly ConnectorCompileError[] {
  const operations = [
    ...new Set(
      bindings
        .filter((binding) => binding.authKind === 'delegatedTokenExchange')
        .map((binding) => `${binding.connectorId}.${binding.operation ?? '*'}`),
    ),
  ].sort();
  if (
    operations.length === 0 ||
    hasIdentitySource(server) ||
    context.localDevtoolsCustomerIdentity === true
  ) {
    return [];
  }

  return [
    {
      code: 'delegated_token_exchange_identity_required',
      path: 'server.auth',
      message: `delegatedTokenExchange on ${operations.join(', ')} requires a verified customer identity source; declare server.auth with customerAuth(...) or server.assistant with embeddedAssistant(...)`,
    },
  ];
}

function hasIdentitySource(server: ServerCustomerIdentitySources): boolean {
  if (isRecord(server.auth)) return true;
  if (!isRecord(server.assistant)) return false;
  const surfaces = server.assistant.surfaces;
  // Legacy and authenticated-only shapes carry no surfaces array; stay permissive for those and
  // for shapes a newer authoring layer produced that this check cannot read.
  if (!Array.isArray(surfaces) || surfaces.length === 0) return true;
  const wellFormed = surfaces.filter(isRecord);
  if (wellFormed.length !== surfaces.length || wellFormed.length === 0) return true;
  // Declared surfaces make the claim precise: only a surface with a signed-in caller —
  // authenticated, or mixed via mid-conversation sign-in — supplies a verified customer identity.
  // A pure-public assistant never does, so declaring one must not satisfy this preflight.
  return wellFormed.some((surface) => surface.mode !== 'public');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
