import type { SigningKeyProvider } from '@noodle-borg/auth';
import type { UpstreamHumanOAuthAuthenticator } from './upstream-human.js';
import {
  expireUpstreamSessionCookies,
  UPSTREAM_SESSION_COOKIE_LOOPBACK,
  UPSTREAM_SESSION_COOKIE_SECURE,
  verifyUpstreamSessionHandle,
} from './upstream-session.js';

interface LogoutRequest {
  readonly headers: { readonly cookie?: string | undefined };
}

interface LogoutResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
  redirect(status: number, location: string): unknown;
  append(field: string, value: string): unknown;
}

export async function handleUpstreamSessionLogout(input: {
  readonly req: LogoutRequest;
  readonly res: LogoutResponse;
  readonly issuer: string;
  readonly signer: SigningKeyProvider;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
  readonly returnTo?: string;
}): Promise<void> {
  input.res.setHeader('Cache-Control', 'no-store');
  input.res.setHeader('Referrer-Policy', 'no-referrer');
  if (input.workos?.sessionLogoutUrl === undefined || input.returnTo === undefined) {
    input.res.status(404).json({ error: 'not_found' });
    return;
  }

  const handle = upstreamSessionHandle(input.req.headers.cookie);
  expireUpstreamSessionCookies(input.res);
  if (handle === undefined) {
    input.res.redirect(302, input.returnTo);
    return;
  }

  let sessionId: string;
  try {
    sessionId = await verifyUpstreamSessionHandle({
      handle,
      signer: input.signer,
      issuer: input.issuer,
    });
  } catch {
    input.res.redirect(302, input.returnTo);
    return;
  }

  input.res.redirect(302, input.workos.sessionLogoutUrl(sessionId, input.returnTo).href);
}

function upstreamSessionHandle(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  const values = new Map<string, string[]>();
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== UPSTREAM_SESSION_COOKIE_SECURE && name !== UPSTREAM_SESSION_COOKIE_LOOPBACK)
      continue;
    const value = pair.slice(separator + 1).trim();
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  for (const name of [UPSTREAM_SESSION_COOKIE_SECURE, UPSTREAM_SESSION_COOKIE_LOOPBACK]) {
    const found = values.get(name);
    if (found?.length === 1 && found[0]?.length !== 0) return found[0];
    if (found !== undefined) return undefined;
  }
  return undefined;
}
