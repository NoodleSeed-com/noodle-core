import type { AuditSink, DeploymentOperationTarget } from '@noodle-borg/module';
import type { DeploymentDeleteResponse } from '@noodle-borg/wire-contracts';
import type { ControlPlaneIdentity } from './contracts.js';
import type {
  DeploymentDeleteResult,
  DeploymentDeleteSelection,
} from './deployment-deletion-contracts.js';
import type { RollbackControlPlane } from './rollback-deployment.js';

export type DeploymentDeleteScope =
  | { readonly kind: 'deployment'; readonly org: string; readonly deploymentId: string }
  | {
      readonly kind: 'version';
      readonly org: string;
      readonly target: DeploymentOperationTarget;
      readonly serverVersion?: string;
    };

export interface DeploymentDeletionRegistry {
  getDeployment(
    org: string,
    deploymentId: string,
  ): Promise<
    | {
        readonly orgSlug: string;
        readonly appSlug: string;
        readonly environment: string;
      }
    | undefined
  >;
  deleteDeployments(
    target: DeploymentOperationTarget,
    selection: DeploymentDeleteSelection,
  ): Promise<DeploymentDeleteResult>;
}
export interface DeploymentDeletionDependencies {
  readonly registry: DeploymentDeletionRegistry;
  readonly controlPlane: RollbackControlPlane;
  readonly audit: AuditSink;
}
export type DeploymentDeleteOperationResult =
  | { readonly ok: true; readonly view: DeploymentDeleteResponse }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 404 | 409;
      readonly code: string;
      readonly error: string;
    };

type FailureCode = Extract<DeploymentDeleteResult, { ok: false }>['code'];
const ERRORS: Record<FailureCode, string> = {
  deployment_not_found: 'Deployment not found.',
  version_not_found: 'Version not found.',
  active_deployment:
    'Roll back to another deployment before deleting the live deployment, or delete the whole version.',
  deployment_locked: 'Unlock this version before deleting it.',
  app_archived: 'Restore the archived app before deleting its deployments.',
  deployment_delete_conflict:
    'The deployment history changed. Refresh and review it before deleting.',
};

/** One owner-authorized deletion path for every host; stores commit the exact selection atomically. */
export async function deleteDeploymentOperation(
  deps: DeploymentDeletionDependencies,
  input: {
    readonly actor: ControlPlaneIdentity;
    readonly scope: DeploymentDeleteScope;
    readonly expectedDeploymentIds?: readonly string[];
  },
): Promise<DeploymentDeleteOperationResult> {
  const { actor: identity, scope: route } = input;
  const org = route.kind === 'version' ? route.target.org : route.org;
  const member = identity.superAdmin
    ? undefined
    : await deps.controlPlane.getOrgMember({ org, subject: identity.subject });
  if (
    identity.developerGrantId !== undefined ||
    (!identity.superAdmin && member?.role !== 'owner')
  ) {
    return {
      ok: false,
      status: 403,
      code: 'organization_owner_required',
      error: 'Only an organization owner can delete deployments or versions.',
    };
  }
  let target: DeploymentOperationTarget;
  let selection: DeploymentDeleteSelection;
  if (route.kind === 'deployment') {
    const record = await deps.registry.getDeployment(route.org, route.deploymentId);
    if (!record)
      return {
        ok: false,
        status: 404,
        code: 'deployment_not_found',
        error: ERRORS.deployment_not_found,
      };
    target = { org: record.orgSlug, app: record.appSlug, env: record.environment };
    selection = { kind: 'deployment', deploymentId: route.deploymentId };
  } else {
    if (!input.expectedDeploymentIds?.length)
      return {
        ok: false,
        status: 400,
        code: 'invalid_deletion_confirmation',
        error: 'Invalid version deletion confirmation.',
      };
    target = route.target;
    selection = {
      kind: 'version',
      expectedDeploymentIds: input.expectedDeploymentIds,
      ...(route.serverVersion === undefined ? {} : { serverVersion: route.serverVersion }),
    };
  }
  const result = await deps.registry.deleteDeployments(target, selection);
  const status = result.ok
    ? 200
    : result.code === 'deployment_not_found' || result.code === 'version_not_found'
      ? 404
      : 409;
  let auditRecorded = true;
  try {
    await deps.audit.emit({
      eventType: result.ok
        ? route.kind === 'version'
          ? 'deployment.version.deleted'
          : 'deployment.deleted'
        : 'deployment.delete.rejected',
      org: target.org,
      app: target.app,
      env: target.env,
      ...(route.kind === 'deployment' ? { deploymentId: route.deploymentId } : {}),
      actorSubject: identity.subject,
      ...(identity.email === undefined ? {} : { actorEmail: identity.email }),
      decision: result.ok ? 'allow' : 'deny',
      status,
      ...(!result.ok ? { reasonCode: result.code } : {}),
      details: {
        scope: route.kind,
        ...(route.kind === 'version' ? { serverVersion: route.serverVersion ?? 'legacy' } : {}),
        ...(result.ok ? { deletedDeployments: result.deleted.length } : {}),
      },
    });
  } catch {
    // Deletion has already committed. An audit outage must not claim the records still exist.
    auditRecorded = false;
  }
  if (!result.ok)
    return {
      ok: false,
      status: status as 404 | 409,
      code: result.code,
      error: ERRORS[result.code],
    };
  return {
    ok: true,
    view: {
      ok: true,
      target,
      deletedDeploymentIds: result.deleted.map((record) => record.deploymentId),
      auditRecorded,
    },
  };
}
