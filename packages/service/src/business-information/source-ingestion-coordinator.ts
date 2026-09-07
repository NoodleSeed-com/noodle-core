import type { JsonObject } from './contracts.js';
import type {
  SourceBindingRecord,
  SourceIngestionLease,
  SourceIngestionStore,
  SourceOperationReference,
  SourceScanPage,
  SourceScanRequest,
} from './source-ingestion-contracts.js';
import { sourceErrorCode } from './source-ingestion-failures.js';
import { validateManagedPayload } from './validation.js';

export interface SourceReadExecutor {
  scan(input: {
    readonly binding: SourceBindingRecord;
    readonly operation: SourceOperationReference;
    readonly request: SourceScanRequest;
  }): Promise<SourceScanPage>;
}

export interface SourceIngestionCoordinatorOptions {
  readonly store: SourceIngestionStore;
  readonly executor: SourceReadExecutor;
  readonly workerId: string;
  readonly validateRecord: (binding: SourceBindingRecord, value: unknown) => JsonObject;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly retryMs?: number;
  readonly pageLimit?: number;
  readonly maxPagesPerRun?: number;
}

export type SourceIngestionRunResult =
  | { readonly disposition: 'idle' }
  | {
      readonly disposition: 'completed';
      readonly binding: SourceBindingRecord;
      readonly pages: number;
    }
  | { readonly disposition: 'reset'; readonly pages: number }
  | { readonly disposition: 'lost_lease'; readonly pages: number };

/** Executes only the normalized, read-only source protocol and commits through a fenced store. */
export class SourceIngestionCoordinator {
  readonly #store: SourceIngestionStore;
  readonly #executor: SourceReadExecutor;
  readonly #workerId: string;
  readonly #validateRecord: SourceIngestionCoordinatorOptions['validateRecord'];
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #retryMs: number;
  readonly #pageLimit: number;
  readonly #maxPagesPerRun: number;

  constructor(options: SourceIngestionCoordinatorOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#workerId = boundedToken('source worker id', options.workerId, 128);
    this.#validateRecord = options.validateRecord;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = boundedInteger('source lease', options.leaseMs ?? 60_000, 1_000, 15 * 60_000);
    this.#retryMs = boundedInteger('source retry', options.retryMs ?? 30_000, 1_000, 86_400_000);
    this.#pageLimit = boundedInteger('source page limit', options.pageLimit ?? 100, 1, 100);
    this.#maxPagesPerRun = boundedInteger(
      'source maximum pages',
      options.maxPagesPerRun ?? 100,
      1,
      10_000,
    );
  }

  async runOne(): Promise<SourceIngestionRunResult> {
    let lease = await this.#store.claimDue({
      now: this.#now(),
      workerId: this.#workerId,
      leaseMs: this.#leaseMs,
    });
    if (lease === undefined) return { disposition: 'idle' };
    let pages = 0;
    try {
      while (pages < this.#maxPagesPerRun) {
        const sourcePage = await this.#executor.scan({
          binding: lease.binding,
          operation: lease.binding.scan,
          request: requestFor(lease, this.#pageLimit),
        });
        if (sourcePage.resetRequired === true) {
          validateResetPage(sourcePage);
          await this.#store.resetCheckpoint({
            lease,
            now: this.#now(),
            errorCode: 'checkpoint_reset_required',
          });
          return { disposition: 'reset', pages };
        }
        const page = normalizePage(lease.binding, sourcePage, this.#validateRecord);
        const committed = await this.#store.commitPage({ lease, now: this.#now(), page });
        if (!committed.ok) return { disposition: 'lost_lease', pages };
        pages += 1;
        if (page.complete) {
          return { disposition: 'completed', binding: committed.binding, pages };
        }
        if (committed.lease === undefined)
          throw new Error('source page commit lost its continuation lease');
        lease = committed.lease;
      }
      throw sourceError('source_page_limit_exceeded');
    } catch (error) {
      if (sourceErrorCode(error) === 'invalid_checkpoint') {
        await this.#store.resetCheckpoint({
          lease,
          now: this.#now(),
          errorCode: 'checkpoint_reset_required',
        });
        return { disposition: 'reset', pages };
      }
      const now = this.#now();
      await this.#store.failLease({
        lease,
        now,
        errorCode: sourceErrorCode(error),
        retryAt: new Date(now.getTime() + this.#retryMs),
      });
      throw error;
    }
  }
}

function requestFor(lease: SourceIngestionLease, limit: number): SourceScanRequest {
  return {
    mode: lease.mode,
    ...(lease.cursor === undefined ? {} : { cursor: lease.cursor }),
    ...(lease.mode === 'changes' && lease.checkpoint !== undefined
      ? { checkpoint: lease.checkpoint }
      : {}),
    limit,
  };
}

function normalizePage(
  binding: SourceBindingRecord,
  page: SourceScanPage,
  validateRecord: SourceIngestionCoordinatorOptions['validateRecord'],
): SourceScanPage {
  if (page.records.length > 100 || page.deletedIds.length > 100) {
    throw sourceError('source_page_limit_exceeded');
  }
  const records = page.records.map((item) => ({
    id: item.id,
    ...(item.version === undefined ? {} : { version: item.version }),
    record: validateManagedPayload(validateRecord(binding, item.record)),
  }));
  return {
    records,
    deletedIds: [...page.deletedIds],
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    ...(page.checkpoint === undefined ? {} : { checkpoint: page.checkpoint }),
    complete: page.complete,
  };
}

function validateResetPage(page: SourceScanPage): void {
  if (
    page.complete ||
    page.records.length > 0 ||
    page.deletedIds.length > 0 ||
    page.nextCursor !== undefined ||
    page.checkpoint !== undefined
  ) {
    throw sourceError('invalid_source_reset');
  }
}

function sourceError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code.replaceAll('_', ' ')), { code });
}

function boundedInteger(label: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside the supported range`);
  }
  return value;
}

function boundedToken(label: string, value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}
