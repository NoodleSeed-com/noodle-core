import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { type ExecuteDeps, freezeCustomerRoutes } from '@noodle-borg/runtime';
import type { ProtocolRequestContext } from './sdk-server.js';

/** Resolve the version-neutral execution dependencies for one protocol request. */
export function buildProtocolRequestDeps(
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
  context: ProtocolRequestContext,
): ExecuteDeps {
  return {
    ...deps,
    ...(context.caller !== undefined ? { caller: context.caller } : {}),
    ...(context.customerIssuer !== undefined ? { customerIssuer: context.customerIssuer } : {}),
    ...(artifact.customerEndpoints === undefined
      ? {}
      : {
          customerRoutes: freezeCustomerRoutes(artifact.customerEndpoints, context.customerRouting),
        }),
    ...(context.invocationContext !== undefined ? { context: context.invocationContext } : {}),
  };
}
