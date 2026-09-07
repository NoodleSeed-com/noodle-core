import {
  type CryptoKey,
  type JWK,
  type JWTVerifyGetKey,
  jwtVerify,
  type KeyObject,
  SignJWT,
} from 'jose';
import {
  type ExternalCredentialWorkloadClaims,
  type ExternalCredentialWorkloadInput,
  externalCredentialIdentifierSchema,
  externalCredentialWorkloadClaimsSchema,
} from './contract.js';

export const EXTERNAL_CREDENTIAL_ASSERTION_TTL_SECONDS = 60;

export interface ExternalCredentialAssertionReplayStore {
  /** Atomically consume a jti. Production storage must be durable and shared across instances/restarts. */
  consume(jti: string, expiresAtSeconds: number): Promise<boolean>;
}

/** Local/test-only adapter. Production providers must inject durable shared atomic replay storage. */
export class InMemoryAssertionReplayStore implements ExternalCredentialAssertionReplayStore {
  readonly #consumed = new Map<string, number>();

  async consume(jti: string, expiresAtSeconds: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1_000);
    for (const [candidate, expiry] of this.#consumed) {
      if (expiry <= now) this.#consumed.delete(candidate);
    }
    if (this.#consumed.has(jti)) return false;
    this.#consumed.set(jti, expiresAtSeconds);
    return true;
  }
}

export interface ExternalCredentialSigningKey {
  readonly alg: string;
  readonly kid: string;
  readonly privateKey: CryptoKey | KeyObject | JWK | Uint8Array;
}

export async function signExternalCredentialWorkloadAssertion(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly workload: ExternalCredentialWorkloadInput;
  readonly signingKey: ExternalCredentialSigningKey;
  readonly nowMs?: number;
  readonly jti?: string;
}): Promise<string> {
  if (input.signingKey.alg !== 'RS256') {
    throw new Error('external credential workload assertions require RS256');
  }
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  const claims = externalCredentialWorkloadClaimsSchema.parse({
    ...input.workload,
    iss: input.issuer,
    aud: input.audience,
    iat: issuedAt,
    exp: issuedAt + EXTERNAL_CREDENTIAL_ASSERTION_TTL_SECONDS,
    jti: input.jti ?? crypto.randomUUID(),
  });
  const kid = externalCredentialIdentifierSchema.parse(input.signingKey.kid);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .sign(input.signingKey.privateKey);
}

export interface ExternalCredentialAssertionVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  readonly keyId: string;
  readonly verificationKey: JWTVerifyGetKey;
  readonly replayStore: ExternalCredentialAssertionReplayStore;
  readonly nowMs?: number;
}

export async function verifyExternalCredentialWorkloadAssertion(
  assertion: string,
  options: ExternalCredentialAssertionVerifierOptions,
): Promise<ExternalCredentialWorkloadClaims> {
  if (!options.algorithms.includes('RS256') || options.algorithms.length !== 1) {
    throw new Error('external credential verifier must pin RS256');
  }
  const nowMs = options.nowMs ?? Date.now();
  const verified = await jwtVerify(assertion, options.verificationKey, {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: ['RS256'],
    currentDate: new Date(nowMs),
    clockTolerance: 0,
    requiredClaims: ['iss', 'aud', 'iat', 'exp', 'jti'],
  });
  if (verified.protectedHeader.alg !== 'RS256') {
    throw new Error('external credential assertion algorithm mismatch');
  }
  if (verified.protectedHeader.kid !== options.keyId) {
    throw new Error('external credential assertion key id mismatch');
  }
  if (verified.protectedHeader.typ !== 'JWT') {
    throw new Error('external credential assertion type mismatch');
  }
  const claims = externalCredentialWorkloadClaimsSchema.parse(verified.payload);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (claims.iat > nowSeconds || claims.exp <= claims.iat) {
    throw new Error('external credential assertion time window is invalid');
  }
  if (claims.exp - claims.iat > EXTERNAL_CREDENTIAL_ASSERTION_TTL_SECONDS) {
    throw new Error('external credential assertion lifetime is too long');
  }
  if (!(await options.replayStore.consume(claims.jti, claims.exp))) {
    throw new Error('external credential assertion replay rejected');
  }
  return claims;
}
