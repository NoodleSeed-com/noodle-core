import type {
  AppPurgeReconciliationApplyRequestV1,
  AppPurgeReconciliationApplyResponseV1,
  AppPurgeReconciliationErrorCodeV1,
  AppPurgeReconciliationPreviewArtifactV1,
} from '@noodle-borg/wire-contracts';

export interface AppPurgeReconciliationActor {
  readonly subject: string;
  readonly email?: string;
}

export interface AppPurgeReconciliationOperator {
  preview(input: {
    readonly releaseSha: string;
    readonly limit: number;
    readonly now: Date;
  }): Promise<AppPurgeReconciliationPreviewArtifactV1>;
  apply(input: {
    readonly request: AppPurgeReconciliationApplyRequestV1;
    readonly actor: AppPurgeReconciliationActor;
    readonly currentReleaseSha: string;
    readonly now: Date;
  }): Promise<AppPurgeReconciliationApplyResponseV1>;
}

export type AppPurgeReconciliationConflictCode = Exclude<
  AppPurgeReconciliationErrorCodeV1,
  'app_purge_reconciliation_unavailable'
>;

/** A checked operator conflict; query and transaction failures intentionally remain ordinary errors. */
export class AppPurgeReconciliationError extends Error {
  readonly code: AppPurgeReconciliationConflictCode;

  constructor(code: AppPurgeReconciliationConflictCode, message: string) {
    super(message);
    this.name = 'AppPurgeReconciliationError';
    this.code = code;
  }
}
