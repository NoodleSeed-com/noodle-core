import { isAbsolute, normalize, parse } from 'node:path';

export interface SelfHostConfig {
  readonly databaseUrl: string;
  readonly secretMasterKey: string;
  readonly adminToken: string;
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly assetRoot: string;
  readonly assetIdentitySalt: string;
  readonly ownerAuth?:
    | { readonly kind: 'external'; readonly issuer: string; readonly jwksUri: string }
    | {
        readonly kind: 'google';
        readonly issuer: string;
        readonly signingKeyBase64: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly redirectUri: string;
        readonly allowedEmailDomain?: string;
      };
}

type Environment = Readonly<Record<string, string | undefined>>;

const KNOWN_NOODLE_VARIABLES = new Set([
  'NOODLE_BUILD_VERSION',
  'NOODLE_BUILD_SHA',
  'NOODLE_BUILD_TIME',
  'NOODLE_SECRET_MASTER_KEY',
  'NOODLE_SELF_HOST_ADMIN_TOKEN',
  'NOODLE_ASSET_ROOT',
  'NOODLE_ASSET_IDENTITY_SALT',
  'NOODLE_OAUTH_ISSUER',
  'NOODLE_OAUTH_JWKS_URI',
  'NOODLE_OAUTH_SIGNING_KEY_BASE64',
  'NOODLE_OAUTH_GOOGLE_CLIENT_ID',
  'NOODLE_OAUTH_GOOGLE_CLIENT_SECRET',
  'NOODLE_OAUTH_GOOGLE_REDIRECT_URI',
  'NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN',
]);

const UNSUPPORTED_PLATFORM_VARIABLES = new Set([
  'RESEND_API_KEY',
  'INSTANCE_CONNECTION_NAME',
  'DB_USER',
  'DB_NAME',
  'DB_IP_TYPE',
]);

const EXPLICIT_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const EXAMPLE_ADMIN_TOKENS = new Set([
  'example-admin-token-do-not-use-123',
  'replace-this-with-a-secure-admin-token',
  'your-admin-token-your-admin-token',
]);

export function resolveSelfHostConfig(env: Environment): SelfHostConfig {
  rejectUnsupportedNoodleVariables(env);

  const databaseUrl = required(env, 'DATABASE_URL');
  validateDatabaseUrl(databaseUrl);

  const secretMasterKey = required(env, 'NOODLE_SECRET_MASTER_KEY');
  validateMasterKey(secretMasterKey);

  const adminToken = required(env, 'NOODLE_SELF_HOST_ADMIN_TOKEN');
  assertStrongAdminToken(adminToken);

  const host = optional(env, 'HOST') ?? '0.0.0.0';
  const port = parsePort(optional(env, 'PORT') ?? '8787');
  const publicBaseUrl = normalizePublicBaseUrl(
    optional(env, 'PUBLIC_BASE_URL') ?? 'http://localhost:8787',
  );
  const assetRoot = required(env, 'NOODLE_ASSET_ROOT');
  validateAssetRoot(assetRoot);
  const assetIdentitySalt = required(env, 'NOODLE_ASSET_IDENTITY_SALT');
  validateAssetIdentitySalt(assetIdentitySalt);

  const ownerAuth = resolveOwnerAuth(env);
  return {
    databaseUrl,
    secretMasterKey,
    adminToken,
    host,
    port,
    publicBaseUrl,
    assetRoot,
    assetIdentitySalt,
    ...(ownerAuth === undefined ? {} : { ownerAuth }),
  };
}

function resolveOwnerAuth(env: Environment): SelfHostConfig['ownerAuth'] {
  const issuer = optional(env, 'NOODLE_OAUTH_ISSUER');
  const jwksUri = optional(env, 'NOODLE_OAUTH_JWKS_URI');
  const signingKeyBase64 = optional(env, 'NOODLE_OAUTH_SIGNING_KEY_BASE64');
  const clientId = optional(env, 'NOODLE_OAUTH_GOOGLE_CLIENT_ID');
  const clientSecret = optional(env, 'NOODLE_OAUTH_GOOGLE_CLIENT_SECRET');
  const redirectUri = optional(env, 'NOODLE_OAUTH_GOOGLE_REDIRECT_URI');
  const allowedEmailDomain = optional(env, 'NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN');

  const hasGoogleConfiguration = [
    signingKeyBase64,
    clientId,
    clientSecret,
    redirectUri,
    allowedEmailDomain,
  ].some((value) => value !== undefined);
  if (jwksUri !== undefined && hasGoogleConfiguration) {
    throw configurationError(
      'NOODLE_OAUTH_JWKS_URI cannot be combined with NOODLE_OAUTH_GOOGLE_CLIENT_ID, NOODLE_OAUTH_GOOGLE_CLIENT_SECRET, NOODLE_OAUTH_GOOGLE_REDIRECT_URI, or NOODLE_OAUTH_SIGNING_KEY_BASE64',
    );
  }

  if (jwksUri !== undefined || (issuer !== undefined && !hasGoogleConfiguration)) {
    const externalIssuer = required(env, 'NOODLE_OAUTH_ISSUER');
    const externalJwksUri = required(env, 'NOODLE_OAUTH_JWKS_URI');
    validateOAuthOriginUrl(externalIssuer, 'NOODLE_OAUTH_ISSUER');
    validateOAuthHttpUrl(externalJwksUri, 'NOODLE_OAUTH_JWKS_URI');
    return { kind: 'external', issuer: externalIssuer, jwksUri: externalJwksUri };
  }

  if (!hasGoogleConfiguration) return undefined;

  const googleIssuer = required(env, 'NOODLE_OAUTH_ISSUER');
  const googleSigningKeyBase64 = required(env, 'NOODLE_OAUTH_SIGNING_KEY_BASE64');
  const googleClientId = required(env, 'NOODLE_OAUTH_GOOGLE_CLIENT_ID');
  const googleClientSecret = required(env, 'NOODLE_OAUTH_GOOGLE_CLIENT_SECRET');
  const googleRedirectUri = required(env, 'NOODLE_OAUTH_GOOGLE_REDIRECT_URI');
  validateOAuthOriginUrl(googleIssuer, 'NOODLE_OAUTH_ISSUER');
  validateOAuthHttpUrl(googleRedirectUri, 'NOODLE_OAUTH_GOOGLE_REDIRECT_URI');
  validateSigningKeyBase64(googleSigningKeyBase64);

  return {
    kind: 'google',
    issuer: googleIssuer,
    signingKeyBase64: googleSigningKeyBase64,
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    redirectUri: googleRedirectUri,
    ...(allowedEmailDomain === undefined ? {} : { allowedEmailDomain }),
  };
}

function rejectUnsupportedNoodleVariables(env: Environment): void {
  for (const variableName of Object.keys(env)) {
    if (
      UNSUPPORTED_PLATFORM_VARIABLES.has(variableName) ||
      (variableName.startsWith('NOODLE_') && !KNOWN_NOODLE_VARIABLES.has(variableName))
    ) {
      throw configurationError(`${variableName} is not supported by self-host`);
    }
  }
}

function required(env: Environment, variableName: string): string {
  const value = optional(env, variableName);
  if (value === undefined) throw configurationError(`${variableName} is required`);
  return value;
}

function optional(env: Environment, variableName: string): string | undefined {
  const value = env[variableName];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value))
    throw configurationError('PORT must be an integer from 1 through 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw configurationError('PORT must be an integer from 1 through 65535');
  }
  return port;
}

function validateDatabaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError('DATABASE_URL must be a PostgreSQL URL');
  }
  if ((parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') || !parsed.hostname) {
    throw configurationError('DATABASE_URL must be a PostgreSQL URL');
  }
}

function validateMasterKey(value: string): void {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw configurationError('NOODLE_SECRET_MASTER_KEY must be base64 encoded');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw configurationError('NOODLE_SECRET_MASTER_KEY must decode to exactly 32 bytes');
  }
}

function validateAssetRoot(value: string): void {
  const normalized = normalize(value);
  if (value.trim().length === 0 || !isAbsolute(value) || normalized === parse(normalized).root) {
    throw configurationError('NOODLE_ASSET_ROOT must be a non-root absolute path');
  }
}

function validateAssetIdentitySalt(value: string): void {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, 'base64url').byteLength !== 32 ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  ) {
    throw configurationError(
      'NOODLE_ASSET_IDENTITY_SALT must encode exactly 32 bytes as canonical base64url',
    );
  }
}

function validateSigningKeyBase64(value: string): void {
  if (!isCanonicalBase64(value) || Buffer.from(value, 'base64').length === 0) {
    throw configurationError('NOODLE_OAUTH_SIGNING_KEY_BASE64 must be non-empty canonical base64');
  }
}

function isCanonicalBase64(value: string): boolean {
  return (
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) &&
    value.length % 4 === 0 &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

export function assertStrongAdminToken(value: string): void {
  if (
    Buffer.byteLength(value) < 32 ||
    value !== value.trim() ||
    /\s/.test(value) ||
    new Set(value).size === 1 ||
    EXAMPLE_ADMIN_TOKENS.has(value.toLowerCase())
  ) {
    throw configurationError('NOODLE_SELF_HOST_ADMIN_TOKEN must be a generated secret');
  }
}

function normalizePublicBaseUrl(value: string): string {
  const parsed = parseHttpUrl(value, 'PUBLIC_BASE_URL');
  validateOriginShape(parsed, 'PUBLIC_BASE_URL');
  return parsed.origin;
}

function validateOAuthOriginUrl(value: string, variableName: string): void {
  const parsed = parseOAuthHttpUrl(value, variableName);
  validateOriginShape(parsed, variableName);
}

function validateOriginShape(parsed: URL, variableName: string): void {
  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw configurationError(`${variableName} must be an origin URL`);
  }
}

function validateOAuthHttpUrl(value: string, variableName: string): void {
  parseOAuthHttpUrl(value, variableName);
}

function parseOAuthHttpUrl(value: string, variableName: string): URL {
  const parsed = parseHttpUrl(value, variableName);
  if (parsed.protocol !== 'https:' && !EXPLICIT_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw configurationError(`${variableName} must use HTTPS or explicit loopback HTTP`);
  }
  return parsed;
}

function parseHttpUrl(value: string, variableName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError(`${variableName} must be an HTTP(S) URL`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw configurationError(`${variableName} must be an HTTP(S) URL`);
  }
  return parsed;
}

function configurationError(message: string): Error {
  return new Error(`self-host configuration: ${message}`);
}
