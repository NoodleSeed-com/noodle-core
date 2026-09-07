import type { Response } from 'express';

/** Redirect an OAuth authorization response with the exact RFC 9207 issuer identifier. */
export function redirectAuthorizationResponse(res: Response, redirect: URL, issuer: string): void {
  redirect.searchParams.set('iss', issuer);
  res.redirect(302, redirect.href);
}
