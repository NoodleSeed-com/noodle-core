import type { ManagedRequestActivity, ManagedRequestRecord } from './contracts.js';

/** Engineering bound, not a commercial storage allowance or estimate of disk/WAL usage. */
export const NATIVE_RETAINED_BYTES_LIMIT = 1024 ** 3;
/** Prepaid by every live record; funds the bounded terminal receipt even at the ceiling. */
export const NATIVE_TERMINAL_RESERVE_BYTES = 16 * 1024;

export class NativeStorageLimitError extends Error {
  readonly code = 'managed_record_storage_limit';
  constructor() {
    super('Managed record storage is full. Erase retained records to reclaim capacity.');
    this.name = 'NativeStorageLimitError';
  }
}

/** Local/test accounting uses its plaintext serialized representation; PostgreSQL counts ciphertext. */
export function nativeCustodyBytes(value: ManagedRequestRecord | ManagedRequestActivity): number {
  return (
    Buffer.byteLength(JSON.stringify(value), 'utf8') +
    ('retentionExpiresAt' in value && value.deletedAt === undefined
      ? NATIVE_TERMINAL_RESERVE_BYTES
      : 0)
  );
}

export class NativeStorageBudget {
  readonly #totals = new Map<string, number>();
  constructor(private readonly maximum = NATIVE_RETAINED_BYTES_LIMIT) {}
  replace(scope: string, previousBytes: number, nextBytes: number): void {
    const current = this.#totals.get(scope) ?? 0;
    const delta = nextBytes - previousBytes;
    const next = current + delta;
    if (!Number.isSafeInteger(next) || next < 0)
      throw new Error('Invalid native custody accounting');
    if (delta > 0 && next > this.maximum) throw new NativeStorageLimitError();
    this.#totals.set(scope, next);
  }
}

/** Commit checks precede every map mutation, including history and the caller's idempotency insert. */
export function commitNativeMemoryRecord(
  records: Map<string, ManagedRequestRecord>,
  activities: Map<string, ManagedRequestActivity[]>,
  budget: NativeStorageBudget,
  key: string,
  record: ManagedRequestRecord,
  activity: ManagedRequestActivity,
): void {
  const previous = records.get(key);
  const history = activities.get(key) ?? [];
  let previousBytes = previous === undefined ? 0 : nativeCustodyBytes(previous);
  let nextBytes = nativeCustodyBytes(record) + nativeCustodyBytes(activity);
  let retainedHistory = history;
  if (record.deletedAt !== undefined) {
    retainedHistory = history.map((entry) => {
      const { content: ignored, ...metadata } = entry;
      void ignored;
      previousBytes += nativeCustodyBytes(entry);
      nextBytes += nativeCustodyBytes(metadata);
      return metadata;
    });
  }
  const scope = record.scope;
  budget.replace(
    `${scope.org}\0${scope.app}\0${scope.env}\0${scope.installationId}`,
    previousBytes,
    nextBytes,
  );
  records.set(key, record);
  if (retainedHistory !== history || previous === undefined)
    activities.set(key, [...retainedHistory, activity]);
  else history.push(activity);
}
