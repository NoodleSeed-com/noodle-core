import {
  type AssistantSessionRecord,
  assistantConfigurationHasBusinessNotice,
  resolveAssistantSessionTarget,
} from '@noodle-borg/assistant-gateway/portable';
import { type RuntimeTargetResolver, resolveTargetOrigins } from '../application-runtime-target.js';
import type { ServerRegistry } from '../registry.js';
import type { TenantRef } from '../store.js';

/** Adapt the registry to the gateway-owned, surface-projected session target decision. */
export async function sessionScopedTarget(
  registry: Pick<ServerRegistry, 'get'>,
  session: AssistantSessionRecord,
  resolve: RuntimeTargetResolver = resolveTargetOrigins,
  req?: Pick<IncomingMessage, 'socket'>,
) {
  const target = await resolveAssistantSessionTarget(async (deploymentId) => {
    const target = await registry.get(deploymentId);
    return target && resolve(target);
  }, session);
  if (target === undefined) return undefined;
  if (
    target.businessNotice &&
    !assistantConfigurationHasBusinessNotice(session.configuration, target.businessNotice)
  )
    return undefined;
  const publicAdmission = trustedPublicAdmission({
    scope: `${session.tenant.org}/${session.tenant.app}/${session.tenant.env}`,
    sourceAddress: req?.socket?.remoteAddress,
    subject: session.caller.subject,
  });
  return {
    ...target,
    served: {
      ...target.served,
      deps: {
        ...target.served.deps,
        ...(publicAdmission === undefined ? {} : { publicAdmission }),
      },
    },
  };
}

export async function activeAssistantTarget(
  deps: {
    readonly registry: ServerRegistry;
    readonly resolveRuntimeTarget?: RuntimeTargetResolver;
  },
  tenant: TenantRef,
) {
  const target = await deps.registry.getActiveByTenant(tenant);
  return target && (deps.resolveRuntimeTarget ?? resolveTargetOrigins)(target);
}

import type { IncomingMessage } from 'node:http';
import { trustedPublicAdmission } from '@noodle-borg/admission-limits/portable';
