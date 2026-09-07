import { decodeJwt, decodeProtectedHeader, importJWK, type JWTPayload, jwtVerify } from 'jose';
import { secretDigestMatches } from './service-principal-credentials.js';
import type {
  ActiveServicePrincipalClient,
  ActiveServicePrincipalCredential,
  ServicePrincipalStore,
} from './service-principal-store.js';

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const PRINCIPAL_ID =
  /^spn_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_BASIC_BYTES = 4096;
const MAX_ASSERTION_SECONDS = 300;
const MAX_FUTURE_IAT_SECONDS = 60;

export interface ServicePrincipalClientAuthRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly authorization?: string | readonly string[];
}

export interface VerifiedServiceClient {
  readonly principalId: string;
  readonly org: string;
  readonly credentialId: string;
  readonly assertion?: { readonly jti: string; readonly expiresAt: number };
}

export class ServicePrincipalClientAuthError extends Error {
  readonly oauthError = 'invalid_client';
  readonly status = 401;

  constructor() {
    super('invalid client authentication');
    this.name = 'ServicePrincipalClientAuthError';
  }
}

/** Authenticate one bounded machine client without disclosing client or credential existence. */
export async function authenticateServicePrincipalClient(
  request: ServicePrincipalClientAuthRequest,
  store: ServicePrincipalStore,
  tokenEndpoint: string,
  nowSeconds: number,
): Promise<VerifiedServiceClient> {
  try {
    validateClock(nowSeconds);
    const authorization = oneAuthorization(request.authorization);
    const hasAssertion =
      request.body.client_assertion !== undefined ||
      request.body.client_assertion_type !== undefined;
    if (request.body.client_secret !== undefined) throw new Error('unsupported secret transport');
    if (authorization !== undefined) {
      if (hasAssertion) throw new Error('conflicting authentication');
      return await authenticateBasic(authorization, request.body, store, nowSeconds);
    }
    if (!hasAssertion) throw new Error('missing authentication');
    return await authenticateAssertion(request.body, store, tokenEndpoint, nowSeconds);
  } catch {
    throw new ServicePrincipalClientAuthError();
  }
}

async function authenticateBasic(
  authorization: string,
  body: Readonly<Record<string, unknown>>,
  store: ServicePrincipalStore,
  nowSeconds: number,
): Promise<VerifiedServiceClient> {
  if (
    !authorization.startsWith('Basic ') ||
    Buffer.byteLength(authorization, 'utf8') > MAX_BASIC_BYTES
  ) {
    throw new Error('invalid Basic authorization');
  }
  const encoded = authorization.slice('Basic '.length);
  if (!isCanonicalBase64(encoded)) throw new Error('invalid Basic encoding');
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1 || decoded.indexOf(':', separator + 1) !== -1) {
    throw new Error('invalid Basic credentials');
  }
  const clientId = decoded.slice(0, separator);
  const secret = decoded.slice(separator + 1);
  if (!PRINCIPAL_ID.test(clientId) || !SECRET.test(secret)) throw new Error('invalid client');
  const bodyClientId = optionalString(body.client_id);
  if (bodyClientId !== undefined && bodyClientId !== clientId) throw new Error('client mismatch');

  const client = await store.loadActiveClient(clientId, nowSeconds * 1000);
  if (client === undefined) throw new Error('unknown client');
  let match: ActiveServicePrincipalCredential | undefined;
  for (const credential of client.credentials) {
    if (credential.kind !== 'client_secret') continue;
    if (secretDigestMatches(secret, credential.secretDigest)) match = credential;
  }
  if (match === undefined) throw new Error('invalid secret');
  return verified(client, match.credentialId);
}

async function authenticateAssertion(
  body: Readonly<Record<string, unknown>>,
  store: ServicePrincipalStore,
  tokenEndpoint: string,
  nowSeconds: number,
): Promise<VerifiedServiceClient> {
  if (body.client_assertion_type !== ASSERTION_TYPE) throw new Error('invalid assertion type');
  const assertion = requiredString(body.client_assertion);
  if (Buffer.byteLength(assertion, 'utf8') > MAX_ASSERTION_BYTES) {
    throw new Error('assertion too large');
  }
  const decoded = decodeJwt(assertion);
  const clientId = assertionClientId(decoded, body.client_id);
  const header = decodeProtectedHeader(assertion);
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new Error('unsupported algorithm');
  if (header.kid !== undefined && (typeof header.kid !== 'string' || header.kid.length > 200)) {
    throw new Error('invalid kid');
  }
  const client = await store.loadActiveClient(clientId, nowSeconds * 1000);
  if (client === undefined) throw new Error('unknown client');
  const candidates = client.credentials.filter(
    (credential) =>
      credential.kind === 'public_jwk' &&
      credential.algorithm === header.alg &&
      (header.kid === undefined || credential.kid === header.kid),
  );
  if (candidates.length === 0 || candidates.length > 5) throw new Error('invalid key set');

  const audiences = acceptedAudiences(tokenEndpoint);
  for (const credential of candidates) {
    if (credential.kind !== 'public_jwk') continue;
    try {
      const key = await importJWK(credential.publicJwk, credential.algorithm);
      const verifiedAssertion = await jwtVerify(assertion, key, {
        algorithms: [credential.algorithm],
        currentDate: new Date(nowSeconds * 1000),
      });
      const replay = validateAssertionClaims(
        verifiedAssertion.payload,
        clientId,
        audiences,
        nowSeconds,
      );
      return verified(client, credential.credentialId, replay);
    } catch {
      // The active public-key set is bounded to five; try every eligible key without disclosure.
    }
  }
  throw new Error('invalid assertion');
}

function validateAssertionClaims(
  payload: JWTPayload,
  clientId: string,
  acceptedAudience: ReadonlySet<string>,
  nowSeconds: number,
): { readonly jti: string; readonly expiresAt: number } {
  if (payload.iss !== clientId || payload.sub !== clientId) throw new Error('invalid subject');
  if (typeof payload.aud !== 'string' || !acceptedAudience.has(payload.aud)) {
    throw new Error('invalid audience');
  }
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new Error('invalid assertion clock');
  }
  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  if (
    issuedAt > nowSeconds + MAX_FUTURE_IAT_SECONDS ||
    expiresAt <= nowSeconds ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_ASSERTION_SECONDS
  ) {
    throw new Error('invalid assertion lifetime');
  }
  if (typeof payload.jti !== 'string' || payload.jti.length < 1 || payload.jti.length > 200) {
    throw new Error('invalid assertion jti');
  }
  return { jti: payload.jti, expiresAt };
}

function assertionClientId(payload: JWTPayload, bodyClientId: unknown): string {
  if (
    typeof payload.iss !== 'string' ||
    payload.iss !== payload.sub ||
    !PRINCIPAL_ID.test(payload.iss)
  ) {
    throw new Error('invalid client identifier');
  }
  const explicit = optionalString(bodyClientId);
  if (explicit !== undefined && explicit !== payload.iss) throw new Error('client mismatch');
  return payload.iss;
}

function verified(
  client: ActiveServicePrincipalClient,
  credentialId: string,
  assertion?: { readonly jti: string; readonly expiresAt: number },
): VerifiedServiceClient {
  return {
    principalId: client.principal.principalId,
    org: client.principal.org,
    credentialId,
    ...(assertion === undefined ? {} : { assertion }),
  };
}

function oneAuthorization(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('duplicate authorization');
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid string');
  return value;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function acceptedAudiences(tokenEndpoint: string): ReadonlySet<string> {
  const endpoint = new URL(tokenEndpoint);
  if (!endpoint.pathname.endsWith('/token') || endpoint.search || endpoint.hash) {
    throw new Error('invalid token endpoint');
  }
  const issuer = new URL(endpoint.href);
  issuer.pathname = issuer.pathname.slice(0, -'/token'.length) || '/';
  const issuerValue = issuer.href.endsWith('/') ? issuer.href.slice(0, -1) : issuer.href;
  return new Set([endpoint.href, issuerValue]);
}

function validateClock(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error('invalid clock');
}
