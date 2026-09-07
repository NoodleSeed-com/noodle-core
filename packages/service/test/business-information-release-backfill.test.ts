import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  type InstallationRow,
  installationFromRow,
} from '../src/business-information/postgres-rows.js';
import { ensureBusinessInformationSchema } from '../src/business-information/postgres-schema.js';

function legacyRow(profileVersion: number): InstallationRow {
  const now = new Date('2030-01-01T00:00:00.000Z');
  return {
    org_slug: 'acme',
    app_slug: 'travel',
    environment: 'prod',
    installation_id: 'travel-prod',
    public_id: 'sol_travel',
    profile_key: 'travel',
    profile_version: profileVersion,
    managed_collections: ['travel_requests'],
    retention_days: 30,
    intake_active: true,
    revision: '1',
    create_fingerprint: 'fixture',
    created_at: now,
    created_by_subject: 'owner',
    updated_at: now,
    updated_by_subject: 'owner',
    definition_snapshot: null,
  };
}

describe('managed definition release backfill', () => {
  it('resolves a missing legacy snapshot by its stored release instead of the current release', () => {
    expect(installationFromRow(legacyRow(1)).definition.reference).toMatchObject({
      kind: 'managed',
      definitionId: 'travel',
      release: 1,
    });
    expect(() => installationFromRow(legacyRow(99))).toThrow(
      /unsupported built-in solution profile release/,
    );
  });

  it('backfills only known immutable managed profile releases', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    let connected = 0;
    let released = 0;
    const query = (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, ...(values === undefined ? {} : { values }) });
      return Promise.resolve({ rows: [] });
    };
    const pool = {
      query,
      connect: async () => {
        connected += 1;
        let active = false;
        return {
          query: (sql: string, values?: readonly unknown[]) => {
            if (sql === 'BEGIN') active = true;
            if (sql === 'COMMIT' || sql === 'ROLLBACK') active = false;
            return query(sql, values);
          },
          release: () => {
            expect(active).toBe(false);
            released += 1;
          },
        };
      },
    } as unknown as Pool;
    await ensureBusinessInformationSchema(pool);
    expect(connected).toBeGreaterThan(0);
    expect(released).toBe(connected);
    const backfills = calls.filter((call) =>
      call.sql.includes('WHERE definition_snapshot IS NULL AND profile_key=$2'),
    );
    expect(backfills.map((call) => call.values?.slice(1))).toEqual([
      ['travel', 1],
      ['travel', 2],
      ['travel', 3],
      ['ecommerce', 1],
      ['ecommerce', 2],
      ['restaurant', 1],
      ['restaurant', 2],
    ]);
    expect(backfills[0]?.values?.[0]).toContain('"release":1');
    expect(backfills[1]?.values?.[0]).toContain('"release":2');
  });
});
