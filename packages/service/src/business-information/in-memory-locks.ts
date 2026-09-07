/** Process-local transaction serialization for the development business store. */
export class BusinessMemoryLocks {
  readonly #locks = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: (value: void | PromiseLike<void>) => void = () => void 0;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release(undefined);
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}
