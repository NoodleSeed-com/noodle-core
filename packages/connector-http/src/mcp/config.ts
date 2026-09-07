import { ConnectorInvocationError } from '@noodle-borg/runtime';

const VARIABLE = /^\$\{env\.([A-Za-z0-9_]+)\}$/;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const DEFAULT_RESPONSE_BYTES = 1 << 20;

export function isVariable(value: string): boolean {
  return VARIABLE.test(value);
}

export function resolveManagedString(
  configured: string,
  env: Readonly<Record<string, string>>,
): string {
  const match = VARIABLE.exec(configured);
  if (match === null) return configured;
  const name = match[1] as string;
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new ConnectorInvocationError(`managed variable "${name}" is unavailable`, {
      category: 'invalid_response',
      retryable: false,
    });
  }
  return value;
}

export function responseLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RESPONSE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESPONSE_BYTES) {
    throw new ConnectorInvocationError('invalid MCP response size limit', {
      category: 'invalid_response',
      retryable: false,
    });
  }
  return limit;
}

export function parsedEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorInvocationError('upstream MCP endpoint is not a valid URL', {
      category: 'invalid_response',
      retryable: false,
    });
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new ConnectorInvocationError('upstream MCP endpoint contains forbidden URL components', {
      category: 'invalid_response',
      retryable: false,
    });
  }
  if (!isSecureOrLoopback(url)) {
    throw new ConnectorInvocationError('upstream MCP endpoint must use HTTPS', {
      category: 'invalid_response',
      retryable: false,
    });
  }
  return url;
}

export function configuredOrigins(
  configured: readonly string[],
  env: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of configured) {
    const resolved = resolveManagedString(entry, env);
    const url = parsedEndpoint(resolved);
    if (isVariable(entry) && url.origin !== resolved) {
      throw new ConnectorInvocationError(
        'managed MCP egress origin must resolve to a canonical bare origin',
        { category: 'invalid_response', retryable: false },
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

function isSecureOrLoopback(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}
