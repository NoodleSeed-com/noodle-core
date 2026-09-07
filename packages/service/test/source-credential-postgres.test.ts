import { randomBytes, randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fenceSourceStore } from '../src/business-information/source-credential-fence.js';
import { PostgresSourceIngestionStore } from '../src/business-information/source-ingestion-postgres-store.js';
import { PostgresConnectionStore } from '../src/connections/store.js';
import { sourceConfigurationAuthority } from '../src/source-configuration-authority.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import {
  postgresQueryExecutor,
  withPostgresTransaction,
} from '../src/store/postgres-transaction.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';
import { sourceConfigurationFixture } from './source-configuration-fixture.js';
import { sourceCredentialFenceSuite } from './source-credential-fence-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
for (const maximum of [1, 2])
  describe.skipIf(!databaseUrl)(
    `source account fence with PostgreSQL pool maximum ${maximum}`,
    () => {
      const schema = `source_account_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      const pool = new pg.Pool({
        connectionString: databaseUrl,
        max: maximum,
        options: `-c search_path=${schema}`,
      });
      const raw = new PostgresSourceIngestionStore(pool, new TestPayloadCipher(), {
        identityKey: 'x'.repeat(32),
      });
      const accounts = new PostgresConnectionStore(
        pool,
        new SecretBox(staticMasterKeyProvider(randomBytes(32).toString('base64'))),
      );
      beforeAll(async () => {
        await admin.query(`CREATE SCHEMA ${schema}`);
        await new PostgresArtifactStore(pool).ensureSchema();
        await raw.ensureSchema();
        await accounts.ensureSchema();
        await pool.query(`INSERT INTO business_solution_installations (
      org_slug,app_slug,environment,installation_id,public_id,profile_key,profile_version,
      managed_collections,retention_days,revision,create_fingerprint,created_at,created_by_subject,
      updated_at,updated_by_subject) VALUES ('one','workflow','prod','installation-one','public-one',
      'travel',1,ARRAY['stock'],30,1,'fixture',clock_timestamp(),'test',clock_timestamp(),'test')`);
        await pool.query('CREATE TABLE transaction_probe (id integer PRIMARY KEY)');
      });
      afterAll(async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      });
      sourceCredentialFenceSuite(async () => ({ raw, accounts }));
      it('fences actual config mutations and old SQL writers without a second connection or secret decryption', async () => {
        await pool.query("UPDATE business_source_bindings SET state='paused'");
        const config = new PostgresArtifactStore(
          pool,
          new SecretBox(staticMasterKeyProvider(randomBytes(32).toString('base64'))),
        );
        const fixture = sourceConfigurationFixture(config);
        const declaration = { ...fixture.declaration, id: 'config-source' };
        const scope = { level: 'env' as const, ...declaration.scope };
        await config.setConfigValue({
          kind: 'variable',
          scope,
          name: 'SOURCE_ORIGIN',
          value: 'https://source.example',
        });
        await config.setConfigValue({
          kind: 'secret',
          scope,
          name: 'SOURCE_TOKEN',
          value: 'private-token-before',
        });
        const first = await config.setConfigValue({
          kind: 'variable',
          scope,
          name: 'SOURCE_RESOURCE',
          value: 'store-one',
        });
        const source = fenceSourceStore(
          raw,
          sourceConfigurationAuthority(() => fixture.registry),
        );
        let bound = await source.createBinding(declaration);
        expect((await source.listExternalRecords(bound)).records).toEqual([]);
        await pool.query(
          "UPDATE config_values SET variable_value='store-two',updated_at=updated_at WHERE name='SOURCE_RESOURCE'",
        );
        const second = (await config.listConfigValues('variable', scope)).find(
          (row) => row.name === 'SOURCE_RESOURCE',
        );
        expect(second?.generation).not.toBe(first.generation);
        expect(second?.updatedAt).toBe(first.updatedAt);
        await expect(source.listExternalRecords(bound)).rejects.toThrow(
          'source_authorization_lost',
        );
        const replaced = await source.replaceBinding({
          ...declaration,
          generation: 2,
          expectedRevision: bound.revision,
          now: new Date(),
        });
        if (!replaced.ok) throw new Error('Replacement failed');
        bound = replaced.binding;
        const lease = await source.claimDue({
          now: new Date(),
          workerId: 'config-worker',
          leaseMs: 60000,
        });
        if (!lease) throw new Error('No lease');
        let enter = () => {};
        let release = () => {};
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const commit = raw.commitPage.bind(raw);
        const spy = vi.spyOn(raw, 'commitPage').mockImplementationOnce(async (input) => {
          enter();
          await wait;
          return commit(input);
        });
        const committing = source.commitPage({
          lease,
          now: new Date(),
          page: { records: [], deletedIds: [], complete: true },
        });
        await entered;
        let mutated = false;
        const mutation = config
          .setConfigValue({
            kind: 'secret',
            scope,
            name: 'SOURCE_TOKEN',
            value: 'private-token-after',
          })
          .then(() => {
            mutated = true;
          });
        await Promise.resolve();
        expect(mutated).toBe(false);
        release();
        expect(await committing).toMatchObject({ ok: true });
        await mutation;
        spy.mockClear();
        await expect(
          source.commitPage({
            lease,
            now: new Date(),
            page: { records: [], deletedIds: [], complete: true },
          }),
        ).rejects.toThrow('source_authorization_lost');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        const metadata = await config.listConfigValues('secret', scope);
        expect(metadata[0]?.generation).toBeTypeOf('string');
        expect(JSON.stringify(metadata)).not.toContain('private-token');
        expect(JSON.stringify(metadata)).not.toContain('generation');
      });
      it('joins reads and writes on one client and rolls back a failed nested operation even if caught', async () => {
        await expect(
          withPostgresTransaction(pool, async (outer) => {
            expect(postgresQueryExecutor(pool)).toBe(outer);
            expect(postgresQueryExecutor(admin)).toBe(admin);
            await outer.query('INSERT INTO transaction_probe VALUES (1)');
            try {
              await withPostgresTransaction(pool, async (nested) => {
                expect(nested).toBe(outer);
                await postgresQueryExecutor(pool).query('INSERT INTO transaction_probe VALUES (2)');
                throw new Error('nested failure');
              });
            } catch {}
          }),
        ).rejects.toThrow('nested failure');
        expect((await pool.query('SELECT * FROM transaction_probe')).rows).toEqual([]);
      });
      it('does not reuse a released client through an escaped async context', async () => {
        let release = () => {};
        const afterRelease = new Promise<void>((resolve) => {
          release = resolve;
        });
        let detached: Promise<unknown> | undefined;
        await withPostgresTransaction(pool, async (client) => {
          detached = afterRelease.then(() => {
            expect(postgresQueryExecutor(pool)).toBe(pool);
            expect(postgresQueryExecutor(pool)).not.toBe(client);
          });
        });
        release();
        await detached;
      });
    },
  );
