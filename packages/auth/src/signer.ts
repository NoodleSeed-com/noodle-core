import type { JSONWebKeySet, JWK, JWTVerifyGetKey } from 'jose';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importPKCS8,
} from 'jose';

/** The key type jose accepts for signing (CryptoKey/KeyObject), referenced without the DOM `CryptoKey` global. */
type SigningCryptoKey = Awaited<ReturnType<typeof importPKCS8>>;

/**
 * Signing-key custody for the self-hosted authorization server (OA-2, [ADR 0042]). The provider owns the
 * private key used to sign access tokens and publishes the matching public key as a JWKS (read by the OA-1
 * resource-server verifier via its `jwksUri`, or in-process via {@link verifierKey}).
 *
 * Two implementations are anticipated: a **static** RS256 key for alpha (this file) and a **KMS-wrapped**
 * key as a fast-follow (mirroring [ADR 0037]) — the private key would then never leave KMS. The interface is
 * async on purpose so the KMS variant slots in behind it unchanged.
 */
export interface SigningKey {
  /** JWS algorithm (RS256 for alpha). */
  readonly alg: string;
  /** Stable key id (JWK thumbprint) — set in the token header and the published JWK. */
  readonly kid: string;
  /** The private signing key. */
  readonly privateKey: SigningCryptoKey;
}

export interface SigningKeyProvider {
  /** The active signing key (custody owns the private material). */
  signingKey(): Promise<SigningKey>;
  /** The public JWK Set served at the JWKS endpoint and consumed by the resource-server verifier. */
  publicJwks(): Promise<JSONWebKeySet>;
  /** A local verify resolver over the public key(s) — no HTTP fetch (tests + same-process verification). */
  verifierKey(): Promise<JWTVerifyGetKey>;
}

const RS256 = 'RS256';

export interface StaticSigningKeyOptions {
  /**
   * A PKCS#8 PEM-encoded RSA private key (e.g. from `NOODLE_OAUTH_SIGNING_KEY`). When omitted, a fresh
   * keypair is generated at construction — convenient for dev/tests, but the key is lost on restart, so
   * production must supply one.
   */
  readonly privateKeyPem?: string;
}

/**
 * A {@link SigningKeyProvider} backed by a single static RS256 key. With `privateKeyPem` the key is imported
 * (extractable, so the public JWK can be derived); otherwise one is generated. The public JWK is stripped to
 * its public members only — private fields never reach {@link publicJwks}.
 */
export async function createStaticSigningKeyProvider(
  options: StaticSigningKeyOptions = {},
): Promise<SigningKeyProvider> {
  const privateKey = options.privateKeyPem
    ? await importPKCS8(options.privateKeyPem, RS256, { extractable: true })
    : (await generateKeyPair(RS256, { extractable: true })).privateKey;

  // Derive the public JWK from the private key, keeping only public members (never publish d/p/q/...).
  const publicJwk = toPublicJwk(await exportJWK(privateKey));
  const kid = await calculateJwkThumbprint(publicJwk);
  const publishedJwk: JWK = { ...publicJwk, kid, alg: RS256, use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [publishedJwk] };
  const resolver = createLocalJWKSet(jwks);
  const key: SigningKey = { alg: RS256, kid, privateKey };

  return {
    signingKey: () => Promise.resolve(key),
    publicJwks: () => Promise.resolve(jwks),
    verifierKey: () => Promise.resolve(resolver),
  };
}

/** Keep only the public members of a JWK by key type — strips RSA `d/p/q/...` and EC/OKP private `d`. */
function toPublicJwk(jwk: JWK): JWK {
  switch (jwk.kty) {
    case 'RSA':
      return pick(jwk, ['kty', 'n', 'e']);
    case 'EC':
      return pick(jwk, ['kty', 'crv', 'x', 'y']);
    case 'OKP':
      return pick(jwk, ['kty', 'crv', 'x']);
    default:
      throw new Error(`unsupported signing key type: ${String(jwk.kty)}`);
  }
}

function pick(jwk: JWK, keys: readonly (keyof JWK)[]): JWK {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = jwk[key];
    if (value !== undefined) out[key] = value;
  }
  return out as JWK;
}
