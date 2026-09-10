import type { OperationEvidence } from '@noodle-borg/runtime';
import type { InstallationScope } from './business-information/contracts.js';
import {
  completeOperationEvidence,
  type OperationEvidenceCursor,
  type OperationEvidenceRecord,
  type OperationEvidenceStore,
  type OperationHistorySetting,
  operationEvidenceKey,
} from './operation-evidence.js';
import {
  type OperationHistoryPreviewInput,
  summarizeOperationHistory,
} from './operation-history-preview.js';

/** Local/test-only adapter with the same atomic claims and finite lifetime as PostgreSQL. */
export class InMemoryOperationEvidenceStore implements OperationEvidenceStore {
  readonly #settings = new Map<string, OperationHistorySetting>();
  async readRetention(scope: InstallationScope) {
    return this.#settings.get(operationEvidenceKey(scope, ''));
  }
  async setRetention(scope: InstallationScope, days: number, expectedRevision: number | undefined) {
    const key = operationEvidenceKey(scope, '');
    const previous = this.#settings.get(key);
    if (previous?.revision !== expectedRevision) return false;
    this.#settings.set(key, { days, revision: (previous?.revision ?? 0) + 1 });
    return true;
  }
  readonly #records = new Map<string, OperationEvidenceRecord>();
  async preview(scope: InstallationScope, input: OperationHistoryPreviewInput) {
    const scopeKey = operationEvidenceKey(scope, '');
    return summarizeOperationHistory(
      [...this.#records.values()].filter(
        (record) =>
          record.parentId === undefined && operationEvidenceKey(record.scope, '') === scopeKey,
      ),
      input,
    );
  }
  async claim(record: OperationEvidenceRecord): Promise<boolean> {
    const key = operationEvidenceKey(record.scope, record.id);
    if (this.#records.has(key)) return false;
    this.#records.set(key, structuredClone(record));
    return true;
  }
  async finish(
    scope: InstallationScope,
    id: string,
    lease: string,
    epoch: string,
    evidence: OperationEvidence,
    now: number,
    historyDays?: number,
  ): Promise<boolean> {
    const key = operationEvidenceKey(scope, id);
    const record = this.#records.get(key);
    const completed =
      record && completeOperationEvidence(record, lease, epoch, evidence, now, historyDays);
    if (!completed) return false;
    this.#records.set(key, structuredClone(completed));
    return true;
  }
  async list(
    scope: InstallationScope,
    now: number,
    days: number,
    limit: number,
    before?: OperationEvidenceCursor,
  ): Promise<readonly OperationEvidenceRecord[]> {
    await this.sweep(now);
    const prefix = operationEvidenceKey(scope, '');
    return structuredClone(
      [...this.#records.values()]
        .filter(
          (record) =>
            record.parentId === undefined &&
            operationEvidenceKey(record.scope, '') === prefix &&
            (record.outcome === 'dispatching' ||
              (record.completedAt ?? record.startedAt) >= now - days * 86_400_000) &&
            (!before ||
              record.startedAt < before.startedAt ||
              (record.startedAt === before.startedAt && record.id > before.id)),
        )
        .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
        .slice(0, limit),
    );
  }
  async sweep(now: number): Promise<void> {
    for (const [key, previous] of this.#records) {
      const record =
        previous.outcome === 'dispatching' && previous.executionDeadline <= now
          ? ({
              ...previous,
              outcome: 'unknown',
              completedAt: previous.executionDeadline,
              historyExpiresAt:
                previous.executionDeadline + previous.historyExpiresAt - previous.startedAt,
            } as const)
          : previous;
      if (record.historyExpiresAt <= now) this.#records.delete(key);
      else if (record !== previous) this.#records.set(key, record);
    }
  }
}
