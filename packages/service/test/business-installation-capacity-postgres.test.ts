import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const input = (org: string, id: string) => ({
  scope: { org, app: `app-${id}`, env: 'prod', installationId: id },
  profileKey: 'travel' as const,
  managedCollections: ['travel_requests'],
  actorSubject: 'owner',
});
describe.skipIf(!databaseUrl)('retained installation PostgreSQL capacity', () => {
  const schema = `install_capacity_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    options: `-c search_path=${schema}`,
  });
  const store = new PostgresBusinessInformationStore(pool, new TestPayloadCipher());
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  async function copyRows(org: string, from: number, to: number) {
    return pool.query(
      `INSERT INTO business_solution_installations
      SELECT (jsonb_populate_record(NULL::business_solution_installations, to_jsonb(seed) ||
        jsonb_build_object('installation_id','seed-'||n,'public_id',$1||'-public-'||n,'app_slug','seed-'||n))).*
      FROM business_solution_installations seed CROSS JOIN generate_series($2::integer,$3::integer) n
      WHERE seed.org_slug=$1 AND seed.installation_id='original'`,
      [org, from, to],
    );
  }
  it('serializes racing creates, preserves unique-key replay/conflict, and guards older direct writers', async () => {
    const org = 'acme';
    const original = await store.createInstallation(input(org, 'original'));
    await copyRows(org, 1, 998);
    const attempts = await Promise.allSettled([
      store.createInstallation(input(org, 'last-a')),
      store.createInstallation(input(org, 'last-b')),
    ]);
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((entry) => entry.status === 'rejected')).toMatchObject({
      reason: { code: 'installation_capacity_exceeded' },
    });
    expect((await store.createInstallation(input(org, 'original'))).disposition).toBe('replayed');
    expect(
      (await store.createInstallation({ ...input(org, 'original'), retentionDays: 7 })).disposition,
    ).toBe('conflict');
    await expect(copyRows(org, 1001, 1001)).rejects.toMatchObject({
      constraint: 'business_installation_capacity',
    });
    await expect(
      pool.query(
        `INSERT INTO business_solution_installations
      SELECT (jsonb_populate_record(NULL::business_solution_installations, to_jsonb(seed) ||
        jsonb_build_object('installation_id','public-collision','app_slug','public-collision'))).*
      FROM business_solution_installations seed WHERE org_slug=$1 AND installation_id='original'`,
        [org],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await store.ensureSchema();
    expect(await store.getInstallation(input(org, 'original').scope)).toEqual(
      original.installation,
    );
    expect(await store.listInstallations(org)).toHaveLength(1000);
    expect((await store.createInstallation(input('other', 'original'))).disposition).toBe(
      'created',
    );
  });
  it('does not reinterpret or delete pre-existing over-cap rows during additive startup', async () => {
    const org = 'old-org';
    await store.createInstallation(input(org, 'original'));
    await pool.query(
      'ALTER TABLE business_solution_installations DISABLE TRIGGER business_installation_capacity_guard',
    );
    try {
      await copyRows(org, 1, 1001);
    } finally {
      await pool.query(
        'ALTER TABLE business_solution_installations ENABLE TRIGGER business_installation_capacity_guard',
      );
    }
    await store.ensureSchema();
    expect(await store.listInstallations(org)).toHaveLength(1002);
    expect((await store.createInstallation(input(org, 'original'))).disposition).toBe('replayed');
    await expect(store.createInstallation(input(org, 'extra'))).rejects.toMatchObject({
      code: 'installation_capacity_exceeded',
    });
  });
});
