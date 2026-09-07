import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const connectionString = process.env.DATABASE_URL_TEST;
describe.skipIf(!connectionString)('Postgres business notice authority', () => {
  const schema = `business_notice_${process.pid}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
  const store = new PostgresBusinessInformationStore(pool, new TestPayloadCipher());
  const scope = { org: 'notice-org', app: 'travel', env: 'prod', installationId: 'travel-prod' };
  const notice = {
    displayName: 'Notice Travel',
    privacyUrl: 'https://example.com/privacy',
    supportUrl: 'mailto:support@example.com',
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it('isolates tenants and serializes first-create plus competing updates across administrators', async () => {
    await expect(
      store.setBusinessNotice({ scope, notice, expectedRevision: 0, actorSubject: 'outsider' }),
    ).rejects.toMatchObject({ code: 'business_notice_forbidden' });
    await store.setGrant({
      scope,
      subject: 'other-admin',
      email: 'admin@example.com',
      role: 'administrator',
      expectedRevision: 0,
      actorSubject: 'owner',
    });
    const results = await Promise.allSettled(
      ['owner', 'other-admin'].map((actorSubject) =>
        store.setBusinessNotice({ scope, notice, expectedRevision: 0, actorSubject }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' ? failed.reason : undefined).toMatchObject({
      code: 'business_notice_conflict',
    });
    expect(await store.getBusinessNotice({ ...scope, org: 'other-org' })).toBeUndefined();
  });

  it('survives restart and denies a revoked administrator without discarding the notice', async () => {
    const first = await store.getBusinessNotice(scope);
    const restartedPool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      const restarted = new PostgresBusinessInformationStore(
        restartedPool,
        new TestPayloadCipher(),
      );
      await restarted.ensureSchema();
      expect(await restarted.getBusinessNotice(scope)).toEqual(first);
      await pool.query(
        "UPDATE business_installation_grants SET revoked_at=now() WHERE subject='other-admin'",
      );
      await expect(
        restarted.setBusinessNotice({
          scope,
          notice,
          expectedRevision: 1,
          actorSubject: 'other-admin',
        }),
      ).rejects.toMatchObject({ code: 'business_notice_forbidden' });
      expect(await restarted.getBusinessNotice(scope)).toEqual(first);
    } finally {
      await restartedPool.end();
    }
  });

  it('joins activation transactions with one connection and rolls back notice updates', async () => {
    const single = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    try {
      const business = new PostgresBusinessInformationStore(single, new TestPayloadCipher());
      const controlPlane = new PostgresArtifactStore(single);
      await controlPlane.ensureSchema();
      const documents = {
        version: 'single-connection',
        terms: { url: 'https://example.com/terms', sha256: 'a'.repeat(64) },
        privacy: { url: 'https://example.com/privacy', sha256: 'b'.repeat(64) },
        processing: { url: 'https://example.com/processing', sha256: 'c'.repeat(64) },
      };
      await single.query("INSERT INTO orgs (slug) VALUES ('notice-org') ON CONFLICT DO NOTHING");
      await single.query(
        "INSERT INTO org_members (org_slug,subject,email,role) VALUES ('notice-org','owner','owner@example.com','owner')",
      );
      const receipt = await controlPlane.acceptOrganizationAgreement({
        org: scope.org,
        actorSubject: 'owner',
        documents,
      });
      const before = await business.getBusinessNotice(scope);
      expect(before).toBeDefined();
      if (!before) throw new Error('Expected the previously saved business notice');
      await expect(
        withPostgresTransaction(single, async () => {
          expect(await controlPlane.getOrganizationAgreement(scope.org, documents.version)).toEqual(
            receipt,
          );
          expect(await business.getBusinessNotice(scope)).toEqual(before);
          await business.setBusinessNotice({
            scope,
            notice: { ...notice, displayName: 'Rolled back' },
            expectedRevision: before.revision,
            actorSubject: 'owner',
          });
          expect(await business.getBusinessNotice(scope)).toMatchObject({
            notice: { displayName: 'Rolled back' },
          });
          throw new Error('activation interrupted');
        }),
      ).rejects.toThrow('activation interrupted');
      expect(await business.getBusinessNotice(scope)).toEqual(before);
    } finally {
      await single.end();
    }
  });
});
