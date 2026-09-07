import type { SigningKeyProvider } from '@noodle-borg/auth';
import { jwtVerify, SignJWT } from 'jose';
import { type ConsentClaims, isConsentClaims } from './consent-claims.js';

export async function signConsentToken(
  claims: ConsentClaims,
  signer: SigningKeyProvider,
  issuer: string,
  ttlSeconds: number,
): Promise<string> {
  const key = await signer.signingKey();
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key.privateKey);
}

export async function verifyConsentToken(
  token: string,
  signer: SigningKeyProvider,
  issuer: string,
): Promise<ConsentClaims> {
  const getKey = await signer.verifierKey();
  const { payload } = await jwtVerify(token, getKey, { issuer });
  if (!isConsentClaims(payload)) throw new Error('not a consent token');
  return payload;
}
