import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptOrganizationAgreementRow,
  getOrganizationAgreementRow,
} from '../src/postgres-organization-agreements.js';
import { ensureOrganizationSchema } from '../src/postgres-schema.js';

const connectionString = process.env.DATABASE_URL_TEST;
const schema = `organization_agreements_${process.pid}`;
const documents = {
  version: 'beta-2026-09',
  terms: { url: 'https://example.com/terms/beta-2026-09', sha256: 'a'.repeat(64) },
  privacy: { url: 'https://example.com/privacy/beta-2026-09', sha256: 'b'.repeat(64) },
  processing: { url: 'https://example.com/processing/beta-2026-09', sha256: 'c'.repeat(64) },
};

describe.skipIf(!connectionString)('durable organization agreement acceptance', () => {
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
    await ensureOrganizationSchema(pool);
    await pool.query("INSERT INTO orgs (slug) VALUES ('first'), ('second'), ('interrupted')");
    await pool.query(
      "INSERT INTO org_members (org_slug,subject,email,role) SELECT slug, slug || '-owner', slug || '@example.com', 'owner' FROM orgs",
    );
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('commits one receipt across concurrent requests and a new pool; schema replay preserves it', async () => {
    const input = { org: 'first', actorSubject: 'first-owner', documents };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acceptOrganizationAgreementRow(pool, input)),
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    const restarted = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      await ensureOrganizationSchema(restarted);
      expect(await getOrganizationAgreementRow(restarted, 'first', documents.version)).toEqual(
        results[0],
      );
      expect(
        await getOrganizationAgreementRow(restarted, 'second', documents.version),
      ).toBeUndefined();
    } finally {
      await restarted.end();
    }
    expect(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM organization_agreement_acceptances',
        )
      ).rows[0]?.count,
    ).toBe('1');
  });

  it('rejects another org owner, revoked owners and replacement document identities', async () => {
    await expect(
      acceptOrganizationAgreementRow(pool, {
        org: 'second',
        actorSubject: 'first-owner',
        documents,
      }),
    ).rejects.toMatchObject({ code: 'agreement_owner_required' });
    await expect(
      acceptOrganizationAgreementRow(pool, {
        org: 'second',
        actorSubject: 'second-owner',
        documents: { ...documents, privacy: { ...documents.privacy, sha256: 'e'.repeat(64) } },
      }),
    ).rejects.toMatchObject({ code: 'agreement_version_conflict' });
    await pool.query("UPDATE org_members SET role='developer' WHERE org_slug='first'");
    await expect(
      acceptOrganizationAgreementRow(pool, {
        org: 'first',
        actorSubject: 'first-owner',
        documents,
      }),
    ).rejects.toMatchObject({ code: 'agreement_owner_required' });
    expect(await getOrganizationAgreementRow(pool, 'first', documents.version)).toMatchObject({
      actorSubject: 'first-owner',
    });
  });

  it('rolls back document registration with an interrupted receipt and can resume', async () => {
    await pool.query(
      `CREATE FUNCTION reject_agreement_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_slug='interrupted' THEN RAISE EXCEPTION 'synthetic interruption'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER agreement_probe BEFORE INSERT ON organization_agreement_acceptances FOR EACH ROW EXECUTE FUNCTION reject_agreement_probe()',
    );
    const input = {
      org: 'interrupted',
      actorSubject: 'interrupted-owner',
      documents: { ...documents, version: 'next-version' },
    };
    await expect(acceptOrganizationAgreementRow(pool, input)).rejects.toThrow(
      'synthetic interruption',
    );
    expect(
      await getOrganizationAgreementRow(pool, input.org, input.documents.version),
    ).toBeUndefined();
    expect(
      (
        await pool.query(
          "SELECT version FROM organization_agreement_documents WHERE version='next-version'",
        )
      ).rowCount,
    ).toBe(0);
    await pool.query('DROP TRIGGER agreement_probe ON organization_agreement_acceptances');
    expect(await acceptOrganizationAgreementRow(pool, input)).toMatchObject({
      org: input.org,
      documents: input.documents,
    });
  });

  it('locks live membership before accepting while concurrent revocation is pending', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE org_members SET role='developer' WHERE org_slug='second'");
      const acceptance = acceptOrganizationAgreementRow(pool, {
        org: 'second',
        actorSubject: 'second-owner',
        documents,
      });
      const rejection = expect(acceptance).rejects.toMatchObject({
        code: 'agreement_owner_required',
      });
      await client.query('COMMIT');
      await rejection;
      expect(await getOrganizationAgreementRow(pool, 'second', documents.version)).toBeUndefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
