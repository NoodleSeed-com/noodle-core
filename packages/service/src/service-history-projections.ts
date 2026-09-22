import { randomBytes } from 'node:crypto';
import { ApplicationActivity } from './application-activity.js';
import { ApplicationConversations } from './conversation-history/operator.js';
import type { ModuleHost } from './modules/host.js';
import type { ServiceOptions } from './options.js';

/** Installation history projections over the optional durable stores the service was given. */
export function createHistoryProjections(options: ServiceOptions, moduleHost: ModuleHost) {
  const activity =
    options.operationEvidence === undefined
      ? undefined
      : new ApplicationActivity({
          ...options.operationEvidence,
          allowance: async (org, request) =>
            moduleHost.resolveActivityHistoryAllowance?.(org, request),
        });
  const history = options.conversationHistory;
  const conversations =
    history === undefined
      ? undefined
      : new ApplicationConversations({
          store: history.store,
          identityKey: history.identityKey ?? randomBytes(32).toString('hex'),
          ...(options.clock === undefined
            ? {}
            : { now: () => options.clock?.().getTime() ?? Date.now() }),
        });
  return { activity, conversations };
}
