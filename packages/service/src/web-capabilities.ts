import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { CapabilityError, type CapabilityService } from '@noodle-borg/managed-capabilities';
import { evaluateToolAuthorization } from '@noodle-borg/protocol';
import { WebCapabilityConnector } from '@noodle-borg/runtime';
import type { TenantRef } from './store.js';

export function deploymentWebConnector(
  artifact: RuntimeArtifact,
  tenant: TenantRef,
  deploymentId: string | undefined,
  service: CapabilityService | undefined,
) {
  if (!artifact.server.capabilities?.length) return undefined;
  return new WebCapabilityConnector(
    artifact.server.capabilities,
    async (declaration, request, call) => {
      if (
        service === undefined ||
        deploymentId === undefined ||
        call.execution === undefined ||
        call.capabilityBudget === undefined
      ) {
        throw new CapabilityError('capability_unavailable');
      }
      return service.execute(declaration, request, {
        tenant,
        deploymentId,
        executionId: call.execution.id,
        authorized: evaluateToolAuthorization(
          declaration.authorization === undefined
            ? undefined
            : {
                ...(declaration.authorization.discovery === 'public'
                  ? { discovery: 'public' as const }
                  : {}),
                ...(declaration.authorization.requiredScopes === undefined
                  ? {}
                  : { requiredScopes: declaration.authorization.requiredScopes }),
                ...(declaration.authorization.allowedRoles === undefined
                  ? {}
                  : { allowedRoles: declaration.authorization.allowedRoles }),
              },
          call.caller,
        ).allow,
        anonymous: call.caller === undefined || call.caller.identityKind === 'anonymous',
        ...(call.caller === undefined ? {} : { subject: call.caller.subject }),
        ...(call.publicAdmission?.network === undefined
          ? {}
          : { network: call.publicAdmission.network }),
        budget: call.capabilityBudget,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
    },
  );
}
