import { randomBytes } from 'node:crypto';
import { ActivityPolicyError, ApplicationActivity } from './application-activity.js';
import { historyDisabledSurfaces } from './application-history-settings.js';
import type { BusinessInformationStore } from './business-information/contracts.js';
import type { ConversationPolicySource } from './conversation-history/contracts.js';
import { ApplicationConversations } from './conversation-history/operator.js';
import { previewEnvironments, withPreviewConversations } from './conversation-history/preview.js';
import type { ModuleHost } from './modules/host.js';
import type { ServiceOptions } from './options.js';
import type { ServerRegistry } from './registry.js';

/** Installation history projections over the optional durable stores the service was given. */
export function createHistoryProjections(
  options: ServiceOptions,
  moduleHost: ModuleHost,
  installations: BusinessInformationStore | undefined,
  registry: Pick<ServerRegistry, 'getActiveByTenant' | 'getEnvironment' | 'listEnvironments'>,
) {
  const history = options.conversationHistory;
  const activity =
    options.operationEvidence === undefined
      ? undefined
      : new ApplicationActivity({
          ...options.operationEvidence,
          allowance: async (org, request) =>
            moduleHost.resolveActivityHistoryAllowance?.(org, request),
          ...(history === undefined ? {} : { conversationHistory: history.store }),
          historyDisabledSurfaces: async (scope) =>
            historyDisabledSurfaces(
              (await registry.getActiveByTenant(scope))?.served.artifact.server.assistant,
            ),
        });
  const preview = previewEnvironments(registry);
  const conversationPolicy: ConversationPolicySource = withPreviewConversations(
    history?.policy ?? settingsConversationPolicy(installations, activity),
    preview,
  );
  const conversations =
    history === undefined
      ? undefined
      : new ApplicationConversations({
          store: history.store,
          policy: conversationPolicy,
          preview,
          identityKey: history.identityKey ?? randomBytes(32).toString('hex'),
          ...(options.clock === undefined
            ? {}
            : { now: () => options.clock?.().getTime() ?? Date.now() }),
        });
  return { activity, conversations, conversationPolicy };
}

/**
 * Capture follows the installation history setting under the live plan allowance (ADR 0241): every
 * installation records at the plan default unless an Owner/Admin changed it. A tenant with no single
 * installation or verified allowance records nothing, and the read never creates a setting.
 */
function settingsConversationPolicy(
  installations: BusinessInformationStore | undefined,
  activity: ApplicationActivity | undefined,
): ConversationPolicySource {
  return async (tenant) => {
    if (!installations || !activity) return undefined;
    const matching = (await installations.listInstallations(tenant.org)).filter(
      (item) => item.scope.app === tenant.app && item.scope.env === tenant.env,
    );
    const installation = matching.length === 1 ? matching[0] : undefined;
    if (!installation) return undefined;
    try {
      return await activity.conversationPolicy(installation.scope);
    } catch (error) {
      if (error instanceof ActivityPolicyError) return undefined;
      throw error;
    }
  };
}
