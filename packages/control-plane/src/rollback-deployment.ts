import {
  type AuditSink,
  DeploymentActivationError,
  type DeploymentOperationTarget,
  type EndpointUrlOptions,
  tenantMcpUrl,
} from '@noodle-borg/module';
import type { RollbackResult } from './rollback-result.js';

export interface RollbackRegistry {
  getAppArchivedAt(org: string, app: string): Promise<string | undefined>;
  rollback(target: DeploymentOperationTarget, deploymentId: string): Promise<RollbackResult>;
}

export interface RollbackControlPlane {
  getOrgMember(input: {
    readonly org: string;
    readonly subject: string;
  }): Promise<{ readonly role: string } | undefined>;
}

export interface RollbackOperationDependencies {
  readonly registry: RollbackRegistry;
  readonly controlPlane: RollbackControlPlane;
  readonly audit: AuditSink;
}

export interface RollbackOperationInput {
  readonly actor: {
    readonly subject: string;
    readonly email?: string;
    readonly superAdmin: boolean;
  };
  readonly target: DeploymentOperationTarget;
  readonly deploymentId: string;
  readonly reason?: string;
  readonly publicBaseUrl: string;
  readonly endpointOptions?: EndpointUrlOptions;
}

export type RollbackOperationResult =
  | {
      readonly ok: true;
      readonly view: {
        readonly target: DeploymentOperationTarget;
        readonly rollback: {
          readonly deploymentId: string;
          readonly serverVersion?: string;
          readonly previousDeploymentId?: string;
          readonly alreadyActive: boolean;
          readonly endpointUrl: string;
          readonly accessMode: string;
          readonly ownerSubject?: string;
          readonly previousAccessMode?: string;
          readonly serverName: string;
          readonly createdAt: string;
        };
      };
    }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 409 | 503;
      readonly code:
        | 'forbidden'
        | 'app_archived'
        | 'deployment_not_found'
        | 'deployment_incompatible'
        | 'deployment_locked'
        | 'production_app_limit_exceeded'
        | 'billing_enforcement_unavailable';
      readonly message: string;
    };

type RollbackRejection = Omit<Extract<RollbackOperationResult, { readonly ok: false }>, 'ok'>;

/**
 * Activate a previous deployment through the service's canonical governance boundary.
 * HTTP routes, agent tools, and MCP App widgets must all call this operation rather than
 * duplicating owner checks, commercial admission, endpoint construction, or audit behavior.
 */
export async function rollbackDeploymentOperation(
  dependencies: RollbackOperationDependencies,
  input: RollbackOperationInput,
): Promise<RollbackOperationResult> {
  const member = input.actor.superAdmin
    ? undefined
    : await dependencies.controlPlane.getOrgMember({
        org: input.target.org,
        subject: input.actor.subject,
      });
  if (!input.actor.superAdmin && member?.role !== 'owner') {
    return reject(dependencies.audit, input, {
      status: 403,
      code: 'forbidden',
      message: 'organization owner access is required',
    });
  }

  const archivedAt = await dependencies.registry.getAppArchivedAt(
    input.target.org,
    input.target.app,
  );
  if (archivedAt !== undefined) {
    return reject(
      dependencies.audit,
      input,
      {
        status: 409,
        code: 'app_archived',
        message: 'app is archived; restore it before rolling back',
      },
      { archivedAt },
    );
  }

  let result: Awaited<ReturnType<RollbackRegistry['rollback']>>;
  try {
    result = await dependencies.registry.rollback(input.target, input.deploymentId);
  } catch (error) {
    if (!(error instanceof DeploymentActivationError)) throw error;
    if (
      error.code !== 'production_app_limit_exceeded' &&
      error.code !== 'billing_enforcement_unavailable'
    ) {
      throw error;
    }
    const rejection =
      error.code === 'production_app_limit_exceeded'
        ? {
            status: 409 as const,
            code: error.code,
            message: 'production app limit reached; archive an active app or contact support',
          }
        : {
            status: 503 as const,
            code: error.code,
            message: 'billing enforcement is temporarily unavailable; retry later',
          };
    return reject(dependencies.audit, input, rejection);
  }

  if (!result.ok) {
    return reject(dependencies.audit, input, {
      status: result.status,
      code:
        result.code === 'deployment_locked'
          ? result.code
          : result.status === 404
            ? 'deployment_not_found'
            : 'deployment_incompatible',
      message: result.error,
    });
  }

  const endpointUrl = tenantMcpUrl(
    input.publicBaseUrl,
    input.target,
    result.serverVersion,
    input.endpointOptions,
  );
  await dependencies.audit
    .emit({
      eventType: 'deploy.rollback',
      org: input.target.org,
      app: input.target.app,
      env: input.target.env,
      deploymentId: result.deploymentId,
      decision: 'allow',
      status: 200,
      actorSubject: input.actor.subject,
      ...(input.actor.email !== undefined ? { actorEmail: input.actor.email } : {}),
      details: {
        ...(result.serverVersion !== undefined ? { serverVersion: result.serverVersion } : {}),
        ...(result.previousDeploymentId !== undefined
          ? { previousDeploymentId: result.previousDeploymentId }
          : {}),
        alreadyActive: result.alreadyActive,
        accessMode: result.accessMode,
        ...(result.ownerSubject !== undefined ? { ownerSubject: result.ownerSubject } : {}),
        ...(result.previousAccessMode !== undefined
          ? { previousAccessMode: result.previousAccessMode }
          : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    })
    .catch(() => undefined);

  return {
    ok: true,
    view: {
      target: input.target,
      rollback: {
        deploymentId: result.deploymentId,
        ...(result.serverVersion !== undefined ? { serverVersion: result.serverVersion } : {}),
        ...(result.previousDeploymentId !== undefined
          ? { previousDeploymentId: result.previousDeploymentId }
          : {}),
        alreadyActive: result.alreadyActive,
        endpointUrl,
        accessMode: result.accessMode,
        ...(result.ownerSubject !== undefined ? { ownerSubject: result.ownerSubject } : {}),
        ...(result.previousAccessMode !== undefined
          ? { previousAccessMode: result.previousAccessMode }
          : {}),
        serverName: result.serverName,
        createdAt: result.createdAt,
      },
    },
  };
}

async function reject(
  audit: AuditSink,
  input: RollbackOperationInput,
  rejection: RollbackRejection,
  details?: Readonly<Record<string, string | number | boolean>>,
): Promise<Extract<RollbackOperationResult, { readonly ok: false }>> {
  await audit.emit({
    eventType: 'rollback.rejected',
    org: input.target.org,
    app: input.target.app,
    env: input.target.env,
    decision: 'deny',
    status: rejection.status,
    reasonCode: rejection.code,
    actorSubject: input.actor.subject,
    ...(input.actor.email !== undefined ? { actorEmail: input.actor.email } : {}),
    ...(details === undefined ? {} : { details }),
  });
  return { ok: false, ...rejection };
}
