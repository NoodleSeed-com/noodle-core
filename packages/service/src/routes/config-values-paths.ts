import {
  type ConfigScope,
  type ManagedConfigKind,
  validateConfigName,
  validateConfigScope,
} from '../store.js';

export interface ConfigRouteRef {
  readonly kind: ManagedConfigKind;
  readonly scope: ConfigScope;
  readonly name?: string;
  readonly effective?: boolean;
  readonly reveal?: boolean;
  readonly invalid?: string;
}

export function parseConfigPath(
  pathname: string,
  searchParams?: URLSearchParams,
): ConfigRouteRef | undefined {
  const kindPattern = '(secrets|variables)';
  const reveal =
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/secrets\/([^/]+)\/reveal$/.exec(pathname);
  if (reveal) {
    return encodedConfigRouteRef(
      'secret',
      {
        level: 'env',
        org: reveal[1] as string,
        app: reveal[2] as string,
        env: reveal[3] as string,
      },
      reveal[4],
      undefined,
      true,
    );
  }
  const org = new RegExp(`^/v1/orgs/([^/]+)/${kindPattern}(?:/([^/]+))?$`).exec(pathname);
  if (org) {
    return encodedConfigRouteRef(
      org[2] === 'secrets' ? 'secret' : 'variable',
      { level: 'org', org: org[1] as string },
      org[3],
      searchParams,
    );
  }
  const app = new RegExp(`^/v1/orgs/([^/]+)/apps/([^/]+)/${kindPattern}(?:/([^/]+))?$`).exec(
    pathname,
  );
  if (app) {
    return encodedConfigRouteRef(
      app[3] === 'secrets' ? 'secret' : 'variable',
      {
        level: 'app',
        org: app[1] as string,
        app: app[2] as string,
      },
      app[4],
      searchParams,
    );
  }
  const env = new RegExp(
    `^/v1/orgs/([^/]+)/apps/([^/]+)/envs/([^/]+)/${kindPattern}(?:/([^/]+))?$`,
  ).exec(pathname);
  if (!env) return undefined;
  return encodedConfigRouteRef(
    env[4] === 'secrets' ? 'secret' : 'variable',
    {
      level: 'env',
      org: env[1] as string,
      app: env[2] as string,
      env: env[3] as string,
    },
    env[5],
    searchParams,
  );
}

function encodedConfigRouteRef(
  kind: ManagedConfigKind,
  encodedScope: ConfigScope,
  encodedName: string | undefined,
  searchParams?: URLSearchParams,
  reveal = false,
): ConfigRouteRef | undefined {
  try {
    const scope: ConfigScope =
      encodedScope.level === 'org'
        ? { level: 'org', org: decodeURIComponent(encodedScope.org) }
        : encodedScope.level === 'app'
          ? {
              level: 'app',
              org: decodeURIComponent(encodedScope.org),
              app: decodeURIComponent(encodedScope.app),
            }
          : {
              level: 'env',
              org: decodeURIComponent(encodedScope.org),
              app: decodeURIComponent(encodedScope.app),
              env: decodeURIComponent(encodedScope.env),
            };
    return configRouteRef(kind, scope, encodedName, searchParams, reveal);
  } catch {
    return invalidConfigRouteRef(kind, encodedName, reveal);
  }
}

function configRouteRef(
  kind: ManagedConfigKind,
  scope: ConfigScope,
  encodedName: string | undefined,
  searchParams?: URLSearchParams,
  reveal = false,
): ConfigRouteRef | undefined {
  let safeScope: ConfigScope;
  try {
    safeScope = validateConfigScope(scope);
  } catch {
    return invalidConfigRouteRef(kind, encodedName, reveal);
  }
  try {
    const name =
      encodedName !== undefined ? validateConfigName(decodeURIComponent(encodedName)) : undefined;
    return {
      kind,
      scope: safeScope,
      ...(name !== undefined ? { name } : {}),
      ...(searchParams?.get('view') === 'effective' ? { effective: true } : {}),
      ...(reveal ? { reveal: true } : {}),
    };
  } catch {
    return invalidConfigRouteRef(kind, encodedName, reveal, safeScope);
  }
}

function invalidConfigRouteRef(
  kind: ManagedConfigKind,
  encodedName: string | undefined,
  reveal: boolean,
  scope: ConfigScope = { level: 'org', org: '__invalid__' },
): ConfigRouteRef {
  return {
    kind,
    scope,
    ...(encodedName !== undefined ? { name: '__invalid__' } : {}),
    ...(reveal ? { reveal: true } : {}),
    invalid: 'invalid config scope or name',
  };
}
