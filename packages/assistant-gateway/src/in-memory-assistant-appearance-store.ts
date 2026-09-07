import {
  type AssistantAppearanceReplaceResult,
  type AssistantAppearanceSettingsRecord,
  type AssistantAppearanceSettingsStore,
  appearanceTenantKey,
  cloneAssistantAppearanceSettingsRecord,
} from './assistant-appearance-store.js';

/** Process-local appearance settings for local development and tests. */
export class InMemoryAssistantAppearanceSettingsStore implements AssistantAppearanceSettingsStore {
  readonly #records = new Map<string, AssistantAppearanceSettingsRecord>();

  async get(
    tenant: AssistantAppearanceSettingsRecord['tenant'],
  ): Promise<AssistantAppearanceSettingsRecord | undefined> {
    const record = this.#records.get(appearanceTenantKey(tenant));
    return record === undefined ? undefined : cloneAssistantAppearanceSettingsRecord(record);
  }

  async replace(
    input: Parameters<AssistantAppearanceSettingsStore['replace']>[0],
  ): Promise<AssistantAppearanceReplaceResult> {
    const key = appearanceTenantKey(input.tenant);
    const current = this.#records.get(key);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) return { ok: false, currentRevision };
    const record: AssistantAppearanceSettingsRecord = {
      tenant: { ...input.tenant },
      ...(input.override === undefined ? {} : { override: structuredClone(input.override) }),
      revision: currentRevision + 1,
      updatedAt: new Date(input.updatedAt),
      updatedBy: input.updatedBy,
    };
    this.#records.set(key, record);
    return { ok: true, record: cloneAssistantAppearanceSettingsRecord(record) };
  }
}
