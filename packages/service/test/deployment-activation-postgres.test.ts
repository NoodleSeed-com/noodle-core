import {
  DEPLOYMENT_ACTIVATION_PHASE,
  type NamedDeploymentActivationHook,
} from '@noodle-borg/module';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DeployRecord, PostgresArtifactStore } from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `deployment_activation_test_${process.pid}`;

const RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'guarded-12345678',
  orgSlug: 'acme',
  appSlug: 'guarded',
  environment: 'prod',
  deploymentVersion: 1,
  active: true,
  serverName: 'guarded',
  createdAt: '2026-08-22T00:00:00.000Z',
  accessMode: 'owner-only',
  manifest: 'manifestVersion: "1"\n',
  secrets: { enc: 'none', values: {} },
};

describe.skipIf(!URL)('module deployment activation (Postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 2, options: `-c search_path=${SCHEMA}` });
    const store = new PostgresArtifactStore(pool);
    await store.ensureSchema();
    await pool.query(`INSERT INTO orgs (slug) VALUES ('acme')`);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('uses the core transaction and rolls back its activation write after a hook denial', async () => {
    let preparedTransactionId: string | undefined;
    const hook: NamedDeploymentActivationHook = {
      id: 'test.capacity',
      phase: DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY,
      prepare: async (transaction) => {
        const result = await transaction.query<{ id: string }>('SELECT txid_current()::text AS id');
        preparedTransactionId = result.rows[0]?.id;
        return preparedTransactionId;
      },
      assert: async (transaction, _target, prepared) => {
        const result = await transaction.query<{ id: string }>('SELECT txid_current()::text AS id');
        expect(result.rows[0]?.id).toBe(prepared);
        throw new Error('module activation denied');
      },
    };
    const guarded = new PostgresArtifactStore(pool, { deploymentActivation: [hook] });

    await expect(guarded.append(RECORD)).rejects.toThrow('module activation denied');
    expect(preparedTransactionId).toBeDefined();
    await expect(guarded.get(RECORD.deploymentId)).resolves.toBeUndefined();
  });

  it('passes automation freshness through the same transaction as the core activation write', async () => {
    const candidate = {
      ...RECORD,
      deploymentId: 'automated-12345678',
      active: false,
    };
    const plain = new PostgresArtifactStore(pool);
    await plain.append(candidate);
    let preparedTransactionId: string | undefined;
    const hook: NamedDeploymentActivationHook = {
      id: 'test.automation-freshness',
      phase: DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS,
      prepare: async (transaction, target) => {
        expect(target.automationId).toBe('run-1');
        const result = await transaction.query<{ id: string }>('SELECT txid_current()::text AS id');
        preparedTransactionId = result.rows[0]?.id;
        return preparedTransactionId;
      },
      assert: async (transaction, target, prepared) => {
        expect(target.automationId).toBe('run-1');
        const result = await transaction.query<{ id: string }>('SELECT txid_current()::text AS id');
        expect(result.rows[0]?.id).toBe(prepared);
      },
    };
    const guarded = new PostgresArtifactStore(pool, { deploymentActivation: [hook] });

    await expect(
      guarded.activateDeployment(
        { org: 'acme', app: 'guarded', env: 'prod' },
        candidate.deploymentId,
        undefined,
        { automationId: 'run-1' },
      ),
    ).resolves.toMatchObject({ active: { deploymentId: candidate.deploymentId } });
    expect(preparedTransactionId).toBeDefined();
  });
});
