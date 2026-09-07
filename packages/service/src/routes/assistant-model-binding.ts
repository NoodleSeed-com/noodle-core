import type { ResolvedAssistantModel } from '@noodle-borg/assistant-gateway/model-runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { resolveManagedVariablesInString } from '../managed-config-expressions.js';
import { resolveConfigScope } from '../store.js';
import type { AssistantRouteDeps } from './assistant.js';

export async function resolveAssistantModelBinding(
  target: ServedTarget,
  tenant: { readonly org: string; readonly app: string; readonly env: string },
  deploymentId: string,
  deps: AssistantRouteDeps,
): Promise<ResolvedAssistantModel | undefined> {
  const declaration = target.served.artifact.server.assistant?.model;
  if (declaration === undefined) return undefined;
  if (declaration.kind === 'noodle-managed') {
    return deps.managedModelResolver?.resolve({ tenant, deploymentId });
  }
  const scope = resolveConfigScope(tenant);
  const [variables, secrets] = await Promise.all([
    deps.registry.configStore.resolveConfigValues('variable', scope),
    deps.registry.configStore.resolveConfigValues('secret', scope),
  ]);
  const apiKey = secrets[declaration.apiKey];
  if (!apiKey) return undefined;
  return {
    source: 'operator',
    ...(declaration.transport === undefined ? {} : { transport: declaration.transport }),
    baseUrl: resolveManagedVariablesInString(declaration.baseUrl, variables).replace(/\/$/, ''),
    model: resolveManagedVariablesInString(declaration.model, variables),
    apiKey,
  };
}
