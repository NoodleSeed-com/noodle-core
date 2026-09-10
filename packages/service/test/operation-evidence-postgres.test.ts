import { randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperationEvidencePort, operationEvidenceKey } from '../src/operation-evidence.js';
import { PostgresOperationEvidenceStore } from '../src/operation-evidence-postgres.js';
import { describeOperationEvidence } from './operation-evidence-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL operation evidence', () => {
  const schema = `operation_evidence_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  const store = new PostgresOperationEvidenceStore(
    pool,
    new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 11).toString('base64'))),
  );
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    // Rehearse an in-place upgrade from the existing table: historical root rows remain readable.
    await pool.query(`CREATE TABLE operation_evidence (
      scope_key text NOT NULL, id text NOT NULL, protected jsonb NOT NULL,
      started_at bigint NOT NULL, execution_deadline bigint NOT NULL, history_expires_at bigint NOT NULL,
      outcome text NOT NULL, completed_at bigint, PRIMARY KEY(scope_key,id)
    )`);
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  describeOperationEvidence(async () => {
    await pool.query('TRUNCATE operation_evidence, operation_history_settings');
    return store;
  });
  it('binds the parent projection index to protected evidence and retains the child row', async () => {
    await pool.query('TRUNCATE operation_evidence, operation_history_settings');
    const scope = { org: 'a', app: 'site', env: 'production', installationId: 'site' };
    const start = 1_800_000_000_000;
    const port = createOperationEvidencePort({
      store,
      scope,
      deploymentId: 'release',
      epoch: 'test-restore-epoch-0001',
      identityKey: 'test-key-which-is-at-least-thirty-two-characters',
      now: () => start,
      authorize: async () => true,
      executionBoundMs: () => 10_000,
      historyDays: async () => 7,
      connectionGeneration: () => undefined,
    });
    const child = await port.begin({
      id: 'child',
      parentId: 'parent',
      tool: 'submit',
      arguments: {},
      operation: {
        resolved: true,
        connectorId: 'external',
        connectorVersion: '1',
        operation: 'submit',
        signatureHash: 'signature',
      },
    });
    expect(await store.list(scope, start + 1, 7, 100)).toEqual([]);
    expect((await pool.query('SELECT id,parent_id,outcome FROM operation_evidence')).rows).toEqual([
      { id: 'child', parent_id: 'parent', outcome: 'dispatching' },
    ]);
    await pool.query('UPDATE operation_evidence SET parent_id=NULL WHERE scope_key=$1 AND id=$2', [
      operationEvidenceKey(scope, ''),
      'child',
    ]);
    await expect(store.list(scope, start + 1, 7, 100)).rejects.toThrow('parent mismatch');
    await expect(child?.finish({ outcome: 'completed' })).rejects.toThrow('parent mismatch');
    await pool.query('UPDATE operation_evidence SET parent_id=$3 WHERE scope_key=$1 AND id=$2', [
      operationEvidenceKey(scope, ''),
      'child',
      'parent',
    ]);
    await child?.finish({ outcome: 'completed' });
    expect((await pool.query('SELECT id,parent_id,outcome FROM operation_evidence')).rows).toEqual([
      { id: 'child', parent_id: 'parent', outcome: 'completed' },
    ]);
  });
});
