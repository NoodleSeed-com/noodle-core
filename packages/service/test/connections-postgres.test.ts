import { randomBytes, randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionKey, PostgresConnectionStore } from '../src/connections/store.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { describeConnectionAuthority } from './connections-authority-suite.js';
import { describePortableConnections } from './connections-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL portable connections', () => {
  const schema = `connections_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  const cipher = new SecretBox(staticMasterKeyProvider(randomBytes(32).toString('base64')));
  const store = new PostgresConnectionStore(pool, cipher);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  describePortableConnections(async () => {
    await pool.query('TRUNCATE external_connections, external_connection_states');
    return { store, otherStore: new PostgresConnectionStore(pool, cipher) };
  });
  describeConnectionAuthority(async () => {
    await pool.query('TRUNCATE external_connections, external_connection_states');
    return store;
  });
  it('borrows one authority connection for consent indexes and rolls back all local writes', async () => {
    const one = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1000,
      options: `-c search_path=${schema}`,
    });
    const local = new PostgresConnectionStore(one, cipher);
    const key = {
      org: 'atomic',
      app: 'site',
      env: 'prod',
      installationId: 'site',
      connectionId: 'account',
    };
    const hash = 'e'.repeat(64),
      now = Date.now(),
      expiry = now + 60_000;
    try {
      await expect(
        withPostgresTransaction(one, async () => {
          await local.transact(key, (tx) =>
            tx.write({
              revision: 1,
              generation: 'generation',
              credentialEpoch: 'epoch',
              connectionConfigRevision: 'revision',
              providerDigest: 'f'.repeat(64),
              providerId: 'fixture',
              state: 'unconfigured',
              pending: [],
            }),
          );
          await local.putState(hash, key, expiry);
          expect(await local.getState(hash, now)).toEqual(key);
          expect((await local.transact(key, (tx) => tx.read()))?.revision).toBe(1);
          throw new Error('authority-rollback');
        }),
      ).rejects.toThrow('authority-rollback');
      expect(await local.getState(hash, now)).toBeUndefined();
      expect(await local.transact(key, (tx) => tx.read())).toBeUndefined();
      await local.putState(hash, key, expiry);
      await expect(
        withPostgresTransaction(one, async () => {
          await local.deleteState(hash);
          expect(await local.getState(hash, now)).toBeUndefined();
          throw new Error('authority-rollback');
        }),
      ).rejects.toThrow('authority-rollback');
      expect(await local.getState(hash, now)).toEqual(key);
    } finally {
      await one.end();
    }
  });
  it('rejects scope-transplanted ciphertext and key loss without exposing plaintext', async () => {
    const key = {
      org: 'tenant',
      app: 'app',
      env: 'prod',
      installationId: 'installation',
      connectionId: 'one',
    };
    const id = connectionKey(key);
    const envelope = await cipher.seal(
      JSON.stringify({ key: '0'.repeat(64), value: { accessToken: 'never-print-me' } }),
    );
    await pool.query(
      'INSERT INTO external_connections(connection_key,sealed_record) VALUES ($1,$2::jsonb)',
      [id, JSON.stringify(envelope)],
    );
    await expect(store.transact(key, (tx) => tx.read())).rejects.toThrow('connection_unavailable');
    const wrongCipher = new SecretBox(staticMasterKeyProvider(randomBytes(32).toString('base64')));
    await expect(
      new PostgresConnectionStore(pool, wrongCipher).transact(key, (tx) => tx.read()),
    ).rejects.toThrow(/decrypt/);
    expect(
      JSON.stringify((await pool.query('SELECT * FROM external_connections')).rows),
    ).not.toContain('never-print-me');
  });
});
