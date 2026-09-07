import { expect, it, vi } from 'vitest';
import { fenceSourceStore } from '../src/business-information/source-credential-fence.js';
import type {
  SourceBindingCreate,
  SourceIngestionStore,
} from '../src/business-information/source-ingestion-contracts.js';
import { PortableConnections } from '../src/connections/service.js';
import type { ConnectionStore } from '../src/connections/types.js';
import { oauthFixture } from './connection-oauth-fixture.js';

export const sourceBinding: SourceBindingCreate = {
  scope: { org: 'one', app: 'workflow', env: 'prod', installationId: 'installation-one' },
  collectionKey: 'stock',
  id: 'stock',
  generation: 1,
  schemaVersion: 1,
  schemaDigest: 'a'.repeat(64),
  queryFingerprint: 'b'.repeat(64),
  bindingReference: 'records_account',
  configurationReference: 'compiled-revision',
  scan: {
    connector: 'inventory',
    connectorVersion: '1',
    operation: 'scan',
    signatureDigest: 'c'.repeat(64),
  },
  retentionDays: 30,
  pollIntervalMs: 60000,
};
const target = {
  key: { ...sourceBinding.scope, connectionId: sourceBinding.bindingReference ?? '' },
  label: 'Records account',
  connectionConfigRevision: 'compiled-revision',
  requiredScopes: ['records.read'],
};
const sessionBinding = 's'.repeat(43);
const page = {
  records: [{ id: 'one', record: { name: 'old account' } }],
  deletedIds: [],
  complete: true,
};

export function sourceCredentialFenceSuite(
  make: () => Promise<{ raw: SourceIngestionStore; accounts: ConnectionStore }>,
) {
  it('serializes reads and commits with disconnect and preserves only same-account suppression', async () => {
    const { raw, accounts } = await make();
    const provider = await oauthFixture();
    const connections = new PortableConnections({
      store: accounts,
      credentialEpoch: 'source-fixture-epoch',
      providers: async () => provider.provider,
      resolveTarget: async () => target,
      portalOrigins: ['https://portal.example.test'],
      authorize: async () => true,
      guardedFetch: provider.fetch,
    });
    const authority = {
      withCurrent: <T>(
        _input: SourceBindingCreate,
        work: (identity: { generation: string; account: string }) => Promise<T>,
      ) => connections.withAccountIdentity(target, work),
    };
    const store = fenceSourceStore(raw, authority);
    expect(fenceSourceStore(store, authority)).toBe(store);
    async function connect(subject = 'account-one') {
      const prior = await connections.inspect(target);
      const started = await connections.connect(
        target,
        {
          expectedRevision: prior.revision,
          returnUrl: 'https://portal.example.test/o/one/workflow/integrations',
          sessionBinding,
        },
        'operator',
      );
      await connections.callback(
        { ...provider.authorize(started.authorizationUrl, subject), sessionBinding },
        'operator',
      );
    }
    await connect();
    let binding = await store.createBinding(sourceBinding);
    expect(binding.credentialIdentity?.generation).toBe(
      (await connections.readGeneration(target)).generation,
    );
    expect(JSON.stringify(binding)).not.toContain('account-one');
    const lease = await store.claimDue({ now: new Date(), workerId: 'worker', leaseMs: 60000 });
    if (!lease) throw new Error('No lease');
    expect(await store.commitPage({ lease, now: new Date(), page })).toMatchObject({ ok: true });
    const visible = await store.listExternalRecords({ ...binding, generation: 1 });
    expect(visible.records).toHaveLength(1);
    const record = visible.records[0];
    if (!record) throw new Error('No record');
    expect(await store.getExternalRecord({ ...binding, recordId: record.id })).toMatchObject({
      record: { name: 'old account' },
    });
    await store.suppressExternalRecord({
      ...binding,
      sourceId: 'one',
      reason: 'customer_request',
      now: new Date(),
    });
    const oldGeneration = binding.credentialIdentity?.generation;
    await connections.disconnect(target, (await connections.inspect(target)).revision, 'operator');
    await connect(); // Reconnection requires explicit replacement, even for the same subject.
    await expect(store.listExternalRecords(binding)).rejects.toThrow();
    let replacement = await store.replaceBinding({
      ...sourceBinding,
      generation: 2,
      expectedRevision: (await raw.getBinding(binding))?.revision ?? 0,
      now: new Date(),
    });
    if (!replacement.ok) throw new Error('Replacement failed');
    binding = replacement.binding;
    expect(binding.credentialIdentity?.generation).not.toBe(oldGeneration);
    expect(await store.listSuppressions(binding)).toHaveLength(1);
    const refreshed = await store.claimDue({ now: new Date(), workerId: 'worker', leaseMs: 60000 });
    if (!refreshed) throw new Error('No refreshed lease');

    // A read already holding the authority lock linearizes before disconnect; disconnect cannot
    // report success until that read finishes. Subsequent payload reads and commits are refused.
    let entered = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalRead = raw.listExternalRecords.bind(raw);
    const read = vi.spyOn(raw, 'listExternalRecords').mockImplementationOnce(async (input) => {
      entered();
      await blocked;
      return originalRead(input);
    });
    const pendingRead = store.listExternalRecords(binding);
    await started;
    release();
    await pendingRead;
    const before = await connections.inspect(target);
    let commitEntered = () => {};
    let commitRelease = () => {};
    const inCommit = new Promise<void>((resolve) => {
      commitEntered = resolve;
    });
    const commitBlock = new Promise<void>((resolve) => {
      commitRelease = resolve;
    });
    const originalCommit = raw.commitPage.bind(raw);
    const commit = vi.spyOn(raw, 'commitPage').mockImplementationOnce(async (input) => {
      commitEntered();
      await commitBlock;
      return originalCommit(input);
    });
    const committing = store.commitPage({ lease: refreshed, now: new Date(), page });
    await inCommit;
    let disconnected = false;
    const disconnect = connections.disconnect(target, before.revision, 'operator').then(() => {
      disconnected = true;
    });
    await Promise.resolve();
    expect(disconnected).toBe(false);
    commitRelease();
    expect(await committing).toMatchObject({ ok: true });
    await disconnect;
    read.mockClear();
    commit.mockClear();
    const providerBefore = provider.metrics();
    await expect(store.listExternalRecords(binding)).rejects.toThrow();
    await expect(store.getExternalRecord({ ...binding, recordId: record.id })).rejects.toThrow();
    await expect(store.commitPage({ lease: refreshed, now: new Date(), page })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(provider.metrics()).toEqual(providerBefore);
    await connect('account-two');
    await expect(store.listExternalRecords(binding)).rejects.toThrow();
    replacement = await store.replaceBinding({
      ...sourceBinding,
      generation: 3,
      expectedRevision: (await raw.getBinding(binding))?.revision ?? 0,
      now: new Date(),
    });
    if (!replacement.ok) throw new Error('Replacement failed');
    expect(await store.listSuppressions(replacement.binding)).toHaveLength(0);
    expect((await store.listExternalRecords(replacement.binding)).records).toEqual([]);
    const absent = fenceSourceStore(store);
    await expect(absent.listExternalRecords(replacement.binding)).rejects.toThrow(
      'source_authorization_lost',
    );
    await expect(
      absent.replaceBinding({
        ...sourceBinding,
        generation: 4,
        expectedRevision: replacement.binding.revision,
        now: new Date(),
      }),
    ).rejects.toThrow('source_authorization_lost');
    expect((await raw.getBinding(sourceBinding))?.generation).toBe(3);
  }, 15000);
}
