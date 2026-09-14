import {
  type DeploymentDeleteResponse,
  deploymentDeleteClientResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { confirm as confirmPrompt, isInteractive as detectInteractive } from '../prompts.js';
import { normalizeCommandServerVersion } from './deploy-version-resolution.js';
import {
  deleteEvidenceMismatch,
  deleteServiceFailure,
  versionDeleteCommand,
} from './deployment-delete-recovery.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type DeploymentsListResponse, resolveOrgTarget } from './resource-shared.js';
import {
  type CliFailure,
  parseCommandFlags,
  printCliFailure,
  resolveTenantTarget,
  usageError,
} from './shared.js';

type DeleteAction = 'delete' | 'delete-version';

interface DeletePrompts {
  readonly isInteractive: () => boolean;
  readonly confirm: (message: string, options?: { readonly initial?: boolean }) => Promise<boolean>;
}

const DEFAULT_PROMPTS: DeletePrompts = {
  isInteractive: detectInteractive,
  confirm: confirmPrompt,
};

interface DeleteArgs {
  readonly positional: readonly string[];
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly yes: boolean;
  readonly parseError?: string;
}

/** Permanent hosted deployment deletion; all mutations go through the tenant-scoped service API. */
export async function runDeploymentDelete(
  action: DeleteAction,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  prompts: DeletePrompts = DEFAULT_PROMPTS,
): Promise<number> {
  const args = parseDeleteArgs(action, rest);
  const usageFailure = validateDeleteArgs(action, args);
  if (usageFailure !== undefined) {
    return printCliFailure(`deployments ${action}`, usageFailure, args.json);
  }
  return action === 'delete'
    ? deleteDeployment(args, env, home, prompts)
    : deleteVersion(args, env, home, prompts);
}

function parseDeleteArgs(action: DeleteAction, rest: readonly string[]): DeleteArgs {
  const parsed = parseCommandFlags(rest, {
    values:
      action === 'delete'
        ? { '--org': 'org', '--service': 'service', '--auth-token': 'authToken' }
        : {
            '--org': 'org',
            '--app': 'app',
            '--env': 'targetEnv',
            '--service': 'service',
            '--auth-token': 'authToken',
          },
    booleans: { '--json': 'json', '--yes': 'yes' },
  });
  return parsed;
}

function validateDeleteArgs(action: DeleteAction, args: DeleteArgs): CliFailure | undefined {
  const label = action === 'delete' ? 'deployment id' : 'version or legacy';
  const usage =
    action === 'delete'
      ? 'noodle deployments delete <deployment-id> --org <org> --yes'
      : 'noodle deployments delete-version <version|legacy> --org <org> --app <app> --env <env> --yes';
  if (args.parseError !== undefined) return usageError(args.parseError, usage);
  if (args.positional.length !== 1) {
    return usageError(`deployments ${action} requires exactly one ${label}`, usage);
  }
  return undefined;
}

async function deleteDeployment(
  args: DeleteArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  prompts: DeletePrompts,
): Promise<number> {
  const deploymentId = args.positional[0] as string;
  const target = resolveOrgTarget(args.org, home);
  if (!target.ok) return printCliFailure('deployments delete', target.error, args.json);
  if (!args.yes) {
    const warning =
      `Permanently delete deployment ${deploymentId} from ${target.org}? ` +
      'Only an inactive deployment can be deleted. This cannot be undone.';
    if (args.json || !prompts.isInteractive()) {
      return printCliFailure(
        'deployments delete',
        confirmationRequired(
          'delete',
          warning,
          `noodle deployments delete ${deploymentId} --org ${target.org} --yes`,
        ),
        args.json,
      );
    }
    if (!(await prompts.confirm(warning, { initial: false }))) {
      console.error('deployments delete: cancelled');
      return EXIT.USAGE;
    }
  }

  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('deployments delete', authRequired(), args.json);
  }
  try {
    const response = deploymentDeleteClientResponseSchema.parse(
      await serviceJson<unknown>(
        `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
          `/deployments/${encodeURIComponent(deploymentId)}`,
        resolved.token,
        { method: 'DELETE' },
      ),
    );
    const evidenceFailure = deleteEvidenceMismatch(response, {
      kind: 'deployment',
      org: target.org,
      deploymentId,
    });
    if (evidenceFailure !== undefined) {
      return printCliFailure('deployments delete', evidenceFailure, args.json);
    }
    return printDeleteResult(response, resolved.serviceUrl, args.json);
  } catch (error) {
    return printCliFailure(
      'deployments delete',
      deleteServiceFailure(error, {
        action: 'delete',
        org: target.org,
        deploymentId,
      }),
      args.json,
    );
  }
}

async function deleteVersion(
  args: DeleteArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  prompts: DeletePrompts,
): Promise<number> {
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('deployments delete-version', target.error, args.json);
  const requested = args.positional[0] as string;
  const version = exactDeleteVersion(requested, args.json);
  if (!version.ok) return version.exitCode;

  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('deployments delete-version', authRequired(), args.json);
  }

  try {
    const inventoryUrl = new URL(
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}/deployments`,
    );
    inventoryUrl.searchParams.set('app', target.app);
    inventoryUrl.searchParams.set('env', target.env);
    inventoryUrl.searchParams.set('archived', 'true');
    const inventory = await serviceJson<DeploymentsListResponse>(
      inventoryUrl.toString(),
      resolved.token,
    );
    const expectedDeploymentIds = inventory.deployments
      .filter((deployment) =>
        version.value === 'legacy'
          ? deployment.serverVersion === undefined
          : deployment.serverVersion === version.value,
      )
      .map((deployment) => deployment.deploymentId);
    if (expectedDeploymentIds.length === 0) {
      return printCliFailure(
        'deployments delete-version',
        versionNotFound(target, version.value),
        args.json,
      );
    }
    if (expectedDeploymentIds.length > 10000) {
      return printCliFailure(
        'deployments delete-version',
        {
          code: 'deployment_inventory_too_large',
          message: 'The version has more than 10,000 deployment records.',
          cause: 'The deletion contract cannot bind an inventory larger than 10,000 records.',
          fix: 'Contact Noodle Seed support before attempting permanent deletion.',
          next: `noodle deployments list --org ${target.org} --app ${target.app} --env ${target.env}`,
          exitCode: EXIT.FAILURE,
        },
        args.json,
      );
    }

    const warning = versionDeleteWarning(target, version.value, expectedDeploymentIds.length);
    if (!args.yes) {
      if (args.json || !prompts.isInteractive()) {
        return printCliFailure(
          'deployments delete-version',
          confirmationRequired(
            'delete-version',
            warning,
            versionDeleteCommand(target, version.value, true),
          ),
          args.json,
        );
      }
      if (!(await prompts.confirm(warning, { initial: false }))) {
        console.error('deployments delete-version: cancelled');
        return EXIT.USAGE;
      }
    }

    const endpoint =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}` +
      `/versions/${encodeURIComponent(version.value)}`;
    const response = deploymentDeleteClientResponseSchema.parse(
      await serviceJson<unknown>(endpoint, resolved.token, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedDeploymentIds }),
      }),
    );
    const evidenceFailure = deleteEvidenceMismatch(response, {
      kind: 'version',
      target,
      expectedDeploymentIds,
    });
    if (evidenceFailure !== undefined) {
      return printCliFailure('deployments delete-version', evidenceFailure, args.json);
    }
    return printDeleteResult(response, resolved.serviceUrl, args.json, version.value);
  } catch (error) {
    return printCliFailure(
      'deployments delete-version',
      deleteServiceFailure(error, {
        action: 'delete-version',
        org: target.org,
        app: target.app,
        env: target.env,
        version: version.value,
      }),
      args.json,
    );
  }
}

function exactDeleteVersion(
  requested: string,
  json: boolean,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly exitCode: number } {
  if (requested === 'legacy') return { ok: true, value: requested };
  const normalized = normalizeCommandServerVersion('deployments delete-version', requested, json);
  if (!normalized.ok || normalized.value === undefined) {
    return { ok: false, exitCode: normalized.ok ? EXIT.USAGE : normalized.exitCode };
  }
  return { ok: true, value: normalized.value };
}

function versionDeleteWarning(
  target: { readonly org: string; readonly app: string; readonly env: string },
  version: string,
  count: number,
): string {
  const outage =
    version === 'legacy'
      ? 'Its deployment URLs stop working immediately.'
      : "Deleting it takes the version's pinned URL offline immediately.";
  return (
    `Permanently delete ${target.org}/${target.app}/${target.env} version ${version} and ` +
    `${count} deployment ${count === 1 ? 'record' : 'records'}? ` +
    `${outage} This cannot be undone.`
  );
}

function confirmationRequired(action: DeleteAction, warning: string, next: string): CliFailure {
  return {
    code: 'confirmation_required',
    message: `deployments ${action} requires confirmation`,
    cause: warning,
    fix: 'Review the permanent deletion target, then re-run with --yes.',
    next,
    exitCode: EXIT.USAGE,
  };
}

function versionNotFound(
  target: { readonly org: string; readonly app: string; readonly env: string },
  version: string,
): CliFailure {
  return {
    code: 'version_not_found',
    message: `Version ${version} was not found.`,
    cause: `${target.org}/${target.app}/${target.env} has no deployment records for exact version ${version}.`,
    fix: 'Check the exact version or use legacy for unversioned deployment records.',
    next: `noodle deployments list --org ${target.org} --app ${target.app} --env ${target.env}`,
    exitCode: EXIT.FAILURE,
  };
}

function printDeleteResult(
  response: DeploymentDeleteResponse,
  service: string,
  json: boolean,
  version?: string,
): number {
  if (json) {
    printJsonOk({ service, ...(version === undefined ? {} : { version }), ...response });
    return EXIT.OK;
  }
  console.log(`service:  ${service}`);
  console.log(`target:   ${response.target.org}/${response.target.app}/${response.target.env}`);
  if (version !== undefined) console.log(`version:  ${version}`);
  console.log(`deleted:  ${response.deletedDeploymentIds.length}`);
  for (const deploymentId of response.deletedDeploymentIds) console.log(`  ${deploymentId}`);
  if (!response.auditRecorded) {
    console.error('warning: deletion completed, but its audit record could not be saved');
  }
  return EXIT.OK;
}
