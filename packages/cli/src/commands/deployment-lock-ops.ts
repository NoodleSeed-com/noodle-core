import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { confirm } from '../prompts.js';
import { normalizeCommandServerVersion } from './deploy-version-resolution.js';
import { EXIT, printJsonOk } from './output.js';
import {
  type CliFailure,
  parseTenantCommandArgs,
  printCliFailure,
  resolveTenantTarget,
  serviceFailure,
} from './shared.js';

type LockAction = 'lock' | 'unlock';

interface DeploymentStatusResponse {
  readonly ok: true;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
  readonly deployment: {
    readonly deploymentId: string;
    readonly endpointUrl: string;
    readonly serverVersion?: string;
    readonly deploymentLock?: { readonly lockedAt: string; readonly lockedByEmail?: string };
  };
}

interface DeploymentLockResponse {
  readonly ok: true;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
  readonly deployment: {
    readonly deploymentId: string;
    readonly serverVersion: string;
    readonly locked: boolean;
    readonly deploymentLock?: { readonly lockedAt: string; readonly lockedByEmail?: string };
  };
  readonly changed: boolean;
  readonly auditRecorded: boolean;
}

export async function runDeploymentLockUpdate(
  action: LockAction,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const yes = rest.includes('--yes');
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('deployments', target.error, args.json);
  if (args.serverVersion === undefined) {
    return printCliFailure(
      'deployments',
      {
        code: 'usage_error',
        message: `${action} requires --version`,
        cause: 'A lock belongs to one exact deployed server version.',
        fix: 'Pass the version shown by noodle deployments list.',
        next: `noodle deployments ${action} --version <version>`,
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }
  const serverVersion = normalizeCommandServerVersion(
    `deployments ${action}`,
    args.serverVersion,
    args.json,
  );
  if (!serverVersion.ok || serverVersion.value === undefined) {
    return serverVersion.ok ? EXIT.USAGE : serverVersion.exitCode;
  }

  if (action === 'unlock' && !yes && !isInteractive(args.json)) {
    return printCliFailure(
      'deployments',
      confirmationRequired(target, serverVersion.value),
      args.json,
    );
  }

  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(
      'deployments',
      {
        code: 'auth_required',
        message: 'No control-plane login token is available.',
        cause: 'Hosted deployment locks require an authenticated organization owner.',
        fix: 'Sign in to the target service.',
        next: 'noodle login',
        exitCode: EXIT.AUTH,
      },
      args.json,
    );
  }

  try {
    const path =
      `/v1/orgs/${encodeURIComponent(target.org)}/apps/${encodeURIComponent(target.app)}` +
      `/envs/${encodeURIComponent(target.env)}`;
    const status = await serviceJson<DeploymentStatusResponse>(
      `${resolved.serviceUrl}${path}/status?version=${encodeURIComponent(serverVersion.value)}`,
      resolved.token,
    );
    if (action === 'unlock' && !yes) {
      const accepted = await confirm(
        `Unlock ${target.org}/${target.app}/${target.env} version ${serverVersion.value}? ` +
          `Deployment ${status.deployment.deploymentId} at ${status.deployment.endpointUrl} can be changed again.`,
        { initial: false },
      );
      if (!accepted) {
        console.error('deployments unlock: cancelled');
        return EXIT.USAGE;
      }
    }
    const body = await serviceJson<DeploymentLockResponse>(
      `${resolved.serviceUrl}${path}/deployment-lock`,
      resolved.token,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          serverVersion: serverVersion.value,
          expectedDeploymentId: status.deployment.deploymentId,
          locked: action === 'lock',
        }),
      },
    );
    if (args.json) {
      printJsonOk({ ...body, service: resolved.serviceUrl });
      return EXIT.OK;
    }
    console.log(`service:  ${resolved.serviceUrl}`);
    console.log(`target:   ${body.target.org}/${body.target.app}/${body.target.env}`);
    console.log(`deploy:   ${body.deployment.deploymentId}`);
    console.log(`version:  ${body.deployment.serverVersion}`);
    console.log(`locked:   ${body.deployment.locked ? 'yes' : 'no'}`);
    console.log(`changed:  ${body.changed ? 'yes' : 'no'}`);
    if (!body.auditRecorded) {
      console.error('warning: the lock changed, but its audit record could not be saved');
    }
    if (body.deployment.locked) {
      console.log(
        `Next:     noodle deployments unlock --version ${body.deployment.serverVersion} --yes`,
      );
    } else {
      console.log(`Next:     noodle deploy --version ${body.deployment.serverVersion}`);
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure('deployments', lockServiceFailure(action, error), args.json);
  }
}

function isInteractive(json: boolean): boolean {
  return !json && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function confirmationRequired(
  target: { readonly org: string; readonly app: string; readonly env: string },
  serverVersion: string,
): CliFailure {
  return {
    code: 'confirmation_required',
    message: 'unlock requires confirmation',
    cause: 'Unlocking permits deployments and rollback pointer changes against this version again.',
    fix: 'Re-run with --yes to confirm non-interactively.',
    next:
      `noodle deployments unlock --org ${target.org} --app ${target.app}` +
      ` --env ${target.env} --version ${serverVersion} --yes`,
    exitCode: EXIT.USAGE,
  };
}

function lockServiceFailure(action: LockAction, error: unknown): CliFailure {
  if (
    error instanceof ServiceRequestError &&
    error.status === 403 &&
    error.code === 'organization_owner_required'
  ) {
    return {
      code: error.code,
      message: error.message,
      cause: 'Only an organization owner can lock or unlock a deployed server version.',
      fix: 'Ask an organization owner to make this change or sign in with an owner account.',
      next: 'noodle whoami',
      exitCode: EXIT.AUTH,
    };
  }
  return serviceFailure('deployments', error, `noodle deployments ${action} --version <version>`);
}
