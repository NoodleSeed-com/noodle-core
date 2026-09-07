import type { AssistantAppearanceOverride } from './assistant-appearance.js';
import type { TenantRef } from './tenant-ref.js';

export interface AssistantAppearanceSettingsRecord {
  readonly tenant: TenantRef;
  /** Undefined is a durable reset tombstone, not a missing row. */
  readonly override?: AssistantAppearanceOverride;
  readonly revision: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

export type AssistantAppearanceReplaceResult =
  | { readonly ok: true; readonly record: AssistantAppearanceSettingsRecord }
  | { readonly ok: false; readonly currentRevision: number };

export interface AssistantAppearanceSettingsStore {
  get(tenant: TenantRef): Promise<AssistantAppearanceSettingsRecord | undefined>;
  /**
   * Full replacement with compare-and-swap. Revision zero means no row has ever been written;
   * `override: undefined` records a reset without reopening stale-write races.
   */
  replace(input: {
    readonly tenant: TenantRef;
    readonly expectedRevision: number;
    readonly override: AssistantAppearanceOverride | undefined;
    readonly updatedAt: Date;
    readonly updatedBy: string;
  }): Promise<AssistantAppearanceReplaceResult>;
}

export function appearanceTenantKey(tenant: TenantRef): string {
  return `${tenant.org}/${tenant.app}/${tenant.env}`;
}

export function cloneAssistantAppearanceSettingsRecord(
  record: AssistantAppearanceSettingsRecord,
): AssistantAppearanceSettingsRecord {
  return {
    ...record,
    tenant: { ...record.tenant },
    ...(record.override === undefined ? {} : { override: structuredClone(record.override) }),
    updatedAt: new Date(record.updatedAt),
  };
}
