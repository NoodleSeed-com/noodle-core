import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ArtifactStore,
  type DeployRecord,
  InMemoryArtifactStore,
  JsonFileArtifactStore,
  PostgresArtifactStore,
  ServerRegistry,
} from '../src/index.js';
import { deploymentWriteVersionError } from '../src/registry-deploy-transaction.js';

const tenant = { org: 'scope-test', app: 'hello', env: 'prod' };
const actor = { subject: 'owner', email: 'owner@example.test', superAdmin: false };
const auth = { issuer: 'https://scope.example.test', audience: 'scope-api' };
function manifest(customer = false) {
  return JSON.stringify({
    manifestVersion: '2',
    server: { name: 'hello', title: 'Hello', version: '1.0.0', ...(customer ? { auth } : {}) },
    tools: [
      {
        name: 'help',
        description: 'Help',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}

for (const backend of ['no-store', 'memory', 'file', 'postgres'] as const) {
  describe.skipIf(backend === 'postgres' && !process.env.DATABASE_URL_TEST)(
    `${backend} exact deployment policy scope`,
    () => {
      let store: ArtifactStore | undefined;
      let registry: ServerRegistry;
      let cleanup: () => Promise<void>;
      beforeEach(async () => {
        cleanup = async () => {};
        store = undefined;
        if (backend === 'memory') store = new InMemoryArtifactStore();
        if (backend === 'file') {
          const dir = await mkdtemp(join(tmpdir(), 'deployment-policy-scope-'));
          store = new JsonFileArtifactStore(dir);
          cleanup = () => rm(dir, { recursive: true, force: true });
        }
        if (backend === 'postgres') {
          const schema = `deployment_policy_scope_${randomUUID().replaceAll('-', '')}`;
          const admin = new Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
          await admin.query(`CREATE SCHEMA ${schema}`);
          const pool = new Pool({
            connectionString: process.env.DATABASE_URL_TEST,
            max: 2,
            options: `-c search_path=${schema}`,
          });
          cleanup = async () => {
            await pool.end();
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            await admin.end();
          };
          const postgres = new PostgresArtifactStore(pool);
          await postgres.ensureSchema();
          await pool.query('INSERT INTO orgs (slug) VALUES ($1)', [tenant.org]);
          store = postgres;
        }
        registry = new ServerRegistry(store);
      });
      afterEach(async () => cleanup());

      it('rejects an unsupported unversioned policy even when a supported version is the default', async () => {
        const record: DeployRecord = {
          schemaVersion: 3,
          deploymentId: 'unsupported-scope',
          orgSlug: tenant.org,
          appSlug: tenant.app,
          environment: tenant.env,
          deploymentVersion: 1,
          active: true,
          serverName: 'hello',
          createdAt: '2026-09-11T00:00:00.000Z',
          accessMode: 'public',
          manifest: manifest(),
          secrets: { enc: 'none', values: {} },
        };
        const versioned = {
          ...record,
          deploymentId: 'supported-version',
          schemaVersion: 1,
          serverVersion: '1',
        };
        await store?.append(record);
        await store?.append(versioned);
        const state = {
          store,
          records: new Map([
            [record.deploymentId, record],
            [versioned.deploymentId, versioned],
          ]),
          servers: new Map(),
          activeTenants: new Map(),
          productionEnvironments: new Map(),
        };
        expect(await deploymentWriteVersionError(state, tenant, undefined)).toMatchObject({
          code: 'unsupported_deployment_record_version',
        });
        expect(await deploymentWriteVersionError(state, tenant, '1')).toBeUndefined();
      });

      it('replaces an unversioned deployment while preserving the versioned default', async () => {
        const original = await registry.deploy(tenant, manifest(), { accessMode: 'public' });
        const versioned = await registry.deploy(tenant, manifest(), {
          accessMode: 'org-members',
          serverVersion: '1',
          actor,
        });
        expect(original.ok && versioned.ok).toBe(true);
        if (!original.ok || !versioned.ok) return;
        expect(
          await registry.preflightDeploy(tenant, manifest(), { accessMode: 'public' }),
        ).toEqual({ ok: true });
        const replacement = await registry.deploy(tenant, manifest(), { accessMode: 'public' });
        expect(replacement).toMatchObject({ ok: true, accessMode: 'public' });
        if (!replacement.ok) return;
        expect(await registry.getDeployment(tenant.org, original.deploymentId)).toMatchObject({
          active: false,
        });
        expect(await registry.getDeployment(tenant.org, replacement.deploymentId)).toMatchObject({
          active: true,
        });
        expect(await registry.getActiveByTenant(tenant)).toMatchObject({
          deploymentId: versioned.deploymentId,
        });
        expect(await registry.getActiveByTenantVersion(tenant, '1')).toMatchObject({
          deploymentId: versioned.deploymentId,
        });
      });

      it('preserves schema 2 in the unversioned scope even when the default is schema 1', async () => {
        expect(
          (await registry.deploy(tenant, manifest(true), { accessMode: 'mixed', actor })).ok,
        ).toBe(true);
        const versioned = await registry.deploy(tenant, manifest(), {
          accessMode: 'public',
          serverVersion: '1',
        });
        expect(versioned.ok).toBe(true);
        const replacement = await registry.deploy(tenant, manifest(), { accessMode: 'public' });
        expect(replacement).toMatchObject({ ok: true });
        if (!replacement.ok) return;
        if (store)
          expect(await store.get(replacement.deploymentId)).toMatchObject({ schemaVersion: 2 });
        expect(await registry.get(replacement.deploymentId)).toMatchObject({
          accessMode: 'public',
        });
        if (versioned.ok)
          expect(await registry.getActiveByTenant(tenant)).toMatchObject({
            deploymentId: versioned.deploymentId,
          });
      });

      it('does not inherit a versioned customer policy into a new unversioned scope', async () => {
        const versioned = await registry.deploy(tenant, manifest(true), {
          accessMode: 'mixed',
          serverVersion: '1',
          actor,
        });
        expect(versioned.ok).toBe(true);
        const unversioned = await registry.deploy(tenant, manifest(), { accessMode: 'public' });
        expect(unversioned).toMatchObject({ ok: true });
        if (!unversioned.ok) return;
        if (store)
          expect(await store.get(unversioned.deploymentId)).toMatchObject({ schemaVersion: 1 });
        if (versioned.ok)
          expect(await registry.getActiveByTenant(tenant)).toMatchObject({
            deploymentId: versioned.deploymentId,
          });
      });
    },
  );
}
