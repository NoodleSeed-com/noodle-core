import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { ConfigLocation } from '../config.js';
import { readConfig, writeConfig } from '../config.js';
import { serviceJson } from '../control-plane.js';

export function findDeployProjectRoot(cwd: string = process.cwd()): string | undefined {
  let current = resolve(cwd);
  while (true) {
    if (
      existsSync(join(current, 'noodle.json')) ||
      existsSync(join(current, '.noodle', 'project.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Whether an implicit `local` org is safe for this loopback-only control plane. */
export function isLocalServiceUrl(serviceUrl: string): boolean {
  try {
    const host = new URL(serviceUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export function deployTargetLabel(input: {
  readonly org: string | undefined;
  readonly app: string | undefined;
  readonly env: string | undefined;
  readonly manifestPath: string;
}): string {
  return `${input.org ?? 'local'}/${input.app ?? basename(input.manifestPath, extname(input.manifestPath))}/${input.env ?? 'prod'}`;
}

/**
 * The server versions this org/app/env already runs, newest listing order preserved. Feeds the
 * first-deploy version rule in `deploy-version-resolution.ts` (#703): an app with no deployments is
 * brand new and starts at `1`. Reads the long-shipped unwrapped deployments collection; the caller
 * treats a throw as "unknown" and falls back to prompting, so this must never be load-bearing.
 */
export async function listDeployedServerVersions(input: {
  readonly serviceUrl: string;
  readonly token: string | undefined;
  readonly org: string;
  readonly app: string;
  readonly env: string;
}): Promise<readonly string[]> {
  const url = new URL(`${input.serviceUrl}/v1/orgs/${encodeURIComponent(input.org)}/deployments`);
  url.searchParams.set('app', input.app);
  url.searchParams.set('env', input.env);
  const body = await serviceJson<DeploymentsListBody>(url.toString(), input.token);
  return body.deployments
    .map((deployment) => deployment.serverVersion)
    .filter((version): version is string => version !== undefined);
}

interface DeploymentsListBody {
  readonly ok: true;
  readonly deployments: readonly { readonly serverVersion?: string }[];
}

interface DeployWhoamiBody {
  readonly ok: true;
  readonly identity: {
    readonly subject: string;
    readonly email: string;
    readonly superAdmin: boolean;
  };
  readonly orgs: readonly { readonly slug: string }[];
}

export async function refreshDeployDefaultOrg(input: {
  readonly serviceUrl: string;
  readonly token: string;
  readonly home: ConfigLocation;
  readonly fallback?: string;
  readonly persist?: boolean;
}): Promise<string | undefined> {
  try {
    const body = await serviceJson<DeployWhoamiBody>(`${input.serviceUrl}/v1/whoami`, input.token);
    const defaultOrg =
      body.identity.superAdmin === false ? (body.orgs[0]?.slug ?? input.fallback) : input.fallback;
    const config = readConfig(input.home);
    if (input.persist !== false)
      writeConfig(
        {
          ...config,
          identity: {
            subject: body.identity.subject,
            email: body.identity.email,
          },
          ...(defaultOrg !== undefined ? { defaultOrg } : {}),
        },
        input.home,
      );
    return defaultOrg;
  } catch {
    return input.fallback;
  }
}
