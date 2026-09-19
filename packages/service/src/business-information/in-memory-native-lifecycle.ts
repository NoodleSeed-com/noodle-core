import type { NativeRecordLifecyclePreview } from '@noodle-borg/wire-contracts';
import type { InstallationScope, ManagedRequestRecord, SolutionInstallation } from './contracts.js';
import type { BusinessMemoryLocks } from './in-memory-locks.js';
import {
  checkLifecycleReview,
  type LifecycleReceipt,
  lifecyclePreview,
  NativeLifecycleError,
  type NativeRecordLifecycleStore,
  sameLifecycleReview,
} from './native-record-lifecycle.js';
import { type NativeStorageBudget, nativeCustodyBytes } from './native-storage-budget.js';
import { scopeKey } from './pagination.js';
import type { BusinessPrincipalAuthority } from './principal-authority.js';
import type { BusinessStaffAuthority } from './staff-authority.js';
import { validateScalar, validateScope } from './validation.js';

/** Local/test only. No await between inventory verification and the synchronous atomic commit. */
export class InMemoryNativeRecordLifecycle implements NativeRecordLifecycleStore {
  readonly #receipts = new Map<string, LifecycleReceipt>();
  constructor(
    private readonly options: {
      installations: Map<string, SolutionInstallation>;
      records: Map<string, ManagedRequestRecord>;
      locks: BusinessMemoryLocks;
      staff: BusinessStaffAuthority;
      principals: BusinessPrincipalAuthority;
      budget: NativeStorageBudget;
      now: () => Date;
    },
  ) {}
  preview(scope: InstallationScope, actor: string) {
    return this.run(scope, actor, (installation) =>
      lifecyclePreview(installation, this.inventory(scope), this.options.now().toISOString()),
    );
  }
  migrate(input: {
    scope: InstallationScope;
    actor: string;
    preview: NativeRecordLifecyclePreview;
  }) {
    return this.run(input.scope, input.actor, (installation) => {
      const key = scopeKey(input.scope);
      const receipt = this.#receipts.get(key);
      if (
        receipt &&
        sameLifecycleReview(receipt.preview, input.preview) &&
        receipt.actor === input.actor
      )
        return { ...receipt.result, replayed: true };
      const now = this.options.now().toISOString();
      checkLifecycleReview(installation, this.inventory(input.scope), input.preview, now);
      const updates: [string, ManagedRequestRecord][] = [];
      let beforeBytes = 0,
        afterBytes = 0;
      for (const [recordKey, record] of this.options.records) {
        if (
          scopeKey(record.scope) !== key ||
          record.deletedAt ||
          record.retentionExpiresAt === null ||
          record.retentionExpiresAt <= now
        )
          continue;
        const next = { ...record, retentionExpiresAt: null };
        beforeBytes += nativeCustodyBytes(record);
        afterBytes += nativeCustodyBytes(next);
        updates.push([recordKey, next]);
      }
      const result = {
        policy: 'explicit_erasure' as const,
        installationRevision: installation.revision + 1,
        recordsPreserved: updates.length,
        replayed: false,
      };
      this.options.budget.replace(key, beforeBytes, afterBytes);
      for (const [id, record] of updates) this.options.records.set(id, record);
      this.options.installations.set(key, {
        ...installation,
        nativeRecordLifecycle: 'explicit_erasure',
        revision: result.installationRevision,
        updatedAt: now,
        updatedBySubject: input.actor,
      });
      this.#receipts.set(key, {
        preview: structuredClone(input.preview),
        actor: input.actor,
        result,
      });
      return result;
    });
  }
  private inventory(scope: InstallationScope) {
    return [...this.options.records.values()].filter(
      (r) => scopeKey(r.scope) === scopeKey(scope) && !r.deletedAt,
    );
  }
  private run<T>(
    input: InstallationScope,
    actor: string,
    work: (installation: SolutionInstallation) => T,
  ): Promise<T> {
    const scope = validateScope(input);
    validateScalar('actor', actor, 256);
    const { staff, locks, principals } = this.options;
    return staff.run(
      scope,
      actor,
      'installation:administer',
      () =>
        locks.run(`grants:${scopeKey(scope)}`, () =>
          locks.run(`intake:${scopeKey(scope)}`, async () => {
            if (
              !(await staff.allows(scope, actor, 'installation:administer')) ||
              !(await principals.allows(actor))
            )
              throw new NativeLifecycleError('lifecycle_denied');
            const installation = this.options.installations.get(scopeKey(scope));
            if (!installation) throw new NativeLifecycleError('lifecycle_unavailable');
            return work(installation);
          }),
        ),
      () => new NativeLifecycleError('lifecycle_denied'),
    );
  }
}
