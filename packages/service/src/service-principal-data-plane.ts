import type { AuditSink } from '@noodle-borg/module';
import type {
  HostedToolAuthorizationObserver,
  HostedToolDispatchHook,
  Logger,
} from '@noodle-borg/transport-http';

/** Compose both machine-specific hooks without growing the service composition root. */
export function servicePrincipalDataPlaneHooks(
  next: HostedToolDispatchHook | undefined,
  audit: AuditSink,
  logger: Logger,
): {
  readonly beforeToolDispatch: HostedToolDispatchHook;
  readonly observeToolAuthorization: HostedToolAuthorizationObserver;
} {
  return {
    beforeToolDispatch: withServicePrincipalToolCallAudit(next, audit, logger),
    observeToolAuthorization: createServicePrincipalToolAuthorizationAudit(audit, logger),
  };
}

/** Emit one bounded authorization decision without making audit availability part of MCP admission. */
export function createServicePrincipalToolAuthorizationAudit(
  audit: AuditSink,
  logger: Logger,
): HostedToolAuthorizationObserver {
  return async (observation) => {
    if (observation.org === undefined) return;
    try {
      await audit.emit({
        eventType: 'service_principal.tool.authorization',
        org: observation.org,
        ...(observation.app === undefined ? {} : { app: observation.app }),
        ...(observation.environment === undefined ? {} : { env: observation.environment }),
        ...(observation.deploymentId === undefined
          ? {}
          : { deploymentId: observation.deploymentId }),
        actorSubject: observation.subject,
        decision: observation.decision,
        status: observation.decision === 'allow' ? 200 : 403,
        reasonCode: observation.reason,
        details: {
          toolName: observation.toolName,
          ruleClass: observation.ruleClass,
          ruleFingerprint: observation.ruleFingerprint,
        },
      });
    } catch {
      warnAuditFailure(logger, observation.org, observation.toolName, 'authorization');
    }
  };
}

/** Preserve the existing usage decision exactly, adding one best-effort audit for an allowed machine call. */
export function withServicePrincipalToolCallAudit(
  next: HostedToolDispatchHook | undefined,
  audit: AuditSink,
  logger: Logger,
): HostedToolDispatchHook {
  return async (context) => {
    const decision = next === undefined ? ({ allow: true } as const) : await next(context);
    if (decision.allow && context.caller?.identityKind === 'service') {
      try {
        await audit.emit({
          eventType: 'service_principal.tool.called',
          org: context.org,
          app: context.app,
          env: context.environment,
          deploymentId: context.deploymentId,
          actorSubject: context.caller.subject,
          decision: 'allow',
          status: 200,
          details: { toolName: context.toolName },
        });
      } catch {
        warnAuditFailure(logger, context.org, context.toolName, 'call');
      }
    }
    return decision;
  };
}

function warnAuditFailure(
  logger: Logger,
  org: string,
  toolName: string,
  phase: 'authorization' | 'call',
): void {
  try {
    logger.warn('service_principal.tool.audit_failed', { org, toolName, phase });
  } catch {
    // Audit diagnostics never participate in authorization or connector dispatch.
  }
}
