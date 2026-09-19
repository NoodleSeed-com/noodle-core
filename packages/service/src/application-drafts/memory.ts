import type { ApplicationDraft } from '@noodle-borg/wire-contracts';
import { BusinessMemoryLocks } from '../business-information/in-memory-locks.js';
import type {
  ApplicationDraftBackend,
  ApplicationDraftScope,
  ApplicationDraftTransaction,
  DraftReceipt,
} from './contracts.js';
import { applicationDraftSourceBytes } from './store.js';

interface State {
  revisions: Map<string, ApplicationDraft[]>;
  receipts: Map<string, DraftReceipt>;
}

/** Development/test only. Hosted composition must explicitly supply durable PostgreSQL. */
export class InMemoryApplicationDraftBackend implements ApplicationDraftBackend {
  readonly #states = new Map<string, State>();
  constructor(
    private readonly locks = new BusinessMemoryLocks(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run<T>(
    scope: ApplicationDraftScope,
    operation: (transaction: ApplicationDraftTransaction) => Promise<T>,
  ): Promise<T> {
    return this.locks.run(`business-workspace:${scope.org}`, async () => {
      const key = scope.org;
      const state = structuredClone(
        this.#states.get(key) ?? {
          revisions: new Map<string, ApplicationDraft[]>(),
          receipts: new Map<string, DraftReceipt>(),
        },
      );
      const now = this.now().toISOString();
      const draftKey = (id: string) => JSON.stringify([scope.app, id]);
      const result = await operation({
        now,
        get: async (id, revision) => {
          const revisions = state.revisions.get(draftKey(id));
          return structuredClone(
            revision === undefined
              ? revisions?.at(-1)
              : revisions?.find((item) => item.revision === revision),
          );
        },
        heads: async () =>
          [...state.revisions.values()].flatMap((revisions) => {
            const head = revisions.at(-1);
            if (head?.app !== scope.app) return [];
            const { source: _source, ...metadata } = head;
            return [structuredClone(metadata)];
          }),
        history: async (id) =>
          (state.revisions.get(draftKey(id)) ?? [])
            .map(({ source: _source, ...metadata }) => structuredClone(metadata))
            .reverse(),
        capacity: async () => {
          for (const [receiptKey, receipt] of state.receipts) {
            if (Date.parse(receipt.expiresAt) <= Date.parse(now)) state.receipts.delete(receiptKey);
          }
          return {
            drafts: state.revisions.size,
            receipts: state.receipts.size,
            sourceBytes: [...state.revisions.values()]
              .flat()
              .reduce((bytes, draft) => bytes + applicationDraftSourceBytes(draft.source), 0),
          };
        },
        append: async (draft) => {
          const revisions = state.revisions.get(draftKey(draft.id)) ?? [];
          if (draft.revision !== revisions.length + 1) throw new Error('draft append conflict');
          revisions.push(structuredClone(draft));
          state.revisions.set(draftKey(draft.id), revisions);
        },
        receipt: async (receiptKey) => {
          const receipt = state.receipts.get(draftKey(receiptKey));
          return receipt && Date.parse(receipt.expiresAt) > Date.parse(now)
            ? structuredClone(receipt)
            : undefined;
        },
        remove: async (id) => {
          state.revisions.delete(draftKey(id));
        },
        saveReceipt: async (receiptKey, receipt) => {
          if (state.receipts.has(draftKey(receiptKey))) throw new Error('draft receipt conflict');
          state.receipts.set(draftKey(receiptKey), structuredClone(receipt));
        },
      });
      this.#states.set(key, state);
      return structuredClone(result);
    });
  }
}
