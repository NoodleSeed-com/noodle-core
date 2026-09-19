import type { InMemoryAtomicState } from '@noodle-borg/control-plane/portable';
import { BusinessMemoryLocks } from '../business-information/in-memory-locks.js';
import {
  type BusinessWorkspaceBackend,
  type BusinessWorkspaceTransaction,
  type WorkspaceAuditEvent,
  type WorkspaceState,
  WorkspaceStateSchema,
} from './contracts.js';

/** Local/test only: share legacy locks, or one atomic context with every transaction participant. */
export class InMemoryBusinessWorkspaceBackend implements BusinessWorkspaceBackend {
  readonly #states: Map<string, WorkspaceState>;
  readonly #events: Map<string, WorkspaceAuditEvent[]>;
  readonly #locks: BusinessMemoryLocks;
  constructor(
    locks?: BusinessMemoryLocks,
    private readonly now: () => Date = () => new Date(),
    private readonly transactions?: InMemoryAtomicState,
  ) {
    // Shared-context composition must not quietly bypass a caller's separate draft authority lock.
    if (transactions && locks)
      throw new Error('choose shared memory transactions or legacy workspace locks, not both');
    this.#locks = locks ?? new BusinessMemoryLocks();
    this.#states = transactions?.map() ?? new Map();
    this.#events = transactions?.map() ?? new Map();
  }
  async findMemberships(
    subject: string,
    input: { readonly after?: string; readonly limit: number },
  ): Promise<readonly string[]> {
    return [...this.#states.values()]
      .filter(
        (state) =>
          (!input.after || state.org > input.after) &&
          state.members.some((member) => member.subject === subject),
      )
      .map((state) => state.org)
      .sort()
      .slice(0, input.limit);
  }
  async read(org: string): Promise<WorkspaceState | undefined> {
    return structuredClone(this.#states.get(org));
  }
  run<T>(org: string, work: (tx: BusinessWorkspaceTransaction) => Promise<T>): Promise<T> {
    if (this.transactions)
      return this.transactions.run(async () => {
        const result = await work({
          now: this.now().toISOString(),
          get: () => this.read(org),
          save: async (value, event) => {
            const state = WorkspaceStateSchema.parse(value);
            if (
              state.org !== org ||
              state.revision !== (this.#states.get(org)?.revision ?? 0) + 1 ||
              event.revision !== state.revision
            )
              throw new Error('workspace authority conflict');
            this.#states.set(org, state);
            this.#events.set(org, [...(this.#events.get(org) ?? []), structuredClone(event)]);
          },
        });
        return structuredClone(result);
      });
    const operation = async () => {
      let state = await this.read(org);
      const events = structuredClone(this.#events.get(org) ?? []);
      const result = await work({
        now: this.now().toISOString(),
        get: async () => structuredClone(state),
        save: async (value, event) => {
          const parsed = WorkspaceStateSchema.parse(value);
          if (
            parsed.org !== org ||
            parsed.revision !== (state?.revision ?? 0) + 1 ||
            event.revision !== parsed.revision
          ) {
            throw new Error('workspace authority conflict');
          }
          state = parsed;
          events.push(structuredClone(event));
        },
      });
      if (state) this.#states.set(org, structuredClone(state));
      this.#events.set(org, events);
      return structuredClone(result);
    };
    return this.#locks.run(`business-workspace:${org}`, operation);
  }
}
