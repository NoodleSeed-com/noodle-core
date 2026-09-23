import { randomBytes } from 'node:crypto';
import { ConversationCapture } from './conversation-history/capture.js';
import type { ConversationPolicySource } from './conversation-history/contracts.js';
import { CustomerConversations } from './conversation-history/customer.js';
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
  > & { readonly conversationPolicy: ConversationPolicySource },
): AssistantRouteDeps {
  const { conversationPolicy, ...route } = core;
  return {
    ...route,
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
    ...(options.conversationHistory
      ? {
          conversations: new ConversationCapture(
            options.conversationHistory.store,
            conversationPolicy,
            {
              now: () => (options.clock?.() ?? new Date()).getTime(),
              ...(core.logger ? { logger: core.logger } : {}),
            },
          ),
          customerConversations: new CustomerConversations({
            store: options.conversationHistory.store,
            policy: conversationPolicy,
            identityKey: options.conversationHistory.identityKey ?? randomBytes(32).toString('hex'),
            now: () => (options.clock?.() ?? new Date()).getTime(),
          }),
        }
      : {}),
  };
}
