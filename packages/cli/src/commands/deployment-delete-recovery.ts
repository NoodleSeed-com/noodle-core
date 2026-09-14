import type { DeploymentDeleteResponse } from '@noodle-borg/wire-contracts';
import { ServiceRequestError } from '../control-plane.js';
import { EXIT } from './output.js';
import { type CliFailure, serviceFailure } from './shared.js';

type ExpectedDeleteEvidence =
  | { readonly kind: 'deployment'; readonly org: string; readonly deploymentId: string }
  | {
      readonly kind: 'version';
      readonly target: { readonly org: string; readonly app: string; readonly env: string };
      readonly expectedDeploymentIds: readonly string[];
    };

export function deleteEvidenceMismatch(
  response: DeploymentDeleteResponse,
  expected: ExpectedDeleteEvidence,
): CliFailure | undefined {
  const matches =
    expected.kind === 'deployment'
      ? response.target.org === expected.org &&
        response.deletedDeploymentIds.length === 1 &&
        response.deletedDeploymentIds[0] === expected.deploymentId
      : response.target.org === expected.target.org &&
        response.target.app === expected.target.app &&
        response.target.env === expected.target.env &&
        sameIds(response.deletedDeploymentIds, expected.expectedDeploymentIds);
  if (matches) return undefined;
  const next =
    expected.kind === 'deployment'
      ? `noodle deployments list --org ${expected.org}`
      : `noodle deployments list --org ${expected.target.org} --app ${expected.target.app} --env ${expected.target.env}`;
  return {
    code: 'deployment_delete_evidence_mismatch',
    message: 'The service returned deletion evidence for a different target or deployment set.',
    cause:
      'The response did not match the exact deletion request. The mutation may already have completed.',
    fix: 'Refresh deployment history and reconcile the current state before attempting any retry.',
    next,
    exitCode: EXIT.FAILURE,
  };
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualIds = new Set(actual);
  return expected.every((deploymentId) => actualIds.has(deploymentId));
}

type DeleteFailureContext =
  | { readonly action: 'delete'; readonly org: string; readonly deploymentId: string }
  | {
      readonly action: 'delete-version';
      readonly org: string;
      readonly app: string;
      readonly env: string;
      readonly version: string;
    };

export function deleteServiceFailure(error: unknown, context: DeleteFailureContext): CliFailure {
  if (!(error instanceof ServiceRequestError) || error.code === undefined) {
    return serviceFailure(
      `deployments ${context.action}`,
      error,
      context.action === 'delete'
        ? `noodle deployments list --org ${context.org}`
        : versionDeleteCommand(context, context.version, false),
    );
  }
  const common = {
    code: error.code,
    message: error.message,
    cause: error.message,
    exitCode: error.status === 401 || error.status === 403 ? EXIT.AUTH : EXIT.FAILURE,
  };
  if (error.code === 'active_deployment' && context.action === 'delete') {
    return {
      ...common,
      fix: 'Roll back to another deployment first, or delete the whole version.',
      next: `noodle rollback <inactive-deployment-id> --org ${context.org}`,
    };
  }
  if (error.code === 'deployment_locked' && context.action === 'delete-version') {
    return {
      ...common,
      fix: 'Unlock this exact version before deleting it.',
      next:
        `noodle deployments unlock --org ${context.org} --app ${context.app}` +
        ` --env ${context.env} --version ${context.version} --yes`,
    };
  }
  if (error.code === 'app_archived' && context.action === 'delete-version') {
    return {
      ...common,
      fix: 'Restore the archived app before deleting its deployments.',
      next: `noodle restore ${context.app} --org ${context.org}`,
    };
  }
  if (error.code === 'deployment_delete_conflict' && context.action === 'delete-version') {
    return {
      ...common,
      fix: 'Refresh the deployment history and confirm the new exact inventory.',
      next: versionDeleteCommand(context, context.version, false),
    };
  }
  if (error.code === 'deployment_not_found' || error.code === 'version_not_found') {
    const list =
      context.action === 'delete'
        ? `noodle deployments list --org ${context.org}`
        : `noodle deployments list --org ${context.org} --app ${context.app} --env ${context.env}`;
    return {
      ...common,
      fix: 'Check the exact target against the current deployment history.',
      next: list,
    };
  }
  if (error.code === 'organization_owner_required') {
    return {
      ...common,
      fix: 'Ask an organization owner to delete the deployment records or sign in as an owner.',
      next: 'noodle whoami',
    };
  }
  return serviceFailure(
    `deployments ${context.action}`,
    error,
    context.action === 'delete'
      ? `noodle deployments list --org ${context.org}`
      : versionDeleteCommand(context, context.version, false),
  );
}

export function versionDeleteCommand(
  target: { readonly org: string; readonly app: string; readonly env: string },
  version: string,
  yes: boolean,
): string {
  return (
    `noodle deployments delete-version ${version} --org ${target.org} --app ${target.app}` +
    ` --env ${target.env}${yes ? ' --yes' : ''}`
  );
}
