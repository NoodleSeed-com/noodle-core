import type { EnvSummary, TenantRef } from '../store.js';
import {
  ALL_CONVERSATION_SOURCES,
  type ConversationPolicy,
  type ConversationPolicySource,
} from './contracts.js';

/**
 * ADR 0241 decision 18: a Preview environment's conversations are kept this long, whatever the stored
 * duration or recording switches, and never longer than the plan maximum.
 */
export const PREVIEW_CONVERSATION_DAYS = 3;

/** Whether this tenant is a Preview environment; false keeps every production rule. */
export type PreviewEnvironmentSource = (tenant: TenantRef) => Promise<boolean>;

export interface EnvironmentReader {
  getEnvironment(org: string, app: string, env: string): Promise<EnvSummary | undefined>;
  listEnvironments(org: string, app: string): Promise<readonly EnvSummary[]>;
}

/**
 * A Preview environment is a deployed environment of an app whose production environment is another,
 * designated one. An unknown environment, an app with no resolved production designation, or an
 * unreadable registry keeps production semantics, so a live chat never loses its setting or reaches a
 * Builder by default.
 */
export function previewEnvironments(registry: EnvironmentReader): PreviewEnvironmentSource {
  return async (tenant) => {
    try {
      const current = await registry.getEnvironment(tenant.org, tenant.app, tenant.env);
      if (current === undefined || current.isProduction) return false;
      const environments = await registry.listEnvironments(tenant.org, tenant.app);
      return environments.some((item) => item.isProduction && item.envName !== tenant.env);
    } catch {
      return false;
    }
  };
}

/** A Preview tenant records every source for the fixed window; production policy is returned as is. */
export function withPreviewConversations(
  policy: ConversationPolicySource,
  isPreview: PreviewEnvironmentSource,
): ConversationPolicySource {
  return async (tenant) => {
    const current = await policy(tenant);
    if (current === undefined || !(await isPreview(tenant))) return current;
    return previewConversationPolicy(current.maximumDays);
  };
}

function previewConversationPolicy(maximumDays: number): ConversationPolicy {
  return {
    maximumDays,
    conversationDays: Math.max(0, Math.min(PREVIEW_CONVERSATION_DAYS, maximumDays)),
    sources: { ...ALL_CONVERSATION_SOURCES },
  };
}
