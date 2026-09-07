import { randomUUID } from 'node:crypto';
import { DEPLOYMENT_ACTIVATION_PHASE } from '@noodle-borg/module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerRegistry } from '../src/registry.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { settingsDeploymentRaceSuite } from './application-settings-race-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)(
  'PostgreSQL deployment/configuration shared authority',
  () => {
    const schema = `settings_race_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      options: `-c search_path=${schema}`,
    });
    const store = new PostgresArtifactStore(pool);
    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await store.ensureSchema();
      await store.createOrg({ slug: 'acme' });
    });
    afterAll(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    settingsDeploymentRaceSuite('single-connection transaction conformance', async () => {
      await pool.query('TRUNCATE deploy_records, config_values');
      return {
        config: store,
        artifacts: store,
        registry: new ServerRegistry(store, undefined, store),
      };
    });
    it('rolls back prepared module writes when activation returns no target inside a config transaction', async () => {
      await pool.query('CREATE TEMP TABLE activation_marker (value text)');
      const hooked = new PostgresArtifactStore(pool, {
        deploymentActivation: [
          {
            id: 'test-preparation',
            phase: DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS,
            prepare: async (transaction) => {
              await transaction.query("INSERT INTO activation_marker VALUES ('prepared')");
            },
            assert: async () => {},
          },
        ],
      });
      await hooked.transactConfig('acme', async () => {
        expect(
          await hooked.activateDeployment(
            { org: 'acme', app: 'desk', env: 'prod' },
            'missing-12345678',
          ),
        ).toBeUndefined();
      });
      expect((await pool.query('SELECT * FROM activation_marker')).rows).toEqual([]);
    });
  },
);
