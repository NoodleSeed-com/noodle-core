import type { ConnectorCompileError } from './compile-expr.js';

/**
 * Coerce an evaluated header map into `Record<string, string>`. `evalMap` already omits keys whose
 * expression resolved to `undefined` (so optional headers self-omit); here we stringify the rest and
 * drop `null`. Header *names* that would collide with transport-critical fields are dropped so a
 * mapping can never break the SSRF/transport invariants.
 */
const PROTECTED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
]);

const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

export function validateHeaderNames(
  headers: Record<string, unknown> | undefined,
  path: string,
  errors: ConnectorCompileError[],
): void {
  if (headers === undefined) return;
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (!CREDENTIAL_HEADER_NAMES.has(lower)) continue;
    errors.push({
      code: 'credential_header_not_allowed',
      path: `${path}.${name}`,
      message: `Per-operation header "${name}" is credential-bearing; use connector auth instead`,
    });
  }
}

export function toHeaderRecord(map: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    if (value === null || value === undefined) continue;
    const lower = name.toLowerCase();
    if (PROTECTED_HEADER_NAMES.has(lower)) continue;
    // Emit lowercase names so the merge in connector-http (`{ ...opHeaders, ...authHeaders }`)
    // is an exact-key override: the auth scheme and static defaults are already lowercase, so a
    // per-op `Authorization` must normalize to `authorization` for `auth` to win. Otherwise the
    // two casings survive as separate object keys and `new Headers()` combines them into one
    // comma-joined value (WHATWG Fetch), silently defeating the ADR 0134 precedence guarantee.
    out[lower] = typeof value === 'string' ? value : String(value);
  }
  return out;
}
