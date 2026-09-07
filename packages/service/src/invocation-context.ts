import { resolveInvocationContextSnapshot } from '@noodle-borg/assistant-gateway/portable';
import type { InvocationContextResolver } from '@noodle-borg/transport-http';

/** Bind the shared snapshot resolver to stateless MCP requests without coupling it to router code. */
export function createMcpInvocationContextResolver(
  clock: () => Date = () => new Date(),
): InvocationContextResolver {
  return ({ target, caller, clientHint }) =>
    resolveInvocationContextSnapshot({
      artifact: target.artifact,
      executeDeps: target.deps,
      instant: clock(),
      ...(caller !== undefined ? { caller } : {}),
      ...(clientHint?.location === undefined ? {} : { clientLocationHint: clientHint.location }),
    });
}
