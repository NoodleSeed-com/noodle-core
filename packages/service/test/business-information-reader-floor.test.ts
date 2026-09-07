import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { BusinessInformationStore } from '../src/business-information/contracts.js';
import { PostgresManagedRequestStore } from '../src/business-information/postgres-requests.js';
import { proveManagedReaderFloor } from '../src/business-information/reader-floor.js';

describe('managed business-information reader floor', () => {
  it('queries only the distinct payload-free schema identity columns', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          profile_key: 'travel',
          profile_version: 2,
          collection_key: 'travel_requests',
          schema_version: 2,
          schema_digest: 'a'.repeat(64),
        },
      ],
    });
    const store = new PostgresManagedRequestStore(
      { query } as unknown as Pool,
      {} as never,
      {} as never,
    );
    await expect(store.listAcceptedSchemaInventory()).resolves.toEqual([
      {
        profileKey: 'travel',
        profileVersion: 2,
        collectionKey: 'travel_requests',
        schemaVersion: 2,
        schemaDigest: 'a'.repeat(64),
      },
    ]);
    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('SELECT DISTINCT profile_key, profile_version, collection_key');
    expect(sql).not.toMatch(/content|org_slug|record_id/);
  });

  it('rejects a target that lacks a reader for an accepted managed profile release', async () => {
    const store = {
      listAcceptedSchemaInventory: () =>
        Promise.resolve([
          {
            profileKey: 'travel',
            profileVersion: 99,
            collectionKey: 'travel_requests',
            schemaVersion: 99,
            schemaDigest: 'f'.repeat(64),
          },
        ]),
    } as unknown as BusinessInformationStore;
    await expect(proveManagedReaderFloor(store)).rejects.toThrow(
      /cannot read accepted profile release 99/,
    );
  });
});
