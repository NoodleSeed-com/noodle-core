import { expect, it, vi } from 'vitest';
import { fenceSourceStore } from '../src/business-information/source-credential-fence.js';
import type { SourceBindingCreate } from '../src/business-information/source-ingestion-contracts.js';
import { InMemorySourceIngestionStore } from '../src/business-information/source-ingestion-memory-store.js';

const input: SourceBindingCreate = {
  scope: { org: 'one', app: 'app', env: 'prod', installationId: 'install' },
  collectionKey: 'stock',
  id: 'stock',
  generation: 1,
  schemaVersion: 1,
  schemaDigest: 'a'.repeat(64),
  queryFingerprint: 'b'.repeat(64),
  bindingReference: 'account',
  configurationReference: 'revision',
  scan: {
    connector: 'inventory',
    connectorVersion: '1',
    operation: 'scan',
    signatureDigest: 'c'.repeat(64),
  },
  retentionDays: 30,
  pollIntervalMs: 60000,
};
it('blocks retained data, claims and old commits immediately when credential authority changes', async () => {
  const raw = new InMemorySourceIngestionStore({ identityKey: 'x'.repeat(32) });
  let generation = 'a'.repeat(64);
  const authority = {
    withCurrent: async <T>(
      _binding: SourceBindingCreate,
      work: (value: { generation: string; account: string }) => Promise<T>,
    ) => work({ generation, account: 'b'.repeat(64) }),
  };
  const store = fenceSourceStore(raw, authority);
  const bound = await store.createBinding(input);
  const lease = await store.claimDue({ now: new Date(), workerId: 'worker', leaseMs: 60000 });
  if (!lease) throw new Error('No lease');
  const page = {
    records: [{ id: 'one', record: { name: 'old-account' } }],
    deletedIds: [],
    complete: true,
  };
  expect(await store.commitPage({ lease, now: new Date(), page })).toMatchObject({ ok: true });
  expect((await store.listExternalRecords({ ...bound, generation: 1 })).records).toHaveLength(1);
  const read = vi.spyOn(raw, 'listExternalRecords');
  const commit = vi.spyOn(raw, 'commitPage');
  generation = 'c'.repeat(64);
  await expect(store.listExternalRecords({ ...bound, generation: 1 })).rejects.toThrow(
    'source_authorization_lost',
  );
  await expect(store.commitPage({ lease, now: new Date(), page })).rejects.toThrow(
    'source_authorization_lost',
  );
  expect(read).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});

import { InMemoryConnectionStore } from '../src/connections/store.js';
import { sourceCredentialFenceSuite } from './source-credential-fence-suite.js';

sourceCredentialFenceSuite(async () => ({
  raw: new InMemorySourceIngestionStore({ identityKey: 'x'.repeat(32) }),
  accounts: new InMemoryConnectionStore(),
}));
