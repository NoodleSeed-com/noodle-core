import type { ServerResponse } from 'node:http';
import { DeploymentActivationError } from '@noodle-borg/module';
import { sendJson } from '@noodle-borg/transport-http';
import type { AuditSink } from '../store/audit.js';

interface DeploymentActivationRejectionContext {
  readonly audit: AuditSink;
  readonly eventType: 'deploy.rejected' | 'rollback.rejected' | 'app.restore.rejected';
  readonly org: string;
  readonly app: string;
  readonly env?: string;
  readonly actorSubject?: string;
  readonly actorEmail?: string;
}

/** Translate provider-neutral activation failures without exposing commercial account details. */
export async function respondDeploymentActivationError(
  res: ServerResponse,
  error: unknown,
  context: DeploymentActivationRejectionContext,
): Promise<boolean> {
  const rejected = await deploymentActivationRejection(error, context);
  if (rejected === undefined) return false;
  sendJson(res, rejected.status, rejected.body);
  return true;
}

export async function deploymentActivationRejection(
  error: unknown,
  context: DeploymentActivationRejectionContext,
): Promise<
  | {
      readonly status: 409 | 503;
      readonly body: { readonly ok: false; readonly code: string; readonly error: string };
    }
  | undefined
> {
  if (!(error instanceof DeploymentActivationError)) return undefined;
  const response = deploymentActivationResponse(error.code);
  if (response === undefined) return undefined;
  await context.audit.emit({
    eventType: context.eventType,
    org: context.org,
    app: context.app,
    ...(context.env !== undefined ? { env: context.env } : {}),
    decision: 'deny',
    status: response.status,
    reasonCode: error.code,
    ...(context.actorSubject !== undefined ? { actorSubject: context.actorSubject } : {}),
    ...(context.actorEmail !== undefined ? { actorEmail: context.actorEmail } : {}),
  });
  return {
    status: response.status,
    body: { ok: false, code: error.code, error: response.message },
  };
}

function deploymentActivationResponse(
  code: DeploymentActivationError['code'],
): { readonly status: 409 | 503; readonly message: string } | undefined {
  if (code === 'production_app_limit_exceeded') {
    return {
      status: 409,
      message: 'production app limit reached; archive an active app or contact support',
    };
  }
  if (code === 'billing_enforcement_unavailable') {
    return {
      status: 503,
      message: 'billing enforcement is temporarily unavailable; retry later',
    };
  }
  return undefined;
}
