/** Private channel journal. Each binding is a transaction/lease authority, not a browser session. */
export interface ChannelRow {
  readonly id: string;
  readonly kind:
    | 'binding'
    | 'asset'
    | 'participant'
    | 'event'
    | 'counter'
    | 'spend'
    | 'block'
    | 'mutation';
  readonly state?: string;
  readonly updatedAt: number;
  readonly expiresAt?: number;
  readonly value: unknown;
}
export interface ChannelScan {
  readonly kind: ChannelRow['kind'];
  readonly state?: string;
  readonly after?: string;
  readonly limit: number;
}
export interface ChannelTransaction {
  get(scope: string, id: string): Promise<ChannelRow | undefined>;
  put(scope: string, row: ChannelRow): Promise<void>;
  remove(scope: string, id: string): Promise<void>;
  count(scope: string, kind: ChannelRow['kind'], state: string, now: number): Promise<number>;
  list(scope: string, scan: ChannelScan): Promise<readonly ChannelRow[]>;
}
export interface ChannelStore {
  readonly durable: boolean;
  transaction<T>(
    locks: readonly string[],
    work: (tx: ChannelTransaction) => Promise<T>,
  ): Promise<T>;
  prune(now: number, limit: number): Promise<number>;
}
/** Composition supplies authenticated encryption bound to both channel and record identity. */
export interface ChannelCipher {
  seal(scope: string, id: string, value: unknown): Promise<unknown>;
  open(scope: string, id: string, sealed: unknown): Promise<unknown>;
}
export function channelScanLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('invalid channel scan limit');
  return limit;
}
export function requireChannelLock(locks: readonly string[], scope: string): void {
  if (!locks.includes(scope)) throw new Error('channel transaction requires scope lock');
}

/** Isolated local development adapter; never an acknowledged hosted-message authority. */
export class InMemoryChannelStore implements ChannelStore {
  readonly durable = false;
  #rows = new Map<string, Map<string, ChannelRow>>();
  #tail: Promise<void> = Promise.resolve();

  async transaction<T>(
    locks: readonly string[],
    work: (tx: ChannelTransaction) => Promise<T>,
  ): Promise<T> {
    const preceding = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    const rows = structuredClone(this.#rows);
    const scoped = (scope: string) => {
      requireChannelLock(locks, scope);
      let result = rows.get(scope);
      if (!result) {
        result = new Map();
        rows.set(scope, result);
      }
      return result;
    };
    try {
      const result = await work({
        get: async (scope, id) => structuredClone(scoped(scope).get(id)),
        put: async (scope, row) => {
          scoped(scope).set(row.id, structuredClone(row));
        },
        remove: async (scope, id) => {
          scoped(scope).delete(id);
        },
        count: async (scope, kind, state, now) =>
          [...scoped(scope).values()].filter(
            (row) =>
              row.kind === kind &&
              row.state === state &&
              (row.expiresAt === undefined || row.expiresAt > now),
          ).length,
        list: async (scope, scan) =>
          [...scoped(scope).values()]
            .filter(
              (row) =>
                row.kind === scan.kind &&
                (scan.state === undefined || row.state === scan.state) &&
                (scan.after === undefined || row.id > scan.after),
            )
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, channelScanLimit(scan.limit))
            .map((row) => structuredClone(row)),
      });
      this.#rows = rows;
      return result;
    } finally {
      release();
    }
  }

  async prune(now: number, limit: number): Promise<number> {
    channelScanLimit(limit);
    // Share the transaction lock with writes, including scopes first created concurrently.
    const scopes = [...this.#rows.keys()];
    return this.transaction(scopes, async (tx) => {
      let removed = 0;
      for (const scope of scopes)
        for (const row of this.#rows.get(scope)?.values() ?? []) {
          if (removed < limit && row.expiresAt !== undefined && row.expiresAt <= now) {
            await tx.remove(scope, row.id);
            removed++;
          }
        }
      return removed;
    });
  }
}
