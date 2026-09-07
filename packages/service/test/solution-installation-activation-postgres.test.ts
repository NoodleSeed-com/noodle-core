import { randomUUID } from 'node:crypto';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { DEPLOYMENT_ACTIVATION_PHASE } from '@noodle-borg/module';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { builtInDefinition } from '../src/business-information/profiles.js';
import { createDeploymentNativeRecordConnector } from '../src/native-record-connector.js';
import { ServerRegistry } from '../src/registry.js';
import { activateSolutionInstallation } from '../src/solution-installation-activation.js';
import { InMemoryAuditStore } from '../src/store/audit.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(databaseUrl === undefined)(
  'concurrent installation activation on PostgreSQL',
  () => {
    const schema = `installation_activation_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schema}`,
    });
    const business = new PostgresBusinessInformationStore(pool, new TestPayloadCipher());
    let hold:
      | { entered: ReturnType<typeof signal>; release: ReturnType<typeof signal> }
      | undefined;
    const artifacts = new PostgresArtifactStore(pool, {
      deploymentActivation: [
        {
          id: 'test.installation-activation',
          phase: DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY,
          prepare: async (transaction, target) => {
            if (target.app !== 'buyer') return;
            await transaction.query('INSERT INTO activation_receipts (org) VALUES ($1)', [
              target.org,
            ]);
            hold?.entered.resolve();
            await hold?.release.promise;
          },
          assert: async () => {},
        },
      ],
    });
    beforeAll(async () => {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await artifacts.ensureSchema();
      await business.ensureSchema();
      await pool.query('CREATE TABLE activation_receipts (org text NOT NULL)');
    });
    afterAll(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    });
    it.each([
      'managed',
      'private',
    ] as const)('coalesces concurrent %s installation and executable activation across independent registries', async (kind) => {
      const org = `org-${randomUUID()}`;
      await artifacts.createOrg({ slug: org });
      const counters = new InMemoryDailyCounterStore();
      const registries = [0, 1].map(
        () =>
          new ServerRegistry(artifacts, undefined, artifacts, {
            nativeRecords: (input) =>
              createDeploymentNativeRecordConnector(input, { store: business, counters }),
            transactionalModuleDeploymentActivation: true,
          }),
      );
      const firstRegistry = registries[0];
      const secondRegistry = registries[1];
      if (!firstRegistry || !secondRegistry) throw new Error('registry fixture missing');
      let definition = builtInDefinition('travel');
      if (kind === 'private') {
        const sourceScope = { org, app: 'publisher', env: 'prod' };
        const deployed = await firstRegistry.deploy(
          sourceScope,
          JSON.stringify({
            manifestVersion: '2',
            server: { name: 'publisher', title: 'Private app', version: '1' },
            tools: [
              {
                name: 'hello',
                description: 'Read a greeting.',
                inputSchema: { type: 'object' },
                fulfilment: { steps: [], output: { message: 'Hello' } },
              },
            ],
          }),
          { accessMode: 'public', serverVersion: '1' },
        );
        if (!deployed.ok) throw new Error('source deployment failed');
        const source = await firstRegistry.get(deployed.deploymentId);
        if (!source) throw new Error('source artifact missing');
        definition = privateDefinitionFromDeployment(
          {
            publisherOrg: org,
            app: 'publisher',
            environment: 'prod',
            deploymentId: deployed.deploymentId,
          },
          {
            ...sourceScope,
            environment: 'prod',
            deploymentId: deployed.deploymentId,
            artifact: source.served.artifact,
          },
        );
      }
      const scope = { org, app: 'buyer', env: 'prod', installationId: 'buyer-prod' };
      const actor = { subject: 'owner', email: 'owner@example.test', superAdmin: false };
      const input = {
        scope,
        definition,
        managedCollections: definition.collections.map((collection) => collection.key),
        actorSubject: actor.subject,
        actorEmail: actor.email,
      };
      const installs = await Promise.all([
        business.createInstallation(input),
        business.createInstallation(input),
      ]);
      expect(installs.map((result) => result.disposition).sort()).toEqual(['created', 'replayed']);
      const installation = installs[0]?.installation;
      if (!installation) throw new Error('installation fixture missing');
      const dependencies = {
        controlPlane: artifacts,
        businessInformationStore: business,
        options: {},
        audit: new InMemoryAuditStore(),
      };
      hold = { entered: signal(), release: signal() };
      const activating = activateSolutionInstallation(
        { installation, actor },
        { ...dependencies, registry: firstRegistry },
      );
      await hold.entered.promise;
      let secondFinished = false;
      const competing = activateSolutionInstallation(
        { installation, actor },
        { ...dependencies, registry: secondRegistry },
      ).then((result) => {
        secondFinished = true;
        return result;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(secondFinished).toBe(false);
      } finally {
        hold.release.resolve();
      }
      const results = await Promise.all([activating, competing]);
      expect(results[0]).toMatchObject({ ok: true });
      expect(results[1]).toEqual(results[0]);
      expect(await artifacts.listDeployments({ org, app: 'buyer', env: 'prod' })).toHaveLength(1);
      expect(
        (
          await pool.query('SELECT count(*)::int AS count FROM activation_receipts WHERE org=$1', [
            org,
          ])
        ).rows,
      ).toEqual([{ count: 1 }]);
      expect(await business.listInstallations(org)).toHaveLength(1);
      expect(await business.getInstallation(scope)).toMatchObject({
        publicId: installation.publicId,
        applicationGeneration: await artifacts.getAppGeneration(org, 'buyer'),
      });
      expect(await business.getGrant(scope, actor.subject)).toMatchObject({
        role: 'administrator',
        revision: 1,
      });
      expect(
        await activateSolutionInstallation(
          { installation, actor },
          { ...dependencies, registry: secondRegistry },
        ),
      ).toEqual(results[0]);
      hold = undefined;
    });
  },
);
