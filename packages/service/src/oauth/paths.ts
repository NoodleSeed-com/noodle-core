/**
 * Paths owned by the authorization-server sub-app (OA-2). Kept in its own dependency-free module so the
 * raw-`node:http` front-door can decide delegation without importing Express — Express (and the AS app) load
 * lazily, only when the authorization server is actually enabled.
 */
const AUTH_SERVER_PATHS: ReadonlySet<string> = new Set([
  '/authorize',
  '/device_authorization',
  '/device',
  '/token',
  '/revoke',
  '/register',
  '/oauth/google/callback',
  '/oauth/workos/callback',
  '/oauth/workos/logout',
  '/oauth/upstream/continue',
  '/oauth/device/callback',
  '/oauth/consent',
  '/oauth/developer-grant',
  '/oauth/customer/firebase/authorize',
  '/oauth/customer/firebase/callback',
  '/oauth/customer/microsoft/callback',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/.well-known/jwks.json',
]);

/** Whether a request path is owned by the authorization-server sub-app (delegated from the front-door). */
export function isAuthServerPath(pathname: string): boolean {
  return AUTH_SERVER_PATHS.has(pathname);
}
