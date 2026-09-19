import { randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { SecretBoxPayloadCipher } from '../src/business-information-cipher.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { businessPageConformance, pageContent } from './business-page-conformance.js';

const connectionString = process.env.DATABASE_URL_TEST;
describe.skipIf(!connectionString)('PostgreSQL hosted business pages', () => {
  const schema = `business_pages_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  const cipher = new SecretBoxPayloadCipher(
    new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 11).toString('base64'))),
  );
  const store = new PostgresBusinessInformationStore(pool, cipher);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  businessPageConformance(async () => store);
  const scope = { org: 'durable-page', app: 'travel', env: 'prod', installationId: 'private-page' };
  async function seed() {
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    return store.pages.update({
      scope,
      actorSubject: 'owner',
      change: { operation: 'save', expectedRevision: 0, content: pageContent },
    });
  }
  it('retains encrypted drafts across restart and joins transactions on one connection', async () => {
    const original = await seed();
    const restarted = new PostgresBusinessInformationStore(pool, cipher);
    expect(await restarted.pages.get(scope)).toEqual(original);
    const rows = await pool.query('SELECT * FROM business_installation_pages');
    expect(JSON.stringify(rows.rows)).not.toContain(pageContent.introduction);
    await expect(
      withPostgresTransaction(pool, async () => {
        await restarted.pages.update({
          scope,
          actorSubject: 'owner',
          change: {
            operation: 'save',
            expectedRevision: 1,
            content: { ...pageContent, introduction: 'never committed' },
          },
        });
        expect((await restarted.pages.get(scope))?.revision).toBe(2);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await restarted.pages.get(scope)).toEqual(original);
  });
  it('rejects ciphertext moved across installations without leaking data in errors', async () => {
    const other = { ...scope, installationId: 'other-private-page' };
    await store.createInstallation({
      scope: other,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    await store.pages.update({
      scope: other,
      actorSubject: 'owner',
      change: { operation: 'save', expectedRevision: 0, content: pageContent },
    });
    await pool.query(
      `UPDATE business_installation_pages target SET sealed_page=source.sealed_page
      FROM business_installation_pages source WHERE source.installation_id=$1 AND target.installation_id=$2`,
      [scope.installationId, other.installationId],
    );
    await expect(store.pages.get(other)).rejects.toThrow('Business page storage is unavailable.');
  });
  it('round-trips maximum Unicode draft and publication without exceeding the existing cipher envelope', async () => {
    const largeScope = { ...scope, installationId: 'unicode' };
    await store.createInstallation({
      scope: largeScope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    const content = {
      introduction: '旅'.repeat(1200),
      sections: Array.from({ length: 8 }, () => ({
        title: '旅'.repeat(120),
        text: '旅'.repeat(4000),
      })),
    };
    await store.setBusinessNotice({
      scope: largeScope,
      actorSubject: 'owner',
      expectedRevision: 0,
      notice: {
        displayName: 'Travel',
        privacyUrl: 'https://example.com/privacy',
        supportUrl: 'mailto:help@example.com',
      },
    });
    await store.pages.update({
      scope: largeScope,
      actorSubject: 'owner',
      change: { operation: 'save', expectedRevision: 0, content },
    });
    await store.pages.update(
      {
        scope: largeScope,
        actorSubject: 'owner',
        change: { operation: 'publish', expectedRevision: 1 },
      },
      async () => ({ deploymentId: 'unicode-deployment' }),
    );
    const opened = await new PostgresBusinessInformationStore(pool, cipher).pages.get(largeScope);
    expect(opened?.draft).toEqual(content);
    expect(opened?.published?.content).toEqual(content);
  });
});
