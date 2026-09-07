import type { SigningKeyProvider } from '@noodle-borg/auth';
import { jwtVerify, SignJWT } from 'jose';

interface CookieResponse {
  append(field: string, value: string): unknown;
}

export const UPSTREAM_SESSION_COOKIE_SECURE = '__Host-ns_upstream_session';
export const UPSTREAM_SESSION_COOKIE_LOOPBACK = 'ns_upstream_session';

const UPSTREAM_SESSION_HANDLE_KIND = 'upstream-session-logout';
const UPSTREAM_SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;
const UPSTREAM_SESSION_ID_PATTERN = /^[!-~]+$/;
const UPSTREAM_SESSION_ID_MAX_LENGTH = 200;

function requireUpstreamSessionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > UPSTREAM_SESSION_ID_MAX_LENGTH ||
    !UPSTREAM_SESSION_ID_PATTERN.test(value)
  ) {
    throw new Error('upstream session ID is invalid');
  }
  return value;
}

export async function signUpstreamSessionHandle(input: {
  readonly sessionId: string;
  readonly signer: SigningKeyProvider;
  readonly issuer: string;
  readonly ttlSeconds?: number;
}): Promise<string> {
  const key = await input.signer.signingKey();
  const ttlSeconds = Math.min(
    input.ttlSeconds ?? UPSTREAM_SESSION_MAX_AGE_SECONDS,
    UPSTREAM_SESSION_MAX_AGE_SECONDS,
  );
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('upstream session handle TTL is invalid');
  }
  return new SignJWT({
    kind: UPSTREAM_SESSION_HANDLE_KIND,
    sessionId: requireUpstreamSessionId(input.sessionId),
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(input.issuer)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key.privateKey);
}

export async function verifyUpstreamSessionHandle(input: {
  readonly handle: string;
  readonly signer: SigningKeyProvider;
  readonly issuer: string;
}): Promise<string> {
  const getKey = await input.signer.verifierKey();
  const { payload } = await jwtVerify(input.handle, getKey, { issuer: input.issuer });
  if (payload.kind !== UPSTREAM_SESSION_HANDLE_KIND) {
    throw new Error('upstream session handle is invalid');
  }
  return requireUpstreamSessionId(payload.sessionId);
}

export function setUpstreamSessionCookie(input: {
  readonly res: CookieResponse;
  readonly issuer: string;
  readonly handle: string;
}): void {
  const issuer = new URL(input.issuer);
  const secure = issuer.protocol === 'https:';
  if (!secure && !isLoopbackHostname(issuer.hostname)) {
    throw new Error('upstream session cookie requires HTTPS or loopback');
  }
  const name = secure ? UPSTREAM_SESSION_COOKIE_SECURE : UPSTREAM_SESSION_COOKIE_LOOPBACK;
  input.res.append(
    'Set-Cookie',
    serializeCookie(name, input.handle, {
      maxAge: UPSTREAM_SESSION_MAX_AGE_SECONDS,
      secure,
    }),
  );
}

export function expireUpstreamSessionCookies(res: CookieResponse): void {
  res.append(
    'Set-Cookie',
    serializeCookie(UPSTREAM_SESSION_COOKIE_SECURE, '', { maxAge: 0, secure: true }),
  );
  res.append(
    'Set-Cookie',
    serializeCookie(UPSTREAM_SESSION_COOKIE_LOOPBACK, '', { maxAge: 0, secure: false }),
  );
}

function serializeCookie(
  name: string,
  value: string,
  input: { readonly maxAge: number; readonly secure: boolean },
): string {
  return `${name}=${value}; Path=/; Max-Age=${input.maxAge}; HttpOnly;${
    input.secure ? ' Secure;' : ''
  } SameSite=Lax`;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
