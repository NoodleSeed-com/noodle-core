import type { InstallationScope, JsonObject, ManagedRetentionDays } from './contracts.js';

export interface SourceOperationReference {
  readonly connector: string;
  readonly connectorVersion: string;
  readonly operation: string;
  readonly signatureDigest: string;
}

export interface SourceBindingKey {
  readonly scope: InstallationScope;
  readonly collectionKey: string;
  readonly id: string;
}

export interface SourceBindingCreate extends SourceBindingKey {
  /** Service-captured opaque credential/account fence; never accepted from operator HTTP input. */
  readonly credentialIdentity?: {
    readonly generation?: string;
    readonly account?: string;
    readonly configuration?: string;
  };
  readonly bindingReference?: string;
  readonly configurationReference?: string;
  readonly generation: number;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly queryFingerprint: string;
  readonly scan: SourceOperationReference;
  readonly retentionDays: ManagedRetentionDays;
  readonly pollIntervalMs: number;
}

export type SourceHealth =
  | 'initializing'
  | 'current'
  | 'stale'
  | 'paused'
  | 'reauth_required'
  | 'failed';

export interface SourceBindingRecord extends SourceBindingCreate {
  readonly state: 'active' | 'paused' | 'revoked';
  readonly health: SourceHealth;
  readonly completeness: 'complete' | 'incomplete';
  readonly revision: number;
  readonly fence: number;
  readonly scanGeneration: number;
  readonly scanMode?: SourceScanMode;
  readonly cursor?: string;
  readonly checkpoint?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly lastSuccessfulSyncAt?: string;
  readonly nextAttemptAt?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SourceScanMode = 'snapshot' | 'changes';

export interface SourceScanRequest {
  readonly mode: SourceScanMode;
  readonly cursor?: string;
  readonly checkpoint?: string;
  readonly limit: number;
}

export interface SourceScanRecord {
  readonly id: string;
  readonly version?: string;
  readonly record: JsonObject;
}

export interface SourceScanPage {
  readonly records: readonly SourceScanRecord[];
  readonly deletedIds: readonly string[];
  readonly nextCursor?: string;
  readonly checkpoint?: string;
  readonly complete: boolean;
  readonly resetRequired?: boolean;
}

export interface SourceIngestionLease {
  readonly binding: SourceBindingRecord;
  readonly owner: string;
  readonly fence: number;
  readonly scanGeneration: number;
  readonly mode: SourceScanMode;
  readonly cursor?: string;
  readonly checkpoint?: string;
  readonly expiresAt: string;
  readonly leaseMs: number;
}

export interface ExternalRecord {
  readonly scope: InstallationScope;
  readonly collectionKey: string;
  readonly id: string;
  readonly authority: 'external';
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly source: {
    readonly bindingId: string;
    readonly bindingGeneration: number;
    readonly id: string;
    readonly version?: string;
  };
  readonly record?: JsonObject;
  readonly revision: number;
  readonly completeness: 'complete' | 'incomplete';
  readonly observedAt: string;
  readonly lastSuccessfulSyncAt?: string;
  readonly retentionExpiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

export interface ExternalRecordPage {
  readonly records: readonly ExternalRecord[];
  readonly nextCursor?: string;
}

export interface ExternalRecordListRequest extends SourceBindingKey {
  readonly generation: number;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ExternalRecordLookup extends SourceBindingKey {
  readonly generation: number;
  readonly recordId: string;
}

export interface SourceSuppressionRecord extends SourceBindingKey {
  readonly bindingGeneration: number;
  readonly sourceIdentityDigest: string;
  readonly reason: 'customer_request' | 'source_access_revoked';
  readonly erasedAt: string;
}

export type SourcePageCommitResult =
  | {
      readonly ok: true;
      readonly binding: SourceBindingRecord;
      readonly lease?: SourceIngestionLease;
    }
  | { readonly ok: false; readonly reason: 'stale_fence' | 'stale_cursor' };

export type SourceBindingMutationResult =
  | { readonly ok: true; readonly binding: SourceBindingRecord }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'invalid_state';
      readonly currentRevision: number;
    };

export interface SourceRefreshReceipt {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'completed' | 'superseded';
  readonly coalesced: boolean;
  readonly requestedAt: string;
  readonly replayExpiresAt?: string;
}

export type SourceRefreshRequestResult =
  | {
      readonly ok: true;
      readonly binding: SourceBindingRecord;
      readonly receipt: SourceRefreshReceipt;
    }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'invalid_state';
      readonly currentRevision: number;
    };

export interface SourceIngestionStore {
  createBinding(input: SourceBindingCreate): Promise<SourceBindingRecord>;
  replaceBinding(
    input: SourceBindingCreate & {
      readonly expectedRevision: number;
      readonly now: Date;
    },
  ): Promise<SourceBindingMutationResult>;
  getBinding(input: SourceBindingKey): Promise<SourceBindingRecord | undefined>;
  setBindingState(
    input: SourceBindingKey & {
      readonly expectedRevision: number;
      readonly state: 'active' | 'paused';
      readonly now: Date;
    },
  ): Promise<SourceBindingMutationResult>;
  requestRefresh(
    input: SourceBindingKey & {
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
      readonly now: Date;
    },
  ): Promise<SourceRefreshRequestResult>;
  claimDue(input: {
    readonly now: Date;
    readonly workerId: string;
    readonly leaseMs: number;
  }): Promise<SourceIngestionLease | undefined>;
  commitPage(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly page: SourceScanPage;
  }): Promise<SourcePageCommitResult>;
  resetCheckpoint(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly errorCode: string;
  }): Promise<boolean>;
  failLease(input: {
    readonly lease: SourceIngestionLease;
    readonly now: Date;
    readonly errorCode: string;
    readonly retryAt: Date;
  }): Promise<boolean>;
  listExternalRecords(input: ExternalRecordListRequest): Promise<ExternalRecordPage>;
  getExternalRecord(input: ExternalRecordLookup): Promise<ExternalRecord | undefined>;
  suppressExternalRecord(
    input: SourceBindingKey & {
      readonly sourceId: string;
      readonly reason: SourceSuppressionRecord['reason'];
      readonly now: Date;
    },
  ): Promise<void>;
  listSuppressions(input: SourceBindingKey): Promise<readonly SourceSuppressionRecord[]>;
  restoreSuppressions(input: readonly SourceSuppressionRecord[]): Promise<void>;
  /** Erases expired replica payloads without suppressing a later fresh source observation. */
  purgeExpired(input: { readonly limit?: number }): Promise<number>;
}
