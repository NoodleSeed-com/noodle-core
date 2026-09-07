import { type IssuerMetadataCandidate, issuerMetadataCandidates } from '@noodle-borg/auth';

const MAX_JSON_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

export interface AuthDoctorCheck {
  readonly code: string;
  readonly level: 'PASS' | 'WARN' | 'FAIL';
  readonly name: string;
  readonly issuer?: string;
  readonly message: string;
  readonly fix?: string;
}

export async function oidcMetadataChecks(issuer: string): Promise<AuthDoctorCheck[]> {
  const primary = issuerMetadataCandidates(issuer)[0];
  if (primary === undefined) return [metadataFailure(issuer, 'no issuer metadata candidate')];
  const loaded = await loadStrictHostMetadata(primary, issuer);
  if (!loaded.ok) return [loaded.check];

  const metadata = loaded.metadata;
  const issuerMatches = metadata.issuer === issuer;
  const checks: AuthDoctorCheck[] = [
    pass(
      'oauth_metadata_discovery',
      'MCP host discovery',
      issuer,
      `RFC 8414 authorization-server metadata (${safeUrl(primary.url)})`,
    ),
    issuerMatches
      ? pass('oauth_issuer_match', 'Issuer metadata', issuer, 'issuer matches exactly')
      : fail(
          'oauth_issuer_match',
          'Issuer metadata',
          issuer,
          'configured issuer and metadata issuer do not match exactly',
          'Publish the exact configured issuer value in the RFC 8414 metadata response.',
        ),
    endpointCheck(
      metadata,
      'authorization_endpoint',
      'oauth_authorization_endpoint',
      'Authorization endpoint',
      issuer,
      'Publish an HTTPS authorization_endpoint in RFC 8414 metadata.',
    ),
    endpointCheck(
      metadata,
      'token_endpoint',
      'oauth_token_endpoint',
      'Token endpoint',
      issuer,
      'Publish an HTTPS token_endpoint in RFC 8414 metadata.',
    ),
    endpointCheck(
      metadata,
      'registration_endpoint',
      'oauth_registration_endpoint',
      'Dynamic client registration',
      issuer,
      'Publish an HTTPS RFC 7591 registration_endpoint so remote MCP clients can register a public OAuth client.',
    ),
    supportedValueCheck(
      metadata,
      'response_types_supported',
      'code',
      'oauth_response_type_code',
      'Authorization code flow',
      issuer,
      'Advertise "code" in response_types_supported.',
    ),
    supportedValueCheck(
      metadata,
      'grant_types_supported',
      'authorization_code',
      'oauth_authorization_code',
      'Authorization code grant',
      issuer,
      'Advertise "authorization_code" in grant_types_supported.',
    ),
    supportedValueCheck(
      metadata,
      'grant_types_supported',
      'refresh_token',
      'oauth_refresh_token',
      'Refresh token grant',
      issuer,
      'Advertise and implement "refresh_token" in grant_types_supported.',
    ),
    supportedValueCheck(
      metadata,
      'code_challenge_methods_supported',
      'S256',
      'oauth_pkce_s256',
      'PKCE',
      issuer,
      'Advertise and require "S256" in code_challenge_methods_supported.',
    ),
    supportedValueCheck(
      metadata,
      'token_endpoint_auth_methods_supported',
      'none',
      'oauth_public_client',
      'Public OAuth clients',
      issuer,
      'Advertise and accept "none" in token_endpoint_auth_methods_supported for PKCE public clients.',
    ),
  ];

  // Do not follow a JWKS URL supplied by metadata that does not belong to the configured issuer.
  if (!issuerMatches) return checks;

  const jwksUri = httpsEndpoint(metadata.jwks_uri);
  if (jwksUri === undefined) {
    checks.push(
      fail(
        'oauth_jwks',
        'JWKS',
        issuer,
        'missing or invalid HTTPS jwks_uri',
        'Publish an HTTPS jwks_uri and a public JSON Web Key Set in issuer metadata.',
      ),
    );
    return checks;
  }
  checks.push(await jwksCheck(jwksUri, issuer));
  return checks;
}

async function loadStrictHostMetadata(
  candidate: IssuerMetadataCandidate,
  issuer: string,
): Promise<
  | { readonly ok: true; readonly metadata: Record<string, unknown> }
  | { readonly ok: false; readonly check: AuthDoctorCheck }
> {
  let response: Response;
  try {
    response = await fetch(candidate.url, requestInit());
  } catch (error) {
    return {
      ok: false,
      check: hostFailure(issuer, candidate.url, safeErrorMessage(error, 'metadata request failed')),
    };
  }
  if (response.status !== 200) {
    const location = safeRedirectLocation(response.headers.get('location'), candidate.url);
    await cancelResponseBody(response);
    return {
      ok: false,
      check: hostFailure(
        issuer,
        candidate.url,
        `HTTP ${response.status}${location === undefined ? '' : ` → ${location}`}`,
      ),
    };
  }
  const parsed = await readJsonObject(response);
  if (!parsed.ok) {
    return { ok: false, check: hostFailure(issuer, candidate.url, parsed.reason) };
  }
  return { ok: true, metadata: parsed.value };
}

async function jwksCheck(jwksUri: string, issuer: string): Promise<AuthDoctorCheck> {
  let response: Response;
  try {
    response = await fetch(jwksUri, requestInit());
  } catch (error) {
    return fail(
      'oauth_jwks',
      'JWKS',
      issuer,
      safeErrorMessage(error, 'JWKS request failed'),
      'Make the public JWKS endpoint directly reachable as HTTP 200 JSON.',
    );
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    return fail(
      'oauth_jwks',
      'JWKS',
      issuer,
      `${safeUrl(jwksUri)}: HTTP ${response.status}`,
      'Make the public JWKS endpoint directly reachable as HTTP 200 JSON.',
    );
  }
  const parsed = await readJsonObject(response);
  if (!parsed.ok) {
    return fail(
      'oauth_jwks',
      'JWKS',
      issuer,
      `${safeUrl(jwksUri)}: ${parsed.reason}`,
      'Return a bounded JSON Web Key Set with at least one public signing key.',
    );
  }
  const keys = Array.isArray(parsed.value.keys) ? parsed.value.keys : [];
  const publicKeys = keys.filter(isPublicJwk);
  if (publicKeys.length === 0) {
    return fail(
      'oauth_jwks',
      'JWKS',
      issuer,
      `${safeUrl(jwksUri)}: no valid public signing keys`,
      'Publish at least one public RSA, EC, or OKP signing key; never publish private key material.',
    );
  }
  return pass(
    'oauth_jwks',
    'JWKS',
    issuer,
    `${safeUrl(jwksUri)} (${publicKeys.length} public signing key${publicKeys.length === 1 ? '' : 's'})`,
  );
}

function endpointCheck(
  metadata: Record<string, unknown>,
  field: string,
  code: string,
  name: string,
  issuer: string,
  fix: string,
): AuthDoctorCheck {
  const endpoint = httpsEndpoint(metadata[field]);
  return endpoint === undefined
    ? fail(code, name, issuer, `missing or invalid HTTPS ${field}`, fix)
    : pass(code, name, issuer, safeUrl(endpoint));
}

function supportedValueCheck(
  metadata: Record<string, unknown>,
  field: string,
  required: string,
  code: string,
  name: string,
  issuer: string,
  fix: string,
): AuthDoctorCheck {
  const values = Array.isArray(metadata[field])
    ? metadata[field].filter((value): value is string => typeof value === 'string')
    : [];
  return values.includes(required)
    ? pass(code, name, issuer, `${field} includes "${required}"`)
    : fail(code, name, issuer, `${field} does not include "${required}"`, fix);
}

async function readJsonObject(
  response: Response,
): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string }
> {
  const contentLength = response.headers.get('content-length');
  const declaredLength = contentLength === null ? undefined : Number(contentLength);
  if (
    declaredLength !== undefined &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_JSON_BYTES
  ) {
    await cancelResponseBody(response);
    return { ok: false, reason: `JSON response exceeds ${MAX_JSON_BYTES} bytes` };
  }
  const loaded = await readBoundedText(response);
  if (!loaded.ok) return loaded;
  let value: unknown;
  try {
    value = JSON.parse(loaded.text);
  } catch {
    return { ok: false, reason: 'response is not valid JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'JSON response must be an object' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

async function readBoundedText(
  response: Response,
): Promise<
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }
> {
  if (response.body === null) return { ok: true, text: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: `JSON response exceeds ${MAX_JSON_BYTES} bytes` };
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { ok: true, text: chunks.join('') };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: 'could not read JSON response' };
  } finally {
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isPublicJwk(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((field) => field in key)) return false;
  if (key.use !== undefined && key.use !== 'sig') return false;
  if (
    key.key_ops !== undefined &&
    (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))
  ) {
    return false;
  }
  if (key.kty === 'RSA') return validRsaPublicKey(key.n, key.e);
  if (key.kty === 'EC') {
    const coordinateBytes =
      key.crv === 'P-256' ? 32 : key.crv === 'P-384' ? 48 : key.crv === 'P-521' ? 66 : undefined;
    return (
      coordinateBytes !== undefined &&
      base64UrlBytes(key.x)?.byteLength === coordinateBytes &&
      base64UrlBytes(key.y)?.byteLength === coordinateBytes
    );
  }
  if (key.kty === 'OKP') {
    const coordinateBytes = key.crv === 'Ed25519' ? 32 : key.crv === 'Ed448' ? 57 : undefined;
    return coordinateBytes !== undefined && base64UrlBytes(key.x)?.byteLength === coordinateBytes;
  }
  return false;
}

function validRsaPublicKey(modulusValue: unknown, exponentValue: unknown): boolean {
  const modulus = base64UrlBytes(modulusValue);
  const exponent = base64UrlBytes(exponentValue);
  if (modulus === undefined || exponent === undefined || exponent.byteLength > 8) return false;
  if (modulus.byteLength < 256) return false;
  if (modulus.byteLength === 256 && (modulus[0] ?? 0) < 0x80) return false;
  if (((modulus.at(-1) ?? 0) & 1) === 0) return false;
  let exponentNumber = 0n;
  for (const byte of exponent) exponentNumber = (exponentNumber << 8n) | BigInt(byte);
  return exponentNumber >= 3n && (exponentNumber & 1n) === 1n;
}

function base64UrlBytes(value: unknown): Uint8Array | undefined {
  if (!nonEmpty(value) || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength > 0 && decoded.toString('base64url') === value ? decoded : undefined;
}

function httpsEndpoint(value: unknown): string | undefined {
  if (!nonEmpty(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requestInit(): RequestInit {
  return {
    headers: { accept: 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
}

function pass(code: string, name: string, issuer: string, message: string): AuthDoctorCheck {
  return { code, level: 'PASS', name, issuer: authDiagnosticUrl(issuer), message };
}

function fail(
  code: string,
  name: string,
  issuer: string,
  message: string,
  fix: string,
): AuthDoctorCheck {
  return { code, level: 'FAIL', name, issuer: authDiagnosticUrl(issuer), message, fix };
}

function metadataFailure(issuer: string, message: string): AuthDoctorCheck {
  return hostFailure(issuer, issuer, message);
}

function hostFailure(issuer: string, url: string, reason: string): AuthDoctorCheck {
  return fail(
    'oauth_metadata_discovery',
    'MCP host discovery',
    issuer,
    `${safeUrl(url)}: ${reason}`,
    'Serve this path-inserted RFC 8414 metadata URL directly as HTTP 200 JSON without redirecting to login.',
  );
}

function safeRedirectLocation(location: string | null, base: string): string | undefined {
  if (location === null) return undefined;
  try {
    return safeUrl(new URL(location, base).toString());
  } catch {
    return undefined;
  }
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const hadCredentials = parsed.username.length > 0 || parsed.password.length > 0;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const sanitized = parsed.toString();
    const firstSensitiveDelimiter = value.search(/[?#]/u);
    const originalWithoutQuery =
      firstSensitiveDelimiter === -1 ? value : value.slice(0, firstSensitiveDelimiter);
    return !hadCredentials && sanitized === `${originalWithoutQuery}/`
      ? originalWithoutQuery
      : sanitized;
  } catch {
    return 'invalid URL';
  }
}

export function authDiagnosticUrl(value: string): string {
  return safeUrl(value);
}

/** Render a URL or conservative opaque OAuth audience without exposing query-like authored data. */
export function authDiagnosticAudience(value: string): string {
  const url = safeUrl(value);
  if (url !== 'invalid URL') return url;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/u.test(value) ? value : 'opaque audience configured';
}

function safeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutUrls = message.replace(/https?:\/\/\S+/gu, '[URL]');
  return withoutUrls.trim().slice(0, 240) || fallback;
}
