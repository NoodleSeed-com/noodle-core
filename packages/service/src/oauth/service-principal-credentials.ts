import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { importJWK } from 'jose';

export type ServicePrincipalSigningAlgorithm = 'RS256' | 'ES256';

export interface ValidatedPublicJwk {
  readonly algorithm: ServicePrincipalSigningAlgorithm;
  readonly publicJwk: Readonly<Record<string, unknown>>;
}

const MAX_PUBLIC_JWK_BYTES = 16 * 1024;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

/** Generate the one-time 256-bit secret returned by the management API. */
export function createClientSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash a high-entropy client secret for durable storage. */
export function digestClientSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/** Compare a presented secret with one canonical SHA-256 digest in constant time. */
export function secretDigestMatches(secret: string, expectedDigest: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedDigest)) return false;
  const expected = Buffer.from(expectedDigest, 'base64url');
  const actual = Buffer.from(digestClientSecret(secret), 'base64url');
  return (
    expected.length === 32 && actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

/** Validate and import-check one public verification JWK before it reaches a store. */
export async function validatePublicJwk(
  value: unknown,
  algorithm: string,
): Promise<ValidatedPublicJwk> {
  if (algorithm !== 'RS256' && algorithm !== 'ES256') {
    throw new Error('service-principal JWK algorithm must be RS256 or ES256');
  }
  if (!isRecord(value)) throw new Error('service-principal public JWK must be an object');
  const serialized = serializeJwk(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PUBLIC_JWK_BYTES) {
    throw new Error('service-principal public JWK must be at most 16 KiB');
  }
  for (const member of PRIVATE_JWK_MEMBERS) {
    if (Object.hasOwn(value, member)) {
      throw new Error(`service-principal public JWK must not contain private member ${member}`);
    }
  }
  validateCommonJwkMetadata(value, algorithm);
  if (algorithm === 'RS256') validateRsaJwk(value);
  else validateEcJwk(value);

  try {
    await importJWK(value, algorithm);
  } catch {
    throw new Error(`service-principal ${algorithm} public JWK is malformed`);
  }
  return Object.freeze({
    algorithm,
    publicJwk: Object.freeze(structuredClone(value)),
  });
}

function serializeJwk(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new Error('service-principal public JWK must be JSON serializable');
  }
}

function validateCommonJwkMetadata(
  jwk: Record<string, unknown>,
  algorithm: ServicePrincipalSigningAlgorithm,
): void {
  if (jwk.alg !== undefined && jwk.alg !== algorithm) {
    throw new Error('service-principal JWK declared algorithm does not match its pinned algorithm');
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    throw new Error('service-principal JWK use must be sig');
  }
  if (
    jwk.key_ops !== undefined &&
    (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify')
  ) {
    throw new Error('service-principal JWK key_ops must contain only verify');
  }
  if (
    jwk.kid !== undefined &&
    (typeof jwk.kid !== 'string' || jwk.kid.length === 0 || jwk.kid.length > 200)
  ) {
    throw new Error('service-principal JWK kid must be between 1 and 200 characters');
  }
}

function validateRsaJwk(jwk: Record<string, unknown>): void {
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error('RS256 requires an RSA public JWK');
  }
  const modulus = decodeCanonicalBase64url(jwk.n, 'RSA modulus');
  const bits = modulusBitLength(modulus);
  if (bits < 2048 || bits > 4096) {
    throw new Error('RS256 RSA modulus must be between 2048 and 4096 bits');
  }
  decodeCanonicalBase64url(jwk.e, 'RSA exponent');
}

function validateEcJwk(jwk: Record<string, unknown>): void {
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string'
  ) {
    throw new Error('ES256 requires a P-256 EC public JWK');
  }
  if (
    decodeCanonicalBase64url(jwk.x, 'EC x coordinate').length !== 32 ||
    decodeCanonicalBase64url(jwk.y, 'EC y coordinate').length !== 32
  ) {
    throw new Error('ES256 requires 256-bit EC coordinates');
  }
}

function decodeCanonicalBase64url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} must be base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) {
    throw new Error(`${label} must be canonical base64url`);
  }
  return decoded;
}

function modulusBitLength(value: Buffer): number {
  const firstNonZero = value.findIndex((byte) => byte !== 0);
  if (firstNonZero === -1) return 0;
  const first = value[firstNonZero] as number;
  return (value.length - firstNonZero - 1) * 8 + (32 - Math.clz32(first));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
