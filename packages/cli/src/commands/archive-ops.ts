import type { ConfigLocation } from '../config.js';
/**
 * App soft-delete operations (ADR 0117): `noodle archive <app>` and `noodle restore <app>`.
 * Archive always applies to the whole app — every environment and server version — so there is no
 * `--env` flag. The service gates both on org-owner identity, hides archived apps from the default
 * deployments list, serves their MCP endpoints as 410 Gone, and hard-deletes them after the
 * retention window (default 30 days); `restore` undoes the archive within that window.
 */
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { confirm } from '../prompts.js';
import { printJsonOk } from './output.js';
import {
  type CliFailure,
  parseCommandFlags,
  printCliFailure,
  resolveTenantTarget,
  serviceFailure,
} from './shared.js';

interface AppCommandArgs {
  readonly app?: string;
  readonly org?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly yes: boolean;
  readonly failure?: CliFailure;
}

function parseAppCommandArgs(
  command: 'archive' | 'restore',
  rest: readonly string[],
): AppCommandArgs {
  const {
    positional,
    flagApp,
    env: _env,
    parseError,
    ...args
  } = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--app': 'flagApp',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--env': 'env',
    },
    booleans: { '--json': 'json', '--yes': 'yes' },
  });
  const unsupportedEnv = rest.includes('--env');
  const unknownOption = parseError?.startsWith('unknown option: ')
    ? parseError.slice('unknown option: '.length)
    : undefined;
  const failure: CliFailure | undefined = unsupportedEnv
    ? {
        code: 'usage_error',
        message: `${command} applies to the whole app; --env is not supported`,
        cause: `${command === 'archive' ? 'Archiving' : 'Restoring'} always covers every environment of the app.`,
        fix: 'Drop the --env flag.',
        next: `noodle ${command} <app> --org <org>`,
        exitCode: 2,
      }
    : unknownOption === undefined
      ? undefined
      : {
          code: 'usage_error',
          message: `unknown ${command} option ${unknownOption}`,
          cause: `${unknownOption} is not a supported ${command} option.`,
          fix: `Remove the unknown option or use a supported ${command} flag.`,
          next: `noodle ${command} <app> --org <org>`,
          exitCode: 2,
        };
  const app = positional[0] ?? flagApp;
  return {
    ...args,
    ...(app !== undefined ? { app } : {}),
    ...(failure !== undefined ? { failure } : {}),
  };
}

function authRequired(command: 'archive' | 'restore'): CliFailure {
  return {
    code: 'auth_required',
    message: 'No control-plane login token is available.',
    cause: `Hosted ${command} requires an authenticated Noodle Seed Cloud identity.`,
    fix: 'Sign in to the target service.',
    next: 'noodle login',
    exitCode: 3,
  };
}

export async function runArchive(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseAppCommandArgs('archive', rest);
  if (args.failure !== undefined) return printCliFailure('archive', args.failure, args.json);
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('archive', target.error, args.json);
  if (!args.yes) {
    const interactive = !args.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) {
      return printCliFailure(
        'archive',
        {
          code: 'confirmation_required',
          message: 'archive requires confirmation',
          cause:
            'Archiving stops serving every environment of the app (410 Gone) and schedules permanent deletion after the retention window.',
          fix: 'Re-run with --yes to confirm non-interactively.',
          next: `noodle archive ${target.app} --org ${target.org} --yes`,
          exitCode: 2,
        },
        args.json,
      );
    }
    const confirmed = await confirm(
      `Archive ${target.org}/${target.app}? Every environment stops serving (410 Gone); it is permanently deleted after the retention window (default 30 days) unless restored.`,
      { initial: false },
    );
    if (!confirmed) {
      console.error('archive: cancelled');
      return 2;
    }
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('archive', authRequired('archive'), args.json);
  }
  try {
    const body = await serviceJson<{
      ok: true;
      target: { org: string; app: string };
      archive: { archivedAt: string; archivedDeployments: number; alreadyArchived: boolean };
    }>(
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
        `/apps/${encodeURIComponent(target.app)}/archive`,
      resolved.token,
      { method: 'POST' },
    );
    if (args.json) {
      printJsonOk({
        target: body.target,
        archive: body.archive,
        service: resolved.serviceUrl,
      });
      return 0;
    }
    console.log(`service: ${resolved.serviceUrl}`);
    console.log(`target:  ${target.org}/${target.app}`);
    console.log(
      `archived: ${body.archive.archivedAt}${body.archive.alreadyArchived ? ' (already archived)' : ''}`,
    );
    console.log(`deployments archived: ${body.archive.archivedDeployments}`);
    console.log('Endpoints now answer 410 Gone; secrets and variables are retained but inert.');
    console.log(`Next:    noodle restore ${target.app} --org ${target.org}`);
    return 0;
  } catch (error) {
    return printCliFailure(
      'archive',
      serviceFailure('archive', error, 'noodle deployments list --archived'),
      args.json,
    );
  }
}

export async function runRestore(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseAppCommandArgs('restore', rest);
  if (args.failure !== undefined) return printCliFailure('restore', args.failure, args.json);
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('restore', target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('restore', authRequired('restore'), args.json);
  }
  try {
    const body = await serviceJson<{
      ok: true;
      target: { org: string; app: string };
      restore: { restoredDeployments: number; alreadyActive: boolean };
    }>(
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
        `/apps/${encodeURIComponent(target.app)}/restore`,
      resolved.token,
      { method: 'POST' },
    );
    if (args.json) {
      printJsonOk({
        target: body.target,
        restore: body.restore,
        service: resolved.serviceUrl,
      });
      return 0;
    }
    console.log(`service: ${resolved.serviceUrl}`);
    console.log(`target:  ${target.org}/${target.app}`);
    console.log(
      body.restore.alreadyActive
        ? 'status:  already active (nothing was archived)'
        : `restored deployments: ${body.restore.restoredDeployments}`,
    );
    console.log(`Next:    noodle status --org ${target.org} --app ${target.app}`);
    return 0;
  } catch (error) {
    return printCliFailure(
      'restore',
      serviceFailure('restore', error, `noodle billing org inspect ${target.org}`),
      args.json,
    );
  }
}
