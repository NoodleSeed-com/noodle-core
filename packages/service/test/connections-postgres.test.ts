import { randomBytes, randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionKey, PostgresConnectionStore } from '../src/connections/store.js';
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
