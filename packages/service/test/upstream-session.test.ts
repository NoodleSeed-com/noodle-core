import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { Response } from 'express';
import { decodeJwt, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  expireUpstreamSessionCookies,
  setUpstreamSessionCookie,
  signUpstreamSessionHandle,
  UPSTREAM_SESSION_COOKIE_LOOPBACK,
  UPSTREAM_SESSION_COOKIE_SECURE,
  verifyUpstreamSessionHandle,
} from '../src/oauth/upstream-session.js';

const ISSUER = 'https://cloud.noodleseed.dev';
const SESSION_ID = 'session_01H93ZY4F80QPBEZ1R5B2SHQG8';

describe('upstream logout session handle', () => {
  it('round-trips only the issuer-bound upstream session ID', async () => {
    const signer = await createStaticSigningKeyProvider();
    const handle = await signUpstreamSessionHandle({
      sessionId: SESSION_ID,
      signer,
      issuer: ISSUER,
    });

    await expect(
      verifyUpstreamSessionHandle({
        handle,
        signer,
        issuer: ISSUER,
      }),
    ).resolves.toBe(SESSION_ID);
    expect(decodeJwt(handle)).toMatchObject({
      kind: 'upstream-session-logout',
      sessionId: SESSION_ID,
      iss: ISSUER,
    });

    const serializedPayload = JSON.stringify(decodeJwt(handle));
    for (const forbidden of [
      'email',
      'subject',
      'accessToken',
      'refreshToken',
      'code',
      'state',
      'providerResponse',
    ]) {
      expect(serializedPayload).not.toContain(forbidden);
    }
  });

  it('rejects a handle issued by another Noodle authorization server', async () => {
    const signer = await createStaticSigningKeyProvider();
    const handle = await signUpstreamSessionHandle({
      sessionId: SESSION_ID,
      signer,
      issuer: ISSUER,
    });

    await expect(
      verifyUpstreamSessionHandle({
        handle,
        signer,
        issuer: 'https://other.noodleseed.dev',
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['expired', { kind: 'upstream-session-logout', sessionId: SESSION_ID }, -30],
    ['wrong kind', { kind: 'access-token', sessionId: SESSION_ID }, 300],
    ['malformed session', { kind: 'upstream-session-logout', sessionId: 'bad session' }, 300],
    ['unrelated', { sub: 'principal' }, 300],
  ])('rejects a %s signed token', async (_case, payload, expiresInSeconds) => {
    const signer = await createStaticSigningKeyProvider();
    const handle = await signTestToken(payload, signer, expiresInSeconds);

    await expect(
      verifyUpstreamSessionHandle({
        handle,
        signer,
        issuer: ISSUER,
      }),
    ).rejects.toThrow();
  });

  it('rejects a tampered handle', async () => {
    const signer = await createStaticSigningKeyProvider();
    const handle = await signUpstreamSessionHandle({
      sessionId: SESSION_ID,
      signer,
      issuer: ISSUER,
    });
    const tampered = tamperSignature(handle);

    await expect(
      verifyUpstreamSessionHandle({
        handle: tampered,
        signer,
        issuer: ISSUER,
      }),
    ).rejects.toThrow();
  });

  it('sets only the secure host cookie for an HTTPS issuer', () => {
    const response = responseCapture();

    setUpstreamSessionCookie({
      res: response.res,
      issuer: ISSUER,
      handle: 'signed-handle',
    });

    expect(response.cookies).toEqual([
      `${UPSTREAM_SESSION_COOKIE_SECURE}=signed-handle; Path=/; Max-Age=1209600; HttpOnly; Secure; SameSite=Lax`,
    ]);
  });

  it('sets only the loopback cookie for a local HTTP issuer', () => {
    const response = responseCapture();

    setUpstreamSessionCookie({
      res: response.res,
      issuer: 'http://localhost:8787',
      handle: 'signed-handle',
    });

    expect(response.cookies).toEqual([
      `${UPSTREAM_SESSION_COOKIE_LOOPBACK}=signed-handle; Path=/; Max-Age=1209600; HttpOnly; SameSite=Lax`,
    ]);
    expect(response.cookies[0]).not.toContain(UPSTREAM_SESSION_COOKIE_SECURE);
  });

  it('expires both cookie variants during logout', () => {
    const response = responseCapture();

    expireUpstreamSessionCookies(response.res);

    expect(response.cookies).toEqual([
      `${UPSTREAM_SESSION_COOKIE_SECURE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      `${UPSTREAM_SESSION_COOKIE_LOOPBACK}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    ]);
  });
});

function tamperSignature(token: string): string {
  const [header, payload, signature] = token.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error('expected JWT fixture');
  }
  return `${header}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
}

async function signTestToken(
  payload: object,
  signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>,
  expiresInSeconds: number,
): Promise<string> {
  const key = await signer.signingKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(key.privateKey);
}

function responseCapture(): { readonly res: Response; readonly cookies: string[] } {
  const cookies: string[] = [];
  const res = {
    append: (field: string, value?: string | readonly string[]) => {
      if (field.toLowerCase() !== 'set-cookie' || value === undefined) {
        throw new Error(`unexpected response header ${field}`);
      }
      cookies.push(...(typeof value === 'string' ? [value] : value));
      return res;
    },
  } as unknown as Response;
  return { res, cookies };
}
