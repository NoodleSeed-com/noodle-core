import type { ServiceOptions } from './options.js';
import type { AssistantRouteDeps } from './routes/assistant.js';

/** Browser and messaging resolve model, execution and tenant policy from one composition. */
export function assistantRouteDependencies(
  options: ServiceOptions,
  core: Pick<
    AssistantRouteDeps,
    | 'registry'
    | 'resolveRuntimeTarget'
    | 'store'
    | 'appearance'
    | 'gate'
    | 'controlPlane'
    | 'audit'
    | 'maxBody'
    | 'serviceBase'
    | 'logger'
  >,
): AssistantRouteDeps {
  return {
    ...core,
    ...(options.publicEmbeds ? { publicEmbeds: options.publicEmbeds } : {}),
    ...(options.elevations ? { elevations: options.elevations } : {}),
    ...(options.elevationCoordinator ? { elevationCoordinator: options.elevationCoordinator } : {}),
    ...(options.admissionCounters ? { admissionCounters: options.admissionCounters } : {}),
    ...(options.admissionEnvelope ? { admissionEnvelope: options.admissionEnvelope } : {}),
    ...(options.assistantModelFetch ? { modelFetch: options.assistantModelFetch } : {}),
    ...(options.managedAssistantModelResolver
      ? { managedModelResolver: options.managedAssistantModelResolver }
      : {}),
    ...(options.captureRequestEvent ? { captureRequestEvent: options.captureRequestEvent } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  };
}
