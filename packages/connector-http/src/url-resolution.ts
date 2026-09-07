import { ConnectorInvocationError } from '@noodle-borg/runtime';

const VARIABLE_BASE_URL_RE = /^\$\{env\.([A-Za-z0-9_]+)\}$/;

export function isVariableBaseUrl(value: string): boolean {
  return VARIABLE_BASE_URL_RE.test(value);
}

export function resolveConfigString(value: string, env: Readonly<Record<string, unknown>>): string {
  const match = VARIABLE_BASE_URL_RE.exec(value);
  if (match?.[1] === undefined) return value;
  const resolved = env[match[1]];
  if (typeof resolved !== 'string') {
    throw new ConnectorInvocationError(`managed variable "${match[1]}" is not configured`, {
      category: 'invalid_response',
      retryable: false,
    });
  }
  return resolved;
}

export function joinBaseAndOperationPath(base: string, path: string): URL {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('//')) {
    return new URL(path, base);
  }
  const url = new URL(base);
  const parsedPath = new URL(path, 'http://noodle.local');
  const basePrefix = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const operationPath = parsedPath.pathname.replace(/^\/+/, '');
  url.pathname = operationPath === '' ? basePrefix || '/' : `${basePrefix}/${operationPath}`;
  url.search = parsedPath.search;
  return url;
}
