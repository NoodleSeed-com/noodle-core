import type { JWTPayload } from 'jose';

export const MAX_AUTHORIZATION_CLAIM_VALUES = 128;
export const MAX_SCOPE_LENGTH = 512;
export const MAX_ROLE_LENGTH = 200;

export interface AuthorizationClaimMap {
  readonly roles?: string;
  readonly scopes?: string;
}

/** Project exact, bounded customer connector route strings into a private null-prototype map. */
export function projectCustomerRoutingClaims(
  payload: Readonly<Record<string, unknown>>,
  paths: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (paths === undefined) return undefined;
  const projected = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(paths)) {
    const value = resolveClaimPath(payload, paths[key] as string);
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      new TextEncoder().encode(value).byteLength <= 2_048
    ) {
      projected[key] = value;
    }
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}

type AuthorizationClaimKind = 'role' | 'scope';

/**
 * Project one explicitly configured nested claim into a bounded canonical set. A malformed value fails
 * closed as an empty set; mixed arrays are never partially accepted.
 */
export function projectMappedAuthorizationClaim(
  payload: Readonly<Record<string, unknown>>,
  path: string | undefined,
  kind: AuthorizationClaimKind,
): readonly string[] {
  if (path === undefined) return [];
  return canonicalAuthorizationClaimValues(resolveClaimPath(payload, path), kind, kind === 'scope');
}

/** Project the Noodle-owned private role claim used by customer-auth bridge access tokens. */
export function projectNoodleRoles(payload: Readonly<Record<string, unknown>>): readonly string[] {
  return canonicalAuthorizationClaimValues(payload.noodle_roles, 'role', false);
}

/** Project standard OAuth scope claims (`scope`, `scp`, then `scopes`) into one canonical set. */
export function projectStandardScopes(payload: JWTPayload): readonly string[] {
  const claims = payload as Readonly<Record<string, unknown>>;
  return canonicalAuthorizationClaimValues(
    claims.scope ?? claims.scp ?? claims.scopes,
    'scope',
    true,
  );
}

/** Canonicalize an already selected claim value at a trusted non-JWT boundary. */
export function canonicalizeAuthorizationClaimValues(
  raw: unknown,
  kind: AuthorizationClaimKind,
): readonly string[] {
  return canonicalAuthorizationClaimValues(raw, kind, false);
}

function resolveClaimPath(payload: Readonly<Record<string, unknown>>, path: string): unknown {
  const segments = path.split('.');
  if (segments.some((segment) => segment.length === 0)) return undefined;
  let value: unknown = payload;
  for (const segment of segments) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function canonicalAuthorizationClaimValues(
  raw: unknown,
  kind: AuthorizationClaimKind,
  splitScopeString: boolean,
): readonly string[] {
  const values =
    typeof raw === 'string'
      ? splitScopeString && kind === 'scope'
        ? raw.split(' ').filter((value) => value.length > 0)
        : [raw]
      : Array.isArray(raw) && raw.every((value): value is string => typeof value === 'string')
        ? raw
        : undefined;
  if (values === undefined || values.length > MAX_AUTHORIZATION_CLAIM_VALUES) return [];

  const canonical = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!isValidAuthorizationClaim(normalized, kind)) return [];
    canonical.add(normalized);
  }
  return [...canonical].sort();
}

function isValidAuthorizationClaim(value: string, kind: AuthorizationClaimKind): boolean {
  if (value.length === 0) return false;
  if (kind === 'scope') {
    return (
      value.length <= MAX_SCOPE_LENGTH &&
      // RFC 6749 scope-token = %x21 / %x23-5B / %x5D-7E.
      /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value)
    );
  }
  return value.length <= MAX_ROLE_LENGTH && !/\p{Cc}/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
