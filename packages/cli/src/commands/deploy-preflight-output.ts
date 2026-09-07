import { ServiceRequestError } from '../control-plane.js';
import { printRecovery } from '../diagnostics.js';
import { ProjectDotenvError } from '../project-dotenv.js';
import type { CanonicalDeployPreparationFailure } from './deploy-first-flow.js';
import { managedConfigSetCommand } from './deploy-output.js';
import {
  DeployOwnerMismatchError,
  DeployPreflightInputError,
  DeployPreflightRequestError,
  type HostedDeployTarget,
} from './deploy-preflight.js';
import { EXIT, type JsonError, printJsonFailure } from './output.js';

export function preflightBlocked(
  response: {
    readonly config: {
      readonly missingSecrets: readonly string[];
      readonly missingVariables: readonly string[];
    };
    readonly errors: readonly {
      readonly code: string;
      readonly path: string;
      readonly message: string;
    }[];
  },
  target: HostedDeployTarget,
  serverVersion: string,
  resumeCommand: string,
  json: boolean,
  silent: boolean,
): CanonicalDeployPreparationFailure {
  const missingSecrets = response.config.missingSecrets;
  const missingVariables = response.config.missingVariables;
  const configMissing = missingSecrets.length > 0 || missingVariables.length > 0;
  const actions = [
    ...missingVariables.map((name) => managedConfigSetCommand('variable', name, target)),
    ...missingSecrets.map((name) => managedConfigSetCommand('secret', name, target)),
  ];
  if (!configMissing || !configOnly(response.errors)) {
    const cause = response.errors.map((error) => error.message).join('; ') || 'preflight failed';
    const deploymentLocked = response.errors.some((error) => error.code === 'deployment_locked');
    const unlockCommand =
      `noodle deployments unlock --org ${target.org} --app ${target.app}` +
      ` --env ${target.env} --version ${serverVersion} --yes`;
    const error: JsonError = {
      code: deploymentLocked ? 'deployment_locked' : 'deploy_preflight_failed',
      message: cause,
      fix: deploymentLocked
        ? 'Unlock this server version before changing its deployed pointer.'
        : 'Fix every reported deploy input error before retrying.',
      next: deploymentLocked ? unlockCommand : 'noodle validate',
      errors: response.errors,
      detail: { target, missingSecrets, missingVariables, actions, resume: resumeCommand },
    };
    if (!silent) {
      if (json) printJsonFailure(error);
      else {
        printRecovery({
          command: 'deploy',
          cause,
          fix: error.fix as string,
          next: error.next as string,
        });
        for (const action of actions) console.error(`Also set: ${action}`);
      }
    }
    return { ok: false, exitCode: EXIT.FAILURE, error };
  }

  const onlySecrets = missingSecrets.length > 0 && missingVariables.length === 0;
  const onlyVariables = missingVariables.length > 0 && missingSecrets.length === 0;
  const code = onlySecrets
    ? 'missing_secret'
    : onlyVariables
      ? 'missing_variable'
      : 'missing_config';
  const message = onlySecrets
    ? `Missing required managed secret(s): ${missingSecrets.join(', ')}`
    : onlyVariables
      ? `Missing required managed variable(s): ${missingVariables.join(', ')}`
      : 'Required hosted variables and secrets are missing.';
  const fix = onlySecrets
    ? 'Set every missing secret at the environment scope, then rerun the same deploy command.'
    : onlyVariables
      ? 'Set every missing variable at the environment scope, then rerun the same deploy command.'
      : 'Set every listed variable and secret, then rerun the same deploy command.';
  const error: JsonError = {
    code,
    message,
    fix,
    next: actions[0] ?? resumeCommand,
    errors: response.errors,
    detail: {
      target,
      missingSecrets,
      missingVariables,
      actions,
      resume: resumeCommand,
    },
  };
  if (!silent) {
    if (json) printJsonFailure(error);
    else {
      printRecovery({
        command: 'deploy',
        cause: message,
        fix,
        next: actions[0] ?? resumeCommand,
      });
      for (const action of actions.slice(1)) console.error(`Also set: ${action}`);
      console.error(`Resume: ${resumeCommand}`);
    }
  }
  return { ok: false, exitCode: EXIT.FAILURE, error };
}

export function preflightError(
  error: unknown,
  serviceUrl: string,
  target: HostedDeployTarget,
  json: boolean,
  silent: boolean,
): CanonicalDeployPreparationFailure {
  const serviceError = error instanceof ServiceRequestError ? error : undefined;
  const status = serviceError?.status ?? 0;
  const message =
    error instanceof DeployPreflightInputError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  const dotenvFailure = error instanceof ProjectDotenvError;
  const localInputFailure = serviceError === undefined;
  const incompletePreflight =
    error instanceof DeployPreflightRequestError &&
    (status === 0 || status === 429 || status >= 500);
  const next = incompletePreflight
    ? `noodle audit events --org ${target.org} --app ${target.app} --env ${target.env} --service ${serviceUrl} --json`
    : status === 401
      ? `noodle login --service ${serviceUrl}`
      : status === 403 || status === 404
        ? 'noodle whoami'
        : dotenvFailure
          ? 'noodle deploy'
          : localInputFailure
            ? 'noodle validate'
            : `noodle doctor --service ${serviceUrl}`;
  const exitCode =
    status === 401 || status === 403
      ? EXIT.AUTH
      : status === 0 && serviceError !== undefined
        ? EXIT.UNREACHABLE
        : EXIT.FAILURE;
  const fix = incompletePreflight
    ? 'Publication did not start. Check the audit records for this request ID before a single retry; a transport failure does not establish an application error or resource exhaustion.'
    : status === 401 || status === 403
      ? 'Sign in and confirm access to the selected organization.'
      : dotenvFailure
        ? 'Fix the reported .env syntax line, then retry the deploy.'
        : 'Repair the reported preflight problem before deploying.';
  const failure: JsonError = {
    code:
      (error instanceof DeployOwnerMismatchError ? 'deploy_owner_mismatch' : undefined) ??
      serviceError?.code ??
      (status === 401 || status === 403 ? 'deploy_failed' : 'deploy_preflight_failed'),
    message,
    fix,
    next,
    ...(serviceError?.requestId !== undefined ? { requestId: serviceError.requestId } : {}),
    ...(error instanceof DeployPreflightInputError ? { errors: error.errors } : {}),
    detail: {
      status,
      target,
      ...(serviceError?.phase !== undefined ? { phase: serviceError.phase } : {}),
      ...(serviceError?.elapsedMs !== undefined ? { elapsedMs: serviceError.elapsedMs } : {}),
      ...(serviceError?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: serviceError.retryAfterSeconds }
        : {}),
      ...(error instanceof DeployOwnerMismatchError
        ? {
            requestedOwnerSubject: error.requestedOwnerSubject,
            ...(error.returnedOwnerSubject !== undefined
              ? { returnedOwnerSubject: error.returnedOwnerSubject }
              : {}),
          }
        : {}),
    },
  };
  if (!silent) {
    if (json) printJsonFailure(failure, exitCode);
    else {
      printRecovery({
        command: 'deploy',
        cause:
          status === 403 || status === 404
            ? `${message} (target: ${target.org}/${target.app}/${target.env})`
            : message,
        fix,
        next,
      });
    }
  }
  return { ok: false, exitCode, error: failure };
}

export function configOnly(errors: readonly { readonly code: string }[]): boolean {
  return (
    errors.length > 0 &&
    errors.every((error) => error.code === 'missing_secret' || error.code === 'missing_variable')
  );
}
