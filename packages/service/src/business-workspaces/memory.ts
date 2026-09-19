import { BusinessMemoryLocks } from '../business-information/in-memory-locks.js';
import {
  type BusinessWorkspaceBackend,
  type BusinessWorkspaceTransaction,
  type WorkspaceAuditEvent,
  type WorkspaceState,
  WorkspaceStateSchema,
} from './contracts.js';

/** Local/test adapter only. Share the lock instance with other workspace authorities. */
export class InMemoryBusinessWorkspaceBackend implements BusinessWorkspaceBackend {
  readonly #states = new Map<string, WorkspaceState>();
  readonly #events = new Map<string, WorkspaceAuditEvent[]>();
  constructor(
    private readonly locks = new BusinessMemoryLocks(),
    private readonly now: () => Date = () => new Date(),
  ) {}
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
    return this.locks.run(`business-workspace:${org}`, async () => {
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
    });
  }
}
