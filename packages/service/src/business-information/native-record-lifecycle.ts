import { createHash } from 'node:crypto';
import {
  type NativeRecordLifecyclePreview,
  NativeRecordLifecyclePreviewSchema,
  type NativeRecordLifecycleResult,
} from '@noodle-borg/wire-contracts';
import type { InstallationScope, ManagedRequestRecord, SolutionInstallation } from './contracts.js';
import { scopeKey } from './pagination.js';

export class NativeLifecycleError extends Error {
  constructor(readonly code: 'lifecycle_denied' | 'lifecycle_conflict' | 'lifecycle_unavailable') {
    super(code);
  }
}
export interface NativeRecordLifecycleStore {
  preview(scope: InstallationScope, actor: string): Promise<NativeRecordLifecyclePreview>;
  migrate(input: {
    readonly scope: InstallationScope;
    readonly actor: string;
    readonly preview: NativeRecordLifecyclePreview;
  }): Promise<NativeRecordLifecycleResult>;
}
export type LifecycleInventory = Pick<
  ManagedRequestRecord,
  'collectionKey' | 'id' | 'revision' | 'retentionExpiresAt' | 'deletedAt'
>;
export interface LifecycleReceipt {
  readonly preview: NativeRecordLifecyclePreview;
  readonly actor: string;
  readonly result: NativeRecordLifecycleResult;
}
export const LIFECYCLE_REVIEW_MS = 5 * 60_000;
// A live record prepays a 16 KiB terminal reserve inside the 1 GiB custody ceiling.
export const LIFECYCLE_INVENTORY_LIMIT = 65_536;

export function sameLifecycleReview(
  expected: NativeRecordLifecyclePreview,
  input: NativeRecordLifecyclePreview,
): boolean {
  const parsed = NativeRecordLifecyclePreviewSchema.safeParse(input);
  return (
    parsed.success &&
    JSON.stringify(NativeRecordLifecyclePreviewSchema.parse(expected)) ===
      JSON.stringify(parsed.data)
  );
}

/** Digest is an optimistic review precondition, never a bearer authorization token. No payload reads. */
export function lifecyclePreview(
  installation: SolutionInstallation,
  records: readonly LifecycleInventory[],
  observedAt: string,
  now = observedAt,
): NativeRecordLifecyclePreview {
  if (records.length > LIFECYCLE_INVENTORY_LIMIT)
    throw new NativeLifecycleError('lifecycle_unavailable');
  const sorted = [...records].sort((a, b) => {
    const left = `${a.collectionKey}\0${a.id}`,
      right = `${b.collectionKey}\0${b.id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const rows = sorted.map((r) => [
    r.collectionKey,
    r.id,
    r.revision,
    r.retentionExpiresAt,
    r.deletedAt ?? null,
    r.retentionExpiresAt !== null && r.retentionExpiresAt <= now,
  ]);
  const values = {
    policy: installation.nativeRecordLifecycle ?? 'legacy_expiry',
    installationRevision: installation.revision,
    observedAt,
    recordsToPreserve: records.filter(
      (r) => !r.deletedAt && r.retentionExpiresAt !== null && r.retentionExpiresAt > now,
    ).length,
    expiredRecords: records.filter(
      (r) => !r.deletedAt && r.retentionExpiresAt !== null && r.retentionExpiresAt <= now,
    ).length,
  };
  return NativeRecordLifecyclePreviewSchema.parse({
    ...values,
    digest: createHash('sha256')
      .update(JSON.stringify([scopeKey(installation.scope), values, rows]))
      .digest('hex'),
  });
}

export function checkLifecycleReview(
  installation: SolutionInstallation,
  records: readonly LifecycleInventory[],
  input: NativeRecordLifecyclePreview,
  now: string,
) {
  const parsed = NativeRecordLifecyclePreviewSchema.safeParse(input);
  if (!parsed.success) throw new NativeLifecycleError('lifecycle_conflict');
  const age = Date.parse(now) - Date.parse(input.observedAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > LIFECYCLE_REVIEW_MS ||
    JSON.stringify(lifecyclePreview(installation, records, input.observedAt, now)) !==
      JSON.stringify(parsed.data) ||
    input.policy !== 'legacy_expiry'
  )
    throw new NativeLifecycleError('lifecycle_conflict');
}
