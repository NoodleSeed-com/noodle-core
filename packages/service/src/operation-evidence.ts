import { createHmac, randomUUID } from 'node:crypto';
import { canonicalJson } from '@noodle-borg/compiler';
import type {
  OperationEvidence,
  OperationEvidenceIntent,
  OperationEvidencePort,
} from '@noodle-borg/runtime';
import type { InstallationScope } from './business-information/contracts.js';
import type {
  OperationHistoryPreviewCounts,
  OperationHistoryPreviewInput,
} from './operation-history-preview.js';

export interface OperationEvidenceRecord {
  readonly scope: InstallationScope;
  readonly id: string;
  /** Trusted coordinated business attempt; child evidence retains custody but is not a second Activity. */
  readonly parentId?: string;
  readonly lease: string;
  readonly epoch: string;
  readonly deploymentId: string;
  readonly tool: string;
  readonly connector: string;
  readonly operation: string;
  readonly connectionId?: string;
  readonly generation?: string;
  readonly actorDigest: string;
  readonly intentDigest: string;
  readonly startedAt: number;
  readonly executionDeadline: number;
  readonly historyExpiresAt: number;
  readonly outcome: 'dispatching' | OperationEvidence['outcome'];
  /** Terminal dispatch time, not proof that an accepted external business task has completed. */
  readonly completedAt?: number;
  /** Protected reference only; no arguments, request/reply bodies, continuations or credentials. */
  readonly reference?: string;
}

export interface OperationEvidenceCursor {
  readonly startedAt: number;
  readonly id: string;
}
export interface OperationHistorySetting {
  readonly days: number;
  readonly revision: number;
}
export interface OperationEvidenceStore {
  preview(
    scope: InstallationScope,
    input: OperationHistoryPreviewInput,
  ): Promise<OperationHistoryPreviewCounts>;
  readRetention(scope: InstallationScope): Promise<OperationHistorySetting | undefined>;
  setRetention(
    scope: InstallationScope,
    days: number,
    expectedRevision: number | undefined,
  ): Promise<boolean>;
  claim(record: OperationEvidenceRecord): Promise<boolean>;
  finish(
    scope: InstallationScope,
    id: string,
    lease: string,
    epoch: string,
    evidence: OperationEvidence,
    now: number,
    historyDays?: number,
  ): Promise<boolean>;
  list(
    scope: InstallationScope,
    now: number,
    historyDays: number,
    limit: number,
    before?: OperationEvidenceCursor,
  ): Promise<readonly OperationEvidenceRecord[]>;
  /** Resolves expired execution as unknown and physically removes expired history. Never retries effects. */
  sweep(now: number): Promise<void>;
}

export interface OperationEvidenceOptions {
  readonly store: OperationEvidenceStore;
  readonly scope: InstallationScope;
  readonly deploymentId: string;
  readonly epoch: string;
  readonly identityKey: string;
  readonly now?: () => number;
  /** Live authorization/configuration/connection check. Absent authority fails before provider I/O. */
  readonly authorize: (intent: OperationEvidenceIntent) => Promise<boolean>;
  /** Derived from the bounded connector, independently of model/confirmation/history TTLs. */
  readonly executionBoundMs: (intent: OperationEvidenceIntent) => number | undefined;
  /** Authoritative current plan/operator history setting, not an entitlement supplied by a browser. */
  readonly historyDays: () => Promise<number>;
  readonly connectionGeneration: (connectionId: string) => string | undefined;
}

/** Generic execution evidence adapter. It stores no application input and cannot dispatch or replay work. */
export function createOperationEvidencePort(
  options: OperationEvidenceOptions,
): OperationEvidencePort {
  if (options.identityKey.length < 32 || !/^[A-Za-z0-9_-]{16,128}$/.test(options.epoch))
    throw new Error('Invalid operation evidence configuration');
  const hash = (value: unknown) =>
    createHmac('sha256', options.identityKey).update(canonicalJson(value)).digest('hex');
  const now = () => options.now?.() ?? Date.now();
  return {
    async begin(intent) {
      const startedAt = now();
      const bound = options.executionBoundMs(intent);
      const days = await options.historyDays();
      if (
        !Number.isSafeInteger(bound) ||
        bound === undefined ||
        bound < 1 ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > 365 ||
        bound >= days * 86_400_000 ||
        !(await options.authorize(intent))
      )
        throw new Error('Operation evidence authority unavailable');
      const connectionId = intent.operation.credentialBinding?.connectionId ?? intent.connectionId;
      const generation =
        connectionId === undefined ? undefined : options.connectionGeneration(connectionId);
      if (connectionId !== undefined && generation === undefined)
        throw new Error('Original connected account unavailable');
      const record: OperationEvidenceRecord = {
        scope: options.scope,
        id: intent.id,
        ...(intent.parentId === undefined ? {} : { parentId: intent.parentId }),
        lease: randomUUID(),
        epoch: options.epoch,
        deploymentId: options.deploymentId,
        tool: intent.tool,
        connector: intent.operation.connectorId,
        operation: intent.operation.operation,
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(generation === undefined ? {} : { generation }),
        actorDigest: hash(intent.caller ?? null),
        intentDigest: hash({
          scope: options.scope,
          deploymentId: options.deploymentId,
          epoch: options.epoch,
          operation: intent.operation,
          input: intent.arguments,
          caller: intent.caller ?? null,
          revision: intent.executionRevision ?? null,
          parentId: intent.parentId ?? null,
          generation: generation ?? null,
        }),
        startedAt,
        executionDeadline: startedAt + bound,
        historyExpiresAt: startedAt + days * 86_400_000,
        outcome: 'dispatching',
      };
      if (!(await options.store.claim(record))) return undefined;
      return {
        async finish(evidence) {
          const completionDays = await options.historyDays();
          if (!Number.isInteger(completionDays) || completionDays < 1 || completionDays > 365)
            throw new Error('Operation history policy unavailable');
          if (
            !(await options.store.finish(
              options.scope,
              record.id,
              record.lease,
              record.epoch,
              evidence,
              now(),
              completionDays,
            ))
          )
            throw new Error('Operation evidence claim expired');
        },
      };
    },
  };
}

/** Store adapters use the same narrow transition; late results cannot replace an expired/terminal claim. */
export function completeOperationEvidence(
  record: OperationEvidenceRecord,
  lease: string,
  epoch: string,
  evidence: OperationEvidence,
  now: number,
  historyDays?: number,
): OperationEvidenceRecord | undefined {
  if (
    record.lease !== lease ||
    record.epoch !== epoch ||
    record.outcome !== 'dispatching' ||
    record.executionDeadline <= now
  )
    return undefined;
  return {
    ...record,
    outcome: evidence.outcome,
    completedAt: now,
    historyExpiresAt:
      now +
      (historyDays === undefined
        ? record.historyExpiresAt - record.startedAt
        : historyDays * 86_400_000),
    ...(evidence.reference === undefined ? {} : { reference: evidence.reference }),
  };
}

export function operationEvidenceKey(scope: InstallationScope, id: string): string {
  return JSON.stringify([scope.org, scope.app, scope.env, scope.installationId, id]);
}
