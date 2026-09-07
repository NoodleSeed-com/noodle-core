import { homedir } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';
import { isTenantSlug } from '@noodle-borg/module';
import { type ConfigLocation, readConfig } from './config.js';
import { slug } from './deploy.js';
import { readNoodleProjectConfig, readProjectLink } from './project.js';

export interface EffectiveLocalTarget {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

type EffectiveLocalTargetSource = 'explicit' | 'link' | 'project' | 'local-default';

export interface EffectiveLocalTargetResolution {
  readonly target: EffectiveLocalTarget;
  readonly mode: 'linked' | 'unlinked';
  readonly sources: {
    readonly org: EffectiveLocalTargetSource;
    readonly app: EffectiveLocalTargetSource;
    readonly env: EffectiveLocalTargetSource;
  };
  readonly ignoredSavedTarget: boolean;
}

export interface EffectiveLocalTargetOptions {
  readonly org?: string;
  readonly app?: string;
  readonly env?: string;
  readonly manifestPath?: string;
  readonly cwd?: string;
  readonly home?: ConfigLocation;
}

export const UNLINKED_LOCAL_TARGET_HINT =
  'Saved global target ignored for this unlinked local project. Run `noodle link` to mirror a deployed app.';

export function localTargetDisplay(resolution: EffectiveLocalTargetResolution): string {
  const { org, app, env } = resolution.target;
  const mode = resolution.mode === 'linked' ? 'project link' : 'unlinked project';
  return `${org}/${app}/${env} (${mode})`;
}

/** Resolve one tenant identity for every local authoring and managed-config command. */
export function resolveEffectiveLocalTarget(
  options: EffectiveLocalTargetOptions = {},
): EffectiveLocalTargetResolution {
  const cwd = options.cwd ?? process.cwd();
  const link = readProjectLink(cwd);
  const project = readNoodleProjectConfig(cwd);
  const config = readConfig(options.home ?? homedir());
  const mode = link === undefined ? 'unlinked' : 'linked';
  const orgValue = options.org ?? link?.org ?? 'local';
  const appValue =
    options.app ??
    link?.app ??
    project?.app ??
    project?.name ??
    defaultLocalApp(options.manifestPath, cwd);
  const envValue = options.env ?? link?.env ?? 'dev';
  return {
    target: { org: slug(orgValue), app: slug(appValue), env: slug(envValue) },
    mode,
    sources: {
      org: options.org !== undefined ? 'explicit' : link !== undefined ? 'link' : 'local-default',
      app:
        options.app !== undefined
          ? 'explicit'
          : link !== undefined
            ? 'link'
            : project?.app !== undefined || project?.name !== undefined
              ? 'project'
              : 'local-default',
      env: options.env !== undefined ? 'explicit' : link !== undefined ? 'link' : 'local-default',
    },
    ignoredSavedTarget:
      link === undefined &&
      (config.defaultOrg !== undefined ||
        config.defaultApp !== undefined ||
        config.defaultEnv !== undefined),
  };
}

function defaultLocalApp(manifestPath: string | undefined, cwd: string): string {
  if (manifestPath === undefined) return basename(resolve(cwd));
  const base = basename(manifestPath, extname(manifestPath));
  let inferred = base;
  if (base === 'manifest' || base === 'server' || base === 'index') {
    const dir = dirname(resolve(manifestPath));
    inferred = basename(basename(dir) === 'src' ? dirname(dir) : dir);
  }
  if (isTenantSlug(slug(inferred))) return inferred;
  // A routing folder such as `mcp/` is a reasonable project layout but an invalid tenant identity.
  // Only derived names reach this fallback; explicit link/project/flag values remain authoritative.
  const project = basename(resolve(cwd));
  return isTenantSlug(slug(project)) ? project : inferred;
}
