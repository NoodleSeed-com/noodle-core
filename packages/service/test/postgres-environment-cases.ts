import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import type { DeployRecord, PostgresArtifactStore } from '../src/index.js';

export function registerPostgresProductionEnvironmentTests(
  store: () => PostgresArtifactStore,
  pool: () => Pool,
  baseRecord: DeployRecord,
): void {
  it('backfills production metadata only when the column is first introduced', async () => {
    await pool().query('DROP INDEX IF EXISTS environments_one_production_per_app');
    await pool().query('ALTER TABLE environments DROP COLUMN is_production');
    await pool().query(
      `INSERT INTO apps (org_slug, slug) VALUES
       ('acme', 'ambiguous'), ('acme', 'conventional'), ('acme', 'single')`,
    );
    await pool().query(
      `INSERT INTO environments (org_slug, app_slug, name) VALUES
       ('acme', 'ambiguous', 'happy-hour'),
       ('acme', 'ambiguous', 'preview'),
       ('acme', 'conventional', 'prod'),
       ('acme', 'conventional', 'staging'),
       ('acme', 'single', 'main')`,
    );

    await store().ensureSchema();
    const migrated = await pool().query<{
      app_slug: string;
      name: string;
      is_production: boolean;
    }>(
      `SELECT app_slug, name, is_production
       FROM environments
       ORDER BY app_slug, name`,
    );
    expect(migrated.rows).toEqual([
      { app_slug: 'ambiguous', name: 'happy-hour', is_production: false },
      { app_slug: 'ambiguous', name: 'preview', is_production: false },
      { app_slug: 'conventional', name: 'prod', is_production: true },
      { app_slug: 'conventional', name: 'staging', is_production: false },
      { app_slug: 'single', name: 'main', is_production: true },
    ]);

    await pool().query(
      `INSERT INTO environments (org_slug, app_slug, name) VALUES ('acme', 'ambiguous', 'prod')`,
    );
    await store().ensureSchema();
    const repeated = await pool().query<{ name: string; is_production: boolean }>(
      `SELECT name, is_production
       FROM environments
       WHERE app_slug = 'ambiguous'
       ORDER BY name`,
    );
    expect(repeated.rows).toEqual([
      { name: 'happy-hour', is_production: false },
      { name: 'preview', is_production: false },
      { name: 'prod', is_production: false },
    ]);
    expect(
      (await store().listEnvironments('acme', 'ambiguous')).every((env) => !env.isProduction),
    ).toBe(true);
    expect(await store().setProductionEnvironment('acme', 'ambiguous', 'prod')).toMatchObject({
      previousProductionEnvironment: null,
      productionEnvironment: 'prod',
      changed: true,
    });
  });

  it('atomically reassigns the one production environment and keeps repeats idempotent', async () => {
    const custom: DeployRecord = {
      ...baseRecord,
      deploymentId: 'hello-happy123',
      environment: 'happy-hour',
      deploymentVersion: 2,
    };
    await store().append(baseRecord);
    await store().append(custom);

    expect(await store().setProductionEnvironment('acme', 'hello', 'happy-hour')).toEqual({
      orgSlug: 'acme',
      appSlug: 'hello',
      productionEnvironment: 'happy-hour',
      previousProductionEnvironment: 'prod',
      changed: true,
    });
    expect(await store().setProductionEnvironment('acme', 'hello', 'happy-hour')).toMatchObject({
      previousProductionEnvironment: 'happy-hour',
      changed: false,
    });
    expect(await store().setProductionEnvironment('acme', 'hello', 'ghost')).toBeUndefined();
    await expect(
      Promise.all([
        store().setProductionEnvironment('acme', 'hello', 'prod'),
        store().setProductionEnvironment('acme', 'hello', 'happy-hour'),
      ]),
    ).resolves.toHaveLength(2);
    expect(
      (await store().listEnvironments('acme', 'hello')).filter((env) => env.isProduction),
    ).toHaveLength(1);
    await store().setProductionEnvironment('acme', 'hello', 'happy-hour');
    expect(
      (await store().listEnvironments('acme', 'hello')).map((env) => [
        env.envName,
        env.isProduction,
      ]),
    ).toEqual([
      ['happy-hour', true],
      ['prod', false],
    ]);
  });
}
