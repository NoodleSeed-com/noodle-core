// Extracted verbatim from credential-broker.ts (size-gate split): OAuth2 / custom-profile
// client-credentials token fetchers and their response-shape helpers.
import type {
  ClientCredentialsBinding,
  ClientCredentialsCustomBinding,
} from '@noodle-borg/connector-defs';

export async function fetchOAuth2ClientCredentials(
  binding: ClientCredentialsBinding,
  clientSecret: string,
): Promise<{ token: string; expiresAt: number }> {
  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  if (binding.scopes !== undefined && binding.scopes.length > 0) {
    params.set('scope', binding.scopes.join(' '));
  }
  if (binding.audience !== undefined) params.set('audience', binding.audience);

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'noodle-borg/0.0',
  };
  if (binding.authMethod === 'client_secret_post') {
    params.set('client_id', binding.clientId);
    params.set('client_secret', clientSecret);
  } else {
    headers.authorization = `Basic ${Buffer.from(`${binding.clientId}:${clientSecret}`).toString('base64')}`;
  }

  const response = await fetch(binding.tokenUrl, {
    method: 'POST',
    headers,
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OAuth2 token endpoint failed with status ${response.status}`);
  const json = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
    throw new Error('OAuth2 token endpoint response did not include access_token');
  }
  const expiresIn =
    typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 300;
  const skewedMs = Math.max(1, expiresIn - 60) * 1000;
  return { token: json.access_token, expiresAt: Date.now() + skewedMs };
}

/** Resolve a dotted path (e.g. `data.accessToken`) against a parsed JSON body; `undefined` if absent. */
function resolveJsonPath(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, body);
}

/** Decode a JWT's `exp` claim as an ms epoch, or `undefined` if the token is not a readable JWT. */
function jwtExpiryMs(jwt: string): number | undefined {
  const segment = jwt.split('.')[1];
  if (segment === undefined) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function pickPositiveNumber(
  body: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function pickDateMs(body: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Exchange a client id + secret at a *non-standard* token endpoint (`profile: 'custom'`), described by
 * a {@link ClientCredentialsCustomBinding}. Sends the credentials in a JSON or form body under the
 * declared field names, reads the access token at the declared response path, and derives expiry from
 * the ordered `expirySource` (JWT `exp`, an `expires_in`/`expiresIn` seconds field, or an
 * `expires_at`/`expiresAt` timestamp), falling back to `fallbackTtlSeconds`. Never logs the body.
 */
export async function fetchCustomClientCredentials(
  binding: ClientCredentialsBinding,
  custom: ClientCredentialsCustomBinding,
  clientSecret: string,
): Promise<{ token: string; expiresAt: number }> {
  const fields: Record<string, string> = {
    [custom.clientIdField]: binding.clientId,
    [custom.clientSecretField]: clientSecret,
  };
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'noodle-borg/0.0',
  };
  let body: string;
  if (custom.requestFormat === 'form') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(fields).toString();
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(fields);
  }

  const response = await fetch(binding.tokenUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`client-credentials token endpoint failed with status ${response.status}`);
  }
  const json = (await response.json()) as unknown;
  const token = resolveJsonPath(json, custom.tokenResponsePath);
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `client-credentials token endpoint response had no token at "${custom.tokenResponsePath}"`,
    );
  }
  const now = Date.now();
  const bodyObj =
    json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  let expiresAtMs: number | undefined;
  for (const source of custom.expirySource) {
    if (source === 'jwt') expiresAtMs = jwtExpiryMs(token);
    else if (source === 'expiresIn') {
      const seconds = pickPositiveNumber(bodyObj, ['expires_in', 'expiresIn']);
      expiresAtMs = seconds !== undefined ? now + seconds * 1000 : undefined;
    } else {
      expiresAtMs = pickDateMs(bodyObj, ['expires_at', 'expiresAt']);
    }
    if (expiresAtMs !== undefined) break;
  }
  if (expiresAtMs === undefined) expiresAtMs = now + custom.fallbackTtlSeconds * 1000;
  return { token, expiresAt: Math.max(now + 1, expiresAtMs - 60_000) };
}
