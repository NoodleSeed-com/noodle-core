import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  applySecurityHeaders,
  enforceHttps,
  sendJson,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import { baseFromRequest, normalizeServiceBase } from '../http-util.js';
import type { ServiceOptions } from '../options.js';

/** Provider-neutral discovery and its shipped Google-named compatibility route share exact bytes. */
export function dispatchAuthDiscoveryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ServiceOptions,
  tls: TlsPosture,
): boolean {
  if (req.method !== 'GET' || (url.pathname !== '/v1/auth' && url.pathname !== '/v1/auth/google')) {
    return false;
  }
  applySecurityHeaders(res, tls);
  if (enforceHttps(req, res, tls)) return true;
  const base = options.publicBaseUrl ?? baseFromRequest(req, tls);
  const controlPlaneResource = normalizeServiceBase(
    options.publicBaseUrl ?? options.authServerIssuer ?? base,
  );
  const selfHostedOAuthLogin =
    options.authServerApp !== undefined &&
    options.authServerIssuer !== undefined &&
    options.verifyOwnerToken !== undefined;
  const consoleUrl = httpsConsoleBase(options.invitationConsoleBaseUrl);
  sendJson(res, 200, {
    ok: true,
    service: base,
    ...(consoleUrl !== undefined ? { consoleUrl } : {}),
    googleClientId: options.controlPlaneGoogleClientId ?? null,
    ...(selfHostedOAuthLogin
      ? {
          authorizationServerIssuer: options.authServerIssuer,
          controlPlaneResource,
        }
      : {}),
    allowedEmailDomain: options.controlPlaneAllowedEmailDomain ?? '@noodleseed.com',
    signupMode: options.controlPlaneSignupMode ?? 'restricted',
    authType: selfHostedOAuthLogin
      ? 'noodle-oauth-pkce'
      : options.controlPlaneGoogleClientId
        ? 'google-oauth-pkce'
        : 'open-dev',
  });
  return true;
}

/** Discovery must only advertise a Console destination the CLI can safely hand off to a browser. */
function httpsConsoleBase(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return strictHttpsConsoleBase(value);
  } catch {
    return undefined;
  }
}

function strictHttpsConsoleBase(value: string): string {
  if (value.trim() !== value || !value.startsWith('https://'))
    throw new Error('invalid Console URL');
  const remainder = value.slice('https://'.length);
  const separator = remainder.search(/[/?#]/);
  const authority = separator === -1 ? remainder : remainder.slice(0, separator);
  if (authority.length === 0) throw new Error('invalid Console URL');
  const rawRest = separator === -1 ? '' : remainder.slice(separator);
  const rawPath = rawRest.startsWith('/') ? (rawRest.split(/[?#]/, 1)[0] ?? '') : '';
  if (rawPath.includes('//')) throw new Error('invalid Console URL');
  for (const segment of rawPath.split('/').slice(1)) {
    if (segment.length === 0) continue;
    const decoded = decodeURIComponent(segment);
    if (decoded === '.' || decoded === '..') throw new Error('invalid Console URL');
  }

  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('invalid Console URL');
  }
  const parsedBase = `${url.origin}${url.pathname}`;
  const rootTrailingSlashOnly = rawPath === '' && parsedBase === `${value}/`;
  if (parsedBase !== value && !rootTrailingSlashOnly) throw new Error('invalid Console URL');
  return value;
}
