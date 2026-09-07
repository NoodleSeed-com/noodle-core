export interface ServiceAuthMetadata {
  readonly ok: true;
  readonly service: string;
  /** Optional HTTPS Console base URL advertised by hosted control planes. */
  readonly consoleUrl?: string;
  readonly googleClientId?: string | null;
  readonly authorizationServerIssuer?: string | null;
  readonly controlPlaneResource?: string | null;
  readonly allowedEmailDomain?: string;
  readonly signupMode?: 'restricted' | 'public';
  readonly authType: string;
}

/**
 * Discover control-plane authentication through the provider-neutral route. The Google-named endpoint is a
 * hidden old-service compatibility path only: authorization failures, outages, and malformed canonical
 * responses must never silently downgrade.
 */
export async function getAuthMetadata(
  serviceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceAuthMetadata> {
  const base = serviceUrl.replace(/\/+$/, '');
  let response = await fetchImpl(`${base}/v1/auth`, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  });
  if (response.status === 404 || response.status === 405) {
    response = await fetchImpl(`${base}/v1/auth/google`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
  }
  if (!response.ok) throw new Error(`service auth metadata failed (${response.status})`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('service auth metadata is invalid');
  }
  return parseServiceAuthMetadata(body);
}

function parseServiceAuthMetadata(value: unknown): ServiceAuthMetadata {
  if (typeof value !== 'object' || value === null) {
    throw new Error('service auth metadata is invalid');
  }
  const body = value as Record<string, unknown>;
  const signupMode = body.signupMode;
  const issuer = body.authorizationServerIssuer;
  const resource = body.controlPlaneResource;
  const googleClientId = body.googleClientId;
  const allowedEmailDomain = body.allowedEmailDomain;
  const consoleUrl = parseConsoleUrl(body.consoleUrl);
  if (
    body.ok !== true ||
    typeof body.service !== 'string' ||
    body.service.length === 0 ||
    !(
      googleClientId === undefined ||
      typeof googleClientId === 'string' ||
      googleClientId === null
    ) ||
    !(allowedEmailDomain === undefined || typeof allowedEmailDomain === 'string') ||
    typeof body.authType !== 'string' ||
    !(signupMode === undefined || signupMode === 'restricted' || signupMode === 'public') ||
    !(issuer === undefined || issuer === null || typeof issuer === 'string') ||
    !(resource === undefined || resource === null || typeof resource === 'string') ||
    (body.authType === 'noodle-oauth-pkce' &&
      (typeof issuer !== 'string' || typeof resource !== 'string'))
  ) {
    throw new Error('service auth metadata is invalid');
  }
  return {
    ok: true,
    service: body.service,
    authType: body.authType,
    ...(googleClientId !== undefined ? { googleClientId } : {}),
    ...(issuer !== undefined ? { authorizationServerIssuer: issuer } : {}),
    ...(resource !== undefined ? { controlPlaneResource: resource } : {}),
    ...(allowedEmailDomain !== undefined ? { allowedEmailDomain } : {}),
    ...(signupMode !== undefined ? { signupMode } : {}),
    ...(consoleUrl !== undefined ? { consoleUrl } : {}),
  };
}

/** A handoff destination is a browser-safe HTTPS origin with an optional base path. */
function parseConsoleUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('service auth metadata is invalid');
  try {
    return strictHttpsConsoleBase(value);
  } catch {
    throw new Error('service auth metadata is invalid');
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
