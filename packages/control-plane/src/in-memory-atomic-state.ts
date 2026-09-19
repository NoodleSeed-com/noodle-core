import { AsyncLocalStorage } from 'node:async_hooks';

interface Participant {
  readonly value: unknown;
  validate(): void;
  commit(): void;
}
interface Transaction {
  readonly participants: Map<object, Participant>;
  closed: boolean;
  pending: number;
  failure?: { readonly error: unknown };
}

/** Development-only composition. PostgreSQL remains the production transaction authority. */
export class InMemoryAtomicState {
  readonly #current = new AsyncLocalStorage<Transaction>();
  #tail: Promise<void> = Promise.resolve();

  /** Values retain normal Map reference semantics; owners validate and copy their records. */
  map<K, V>(): Map<K, V> {
    return new AtomicMap<K, V>(() => {
      const transaction = this.#current.getStore();
      if (transaction?.closed) throw new Error('memory transaction is closed');
      return transaction;
    });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const inherited = this.#current.getStore();
    if (inherited) {
      if (inherited.closed) throw new Error('memory transaction is closed');
      inherited.pending++;
      try {
        return await operation();
      } catch (error) {
        inherited.failure ??= { error };
        throw error;
      } finally {
        inherited.pending--;
      }
    }
    const prior = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((done) => {
      release = done;
    });
    await prior;
    const transaction: Transaction = { participants: new Map(), closed: false, pending: 0 };
    try {
      const result = await this.#current.run(transaction, operation);
      if (transaction.failure) throw transaction.failure.error;
      if (transaction.pending !== 0) throw new Error('memory transaction has unfinished work');
      // Validate every generation before any publication. Nonparticipating mutations survive a conflict.
      for (const participant of transaction.participants.values()) participant.validate();
      for (const participant of transaction.participants.values()) participant.commit();
      return result;
    } finally {
      transaction.closed = true;
      release();
    }
  }
}

interface Draft<K, V> {
  readonly entries: Map<K, V>;
  dirty: boolean;
}

/** Private maps never restore a process-wide snapshot or expose staged entries to another request. */
class AtomicMap<K, V> implements Map<K, V> {
  readonly [Symbol.toStringTag] = 'Map';
  #entries = new Map<K, V>();
  #generation = 0;
  constructor(private readonly transaction: () => Transaction | undefined) {}

  #view(mutate = false): Map<K, V> {
    const transaction = this.transaction();
    if (!transaction) {
      if (mutate) this.#generation++;
      return this.#entries;
    }
    let participant = transaction.participants.get(this);
    if (!participant) {
      const generation = this.#generation;
      const draft: Draft<K, V> = { entries: new Map(this.#entries), dirty: false };
      participant = {
        value: draft,
        validate: () => {
          if (generation !== this.#generation) throw new Error('memory transaction conflict');
        },
        commit: () => {
          if (!draft.dirty) return;
          this.#entries = draft.entries;
          this.#generation++;
        },
      };
      transaction.participants.set(this, participant);
    }
    // The unexposed map instance is the type-stable key for this participant.
    const draft = participant.value as Draft<K, V>;
    if (mutate) draft.dirty = true;
    return draft.entries;
  }
  get size(): number {
    return this.#view().size;
  }
  get(key: K): V | undefined {
    return this.#view().get(key);
  }
  has(key: K): boolean {
    return this.#view().has(key);
  }
  set(key: K, value: V): this {
    this.#view(true).set(key, value);
    return this;
  }
  delete(key: K): boolean {
    return this.#view(true).delete(key);
  }
  clear(): void {
    this.#view(true).clear();
  }
  entries(): MapIterator<[K, V]> {
    return this.#view().entries();
  }
  keys(): MapIterator<K> {
    return this.#view().keys();
  }
  values(): MapIterator<V> {
    return this.#view().values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.#view().forEach((value, key) => {
      callback.call(thisArg, value, key, this);
    });
  }
}
