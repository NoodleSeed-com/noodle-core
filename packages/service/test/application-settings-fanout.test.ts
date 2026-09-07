import { executePreparedTool, prepareToolForConfirmation } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { ApplicationSettings, installationSettingsTarget } from '../src/application-settings.js';
import { resolveSettingsTargets } from '../src/application-settings-targets.js';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { ServerRegistry } from '../src/registry.js';

const tenants = [
  { org: 'acme', app: 'desk', env: 'prod' },
  { org: 'acme', app: 'desk', env: 'staging' },
  { org: 'acme', app: 'shop', env: 'prod' },
  { org: 'other', app: 'desk', env: 'prod' },
];

describe('inherited settings across installed applications', () => {
  it('atomically fans out org/app changes and resets while fencing only changed prepared intent', async () => {
    const registry = new ServerRegistry();
    const installations = new InMemoryBusinessInformationStore();
    const settings = new ApplicationSettings(registry.configStore);
    const installed = await Promise.all(
      tenants.map(async (tenant) => {
        const manifest = JSON.stringify({
          manifestVersion: '2',
          server: {
            name: 'desk',
            version: '1',
            title: 'Desk',
            variables: [
              {
                name: 'DURATION',
                schemaVersion: 1,
                valueSchema: {
                  type: 'integer',
                  minimum: 15,
                  maximum: tenant.app === 'shop' ? 60 : 90,
                },
                default: 30,
                portal: { label: 'Duration' },
                requiredFor: ['book'],
              },
            ],
          },
          tools: [
            {
              name: 'book',
              description: 'Book a consultation.',
              inputSchema: { type: 'object', additionalProperties: false },
              fulfilment: { steps: [], output: { duration: '${env.DURATION}' } },
            },
          ],
        });
        const deployed = await registry.deploy(tenant, manifest, { accessMode: 'public' });
        if (!deployed.ok) throw new Error('fixture deployment rejected');
        const served = await registry.get(deployed.deploymentId);
        if (!served) throw new Error('fixture deployment missing');
        const selector = {
          publisherOrg: tenant.org,
          app: tenant.app,
          environment: tenant.env,
          deploymentId: deployed.deploymentId,
        };
        const definition = privateDefinitionFromDeployment(selector, {
          ...tenant,
          environment: tenant.env,
          deploymentId: deployed.deploymentId,
          artifact: served.served.artifact,
        });
        const { installation } = await installations.createInstallation({
          scope: { ...tenant, installationId: `${tenant.app}-${tenant.env}` },
          definition,
          managedCollections: [],
          actorSubject: 'owner',
        });
        const target = installationSettingsTarget(installation);
        await settings.initialize(target);
        return { target, served: served.served };
      }),
    );
    const write = async (scope: Parameters<typeof resolveSettingsTargets>[1], value?: string) =>
      settings.writeTechnical(await resolveSettingsTargets(registry, scope, installations), {
        scope,
        kind: 'variable',
        name: 'DURATION',
        ...(value === undefined ? {} : { value }),
      });
    const first = installed[0];
    if (!first) throw new Error('first installation missing');
    const initial = await settings.read(first.target, true);
    await settings.save(
      first.target,
      {
        expectedRevision: initial.revision,
        schemaDigest: initial.schemaDigest,
        values: { DURATION: 60 },
      },
      'owner',
    );
    const before = await Promise.all(installed.map(({ target }) => settings.read(target, true)));
    const prepared = await Promise.all(
      installed.map(({ served }) =>
        prepareToolForConfirmation(served.artifact, 'book', {}, served.deps),
      ),
    );
    await write({ level: 'org', org: 'acme' }, '45');
    const after = await Promise.all(installed.map(({ target }) => settings.read(target, true)));
    expect(after.map((entry) => entry.values.DURATION)).toEqual([60, 45, 45, 30]);
    expect(after.map((entry) => entry.provenance.DURATION)).toEqual([
      'operator',
      'organization',
      'organization',
      'default',
    ]);
    expect(after[3]?.revision).toBe(before[3]?.revision);
    for (const [index, preparation] of prepared.entries()) {
      if (preparation.status !== 'confirmation_required')
        throw new Error('fixture preparation failed');
      const served = installed[index]?.served;
      if (!served) throw new Error('prepared installation missing');
      const result = await executePreparedTool(
        served.artifact,
        preparation.continuation,
        served.deps,
      );
      expect(result).toMatchObject(
        index === 1 || index === 2
          ? { status: 'failed', error: { code: 'configuration_changed' } }
          : { status: 'completed' },
      );
    }
    await expect(write({ level: 'org', org: 'acme' }, '75')).rejects.toMatchObject({
      code: 'settings_invalid',
    });
    expect(await Promise.all(installed.map(({ target }) => settings.read(target, true)))).toEqual(
      after,
    );
    await write({ level: 'app', org: 'acme', app: 'desk' }, '75');
    const reset = await settings.read(first.target, true);
    await settings.save(
      first.target,
      {
        expectedRevision: reset.revision,
        schemaDigest: reset.schemaDigest,
        values: {},
        resetKeys: ['DURATION'],
      },
      'owner',
    );
    expect((await settings.read(first.target, true)).values.DURATION).toBe(75);
    await write({ level: 'app', org: 'acme', app: 'desk' });
    expect((await settings.read(first.target, true)).values.DURATION).toBe(45);
    await write({ level: 'org', org: 'acme' });
    expect((await settings.read(first.target, true)).values.DURATION).toBe(30);
    // A legacy bad parent value cannot be exposed by deleting a valid child override.
    await write({ level: 'app', org: 'acme', app: 'desk' }, '60');
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'org', org: 'acme' },
      name: 'DURATION',
      value: '"invalid legacy value"',
    });
    await expect(write({ level: 'app', org: 'acme', app: 'desk' })).rejects.toMatchObject({
      code: 'settings_invalid',
    });
    expect((await settings.read(first.target, true)).values.DURATION).toBe(60);
  });
});
