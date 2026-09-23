import {
  authenticatedSurfaceOf,
  messagingSurfaceOf,
  publicSurfaceOf,
} from '@noodle-borg/assistant-gateway/portable';
import type { ActivityHistoryAllowance } from '@noodle-borg/module';
import type {
  ApplicationHistoryDisabledSurfaceSchema,
  ApplicationHistorySettingsSaveRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { z } from 'zod';
import {
  ALL_CONVERSATION_SOURCES,
  type ConversationPolicy,
  type ConversationSource,
} from './conversation-history/contracts.js';
import type {
  OperationHistorySetting,
  OperationHistorySettingValue,
} from './operation-evidence.js';

/**
 * The one installation history setting (ADR 0241 decision 6) as staff see and change it. Pure mapping
 * between the stored setting, the verified plan allowance and the wire shape; no I/O.
 */
export type HistorySettingsChange = z.infer<typeof ApplicationHistorySettingsSaveRequestSchema>;

const WIRE_SOURCES = {
  websiteVisitors: 'website_visitors',
  signedInCustomers: 'signed_in_customers',
  whatsapp: 'whatsapp',
} as const satisfies Record<string, ConversationSource>;

export type HistoryDisabledSurface = z.infer<typeof ApplicationHistoryDisabledSurfaceSchema>;

/**
 * The surfaces the served application declared `history: false` on (ADR 0241 decision 11), so staff
 * see which conversation options the application has disabled rather than the business.
 */
export function historyDisabledSurfaces(assistant: unknown): readonly HistoryDisabledSurface[] {
  return [
    ...(publicSurfaceOf(assistant)?.history === false ? ['publicWebsite' as const] : []),
    ...(authenticatedSurfaceOf(assistant)?.history === false
      ? ['authenticatedWebsite' as const]
      : []),
    ...(messagingSurfaceOf(assistant)?.history === false ? ['publicMessaging' as const] : []),
  ];
}

/**
 * A setting created lazily on first read keeps no conversation duration of its own, so it records at
 * the live plan default like every installation without a chosen duration (ADR 0241 decision 8).
 */
export function lazyHistorySetting(
  allowance: ActivityHistoryAllowance,
): OperationHistorySettingValue {
  return {
    days: allowance.defaultDays,
    conversationDays: null,
    sources: ALL_CONVERSATION_SOURCES,
  };
}

/**
 * The one rule for a stored conversation duration: none chosen (no setting, or a NULL duration) is the
 * live plan default; 0 is Off. Applications without an installation have no setting and record nothing
 * upstream of this.
 */
function chosenConversationDays(
  setting: OperationHistorySettingValue | undefined,
  allowance: ActivityHistoryAllowance,
): number {
  return setting?.conversationDays ?? allowance.defaultDays;
}

export function historySettingsProjection(
  setting: OperationHistorySetting,
  allowance: ActivityHistoryAllowance,
  revision: string,
  canEdit: boolean,
) {
  const days = chosenConversationDays(setting, allowance);
  return {
    revision,
    canEdit,
    activity: {
      retentionDays: Math.min(setting.days, allowance.maximumDays),
      maximumDays: allowance.maximumDays,
      defaultDays: allowance.defaultDays,
    },
    conversations: {
      state: days === 0 ? ('off' as const) : ('on' as const),
      ...(days ? { retentionDays: Math.min(days, allowance.maximumDays) } : {}),
      sources: {
        websiteVisitors: setting.sources.website_visitors,
        signedInCustomers: setting.sources.signed_in_customers,
        whatsapp: setting.sources.whatsapp,
      },
    },
  };
}

/** Days currently recorded under the plan maximum; Off keeps nothing new. */
function recordedDays(
  setting: OperationHistorySettingValue,
  allowance: ActivityHistoryAllowance,
): number {
  return Math.min(chosenConversationDays(setting, allowance), allowance.maximumDays);
}

/**
 * Applies a change, or returns undefined when a requested duration exceeds the plan maximum. `shortened` is the
 * new conversation duration when the change shortens or turns off recorded conversation history.
 */
export function planHistorySettingsChange(
  current: OperationHistorySetting,
  change: HistorySettingsChange,
  allowance: ActivityHistoryAllowance,
):
  | {
      readonly next: OperationHistorySettingValue;
      readonly shortened?: number;
      readonly audit: Readonly<Record<string, string | number>>;
    }
  | undefined {
  const conversationDays =
    change.conversations === undefined
      ? current.conversationDays
      : change.conversations === 'off'
        ? 0
        : change.conversations.retentionDays;
  const { maximumDays } = allowance;
  // Only requested durations meet the cap: a value stored before a downgrade stays, read as clamped.
  if (
    (change.activityDays ?? 0) > maximumDays ||
    (typeof change.conversations === 'object' && change.conversations.retentionDays > maximumDays)
  )
    return undefined;
  const days = change.activityDays ?? current.days;
  const sources = { ...current.sources };
  const changed: string[] = [];
  for (const [wire, source] of Object.entries(WIRE_SOURCES)) {
    const value = change.sources?.[wire as keyof typeof WIRE_SOURCES];
    if (value === undefined || value === sources[source]) continue;
    sources[source] = value;
    changed.push(wire);
  }
  const next = { days, conversationDays, sources };
  const before = recordedDays(current, allowance);
  const after = recordedDays(next, allowance);
  const chosen = chosenConversationDays(next, allowance);
  return {
    next,
    ...(before > 0 && after < before ? { shortened: after } : {}),
    audit: {
      activityDays: days,
      conversationDays: chosen === 0 ? 'off' : chosen,
      sourcesChanged: changed.length === 0 ? 'none' : changed.join(','),
    },
  };
}

/** The capture policy for an installation's setting; one not yet created records at the plan default. */
export function conversationPolicyFromSetting(
  setting: OperationHistorySetting | undefined,
  allowance: ActivityHistoryAllowance,
): ConversationPolicy {
  return {
    maximumDays: allowance.maximumDays,
    conversationDays: chosenConversationDays(setting, allowance),
    sources: { ...(setting?.sources ?? ALL_CONVERSATION_SOURCES) },
  };
}
