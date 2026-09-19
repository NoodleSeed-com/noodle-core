import type { ApplicationDraft, ApplicationDraftSummary } from '@noodle-borg/wire-contracts';

export interface ApplicationDraftScope {
  readonly org: string;
  readonly app: string;
}

export interface DraftReceipt {
  readonly fingerprint: string;
  readonly draftId: string;
  readonly revision: number;
  readonly expiresAt: string;
}

/** Internal transaction port, never an untrusted client-supplied store. */
export interface ApplicationDraftTransaction {
  readonly now: string;
  get(id: string, revision?: number): Promise<ApplicationDraft | undefined>;
  heads(): Promise<readonly ApplicationDraftSummary[]>;
  history(id: string): Promise<readonly ApplicationDraftSummary[]>;
  /** Whole-workspace totals, serialized with writes across all application scopes. */
  capacity(): Promise<{ drafts: number; sourceBytes: number; receipts: number }>;
  append(draft: ApplicationDraft): Promise<void>;
  /** Erase source revisions, retaining opaque receipts until their fixed retry deadline. */
  remove(id: string): Promise<void>;
  receipt(key: string): Promise<DraftReceipt | undefined>;
  saveReceipt(key: string, receipt: DraftReceipt): Promise<void>;
}

export interface ApplicationDraftBackend {
  /** Serialize with workspace role mutations on the same organization authority lock. */
  run<T>(
    scope: ApplicationDraftScope,
    operation: (transaction: ApplicationDraftTransaction) => Promise<T>,
  ): Promise<T>;
}

export type DraftErrorCode =
  | 'invalid_draft'
  | 'forbidden'
  | 'not_found'
  | 'revision_conflict'
  | 'idempotency_conflict'
  | 'draft_limit'
  | 'revision_limit'
  | 'source_capacity'
  | 'retry_capacity'
  | 'draft_deleted';

export class ApplicationDraftError extends Error {
  constructor(
    readonly code: DraftErrorCode,
    readonly currentRevision?: number,
  ) {
    super(code);
    this.name = 'ApplicationDraftError';
  }
}
