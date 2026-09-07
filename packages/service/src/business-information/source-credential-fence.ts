import type { SourceBindingCreate, SourceIngestionStore } from './source-ingestion-contracts.js';

export interface SourceCredentialIdentity {
  readonly generation?: string;
  readonly account?: string;
  readonly configuration?: string;
}
export interface SourceCredentialAuthority {
  /** Hold the credential authority lock while work reads/commits source state; never during provider I/O. */
  withCurrent<T>(
    binding: SourceBindingCreate,
    work: (identity: SourceCredentialIdentity | undefined) => Promise<T>,
  ): Promise<T>;
}
export class SourceCredentialError extends Error {
  readonly code = 'source_authorization_lost';
  constructor() {
    super('source_authorization_lost');
  }
}

const fenced = new WeakMap<
  SourceIngestionStore,
  { raw: SourceIngestionStore; authority: SourceCredentialAuthority | undefined }
>();

/** Every source consumer uses this same adapter; persisted portable bindings cannot silently fall back. */
export function fenceSourceStore(
  store: SourceIngestionStore,
  authority?: SourceCredentialAuthority,
): SourceIngestionStore {
  const prior = fenced.get(store);
  if (prior?.authority === authority && prior !== undefined) return store;
  if (prior) store = prior.raw;
  const current = <T>(
    binding: SourceBindingCreate,
    work: (identity: SourceCredentialIdentity | undefined) => Promise<T>,
  ) => (authority ? authority.withCurrent(binding, work) : work(undefined));
  const guard = <T>(binding: SourceBindingCreate, work: () => Promise<T>) =>
    current(binding, (identity) => {
      if (
        identity?.generation !== binding.credentialIdentity?.generation ||
        identity?.account !== binding.credentialIdentity?.account ||
        identity?.configuration !== binding.credentialIdentity?.configuration
      )
        throw new SourceCredentialError();
      return work();
    });
  const captured = <T>(
    binding: SourceBindingCreate,
    work: (value: SourceBindingCreate) => Promise<T>,
  ) =>
    current(binding, (identity) => {
      if (!identity && binding.credentialIdentity) throw new SourceCredentialError();
      const { credentialIdentity: ignored, ...rest } = binding;
      void ignored;
      return work({ ...rest, ...(identity ? { credentialIdentity: identity } : {}) });
    });
  async function read<T>(
    input: Parameters<SourceIngestionStore['getBinding']>[0],
    work: () => Promise<T>,
  ): Promise<T> {
    const binding = await store.getBinding(input);
    return binding ? guard(binding, work) : work();
  }
  const result: SourceIngestionStore = {
    createBinding: (input) => captured(input, (value) => store.createBinding(value)),
    replaceBinding: async (input) => {
      const previous = await store.getBinding(input);
      if (previous?.credentialIdentity && !input.credentialIdentity)
        input = { ...input, credentialIdentity: previous.credentialIdentity };
      return captured(input, (value) =>
        store.replaceBinding({
          ...value,
          expectedRevision: input.expectedRevision,
          now: input.now,
        }),
      );
    },
    getBinding: (input) => store.getBinding(input),
    setBindingState: (input) => store.setBindingState(input),
    requestRefresh: (input) => read(input, () => store.requestRefresh(input)),
    claimDue: async (input) => {
      const lease = await store.claimDue(input);
      if (!lease) return undefined;
      try {
        return await guard(lease.binding, async () => lease);
      } catch (error) {
        await store.failLease({
          lease,
          now: input.now,
          errorCode: 'source_authorization_lost',
          retryAt: new Date(input.now.getTime() + 30_000),
        });
        throw error;
      }
    },
    commitPage: (input) => guard(input.lease.binding, () => store.commitPage(input)),
    resetCheckpoint: (input) => store.resetCheckpoint(input),
    failLease: (input) => store.failLease(input),
    listExternalRecords: (input) => read(input, () => store.listExternalRecords(input)),
    getExternalRecord: (input) => read(input, () => store.getExternalRecord(input)),
    suppressExternalRecord: (input) => store.suppressExternalRecord(input),
    listSuppressions: (input) => store.listSuppressions(input),
    restoreSuppressions: (input) => store.restoreSuppressions(input),
    purgeExpired: (input) => store.purgeExpired(input),
  };
  fenced.set(result, { raw: store, authority });
  return result;
}
