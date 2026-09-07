import { describe, expect, it, vi } from 'vitest';
import { ApplicationSettings } from '../src/application-settings.js';
import { resolveSettingsTargets } from '../src/application-settings-targets.js';
import type { ServerRegistry } from '../src/registry.js';
import type { ArtifactStore, ConfigStore } from '../src/store.js';

const tenant = { org: 'acme', app: 'desk', env: 'prod' } as const;
const scope = { level: 'env', ...tenant } as const;
export function settingsRaceManifest(choices: readonly string[]) {
  return JSON.stringify({
    manifestVersion: '2',
    server: {
      name: 'desk',
      title: 'Desk',
      version: '1',
      variables: [
        {
          name: 'MODE',
          schemaVersion: 1,
          valueSchema: { type: 'string', enum: choices, maxLength: 20 },
          portal: { label: 'Mode' },
          requiredFor: [],
        },
      ],
    },
    tools: [
      {
        name: 'book',
        description: 'Book a consultation.',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: { mode: '${env.MODE}' } },
      },
    ],
  });
}
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function settingsDeploymentRaceSuite(
  name: string,
  fresh: () => Promise<{
    registry: ServerRegistry;
    config: ConfigStore;
    artifacts: ArtifactStore;
  }>,
) {
  describe(name, () => {
    it('updates cold deployment settings without opening downstream credentials or blocking another app', async () => {
      const { registry, config } = await fresh();
      await config.setConfigValue({ kind: 'variable', scope, name: 'MODE', value: '"short"' });
      expect(
        await registry.deploy(tenant, settingsRaceManifest(['short', 'long']), {
          accessMode: 'public',
          serverVersion: '1',
        }),
      ).toMatchObject({ ok: true });
      const warm = await resolveSettingsTargets(registry, scope);
      registry.setPlatformConnectors({ catalog: [] });
      const resolve = config.resolveConfigValues.bind(config);
      const custody = vi
        .spyOn(config, 'resolveConfigValues')
        .mockImplementation(async (kind, target, key) => {
          if (kind === 'secret' && target.level === 'env' && target.app === tenant.app)
            throw new Error('downstream credential custodian is unavailable');
          return resolve(kind, target, key);
        });
      try {
        const settings = new ApplicationSettings(config);
        await Promise.all([
          settings.writeTechnical(() => resolveSettingsTargets(registry, scope), {
            kind: 'variable',
            scope,
            name: 'MODE',
            value: '"long"',
          }),
          registry
            .deploy({ ...tenant, app: 'other' }, settingsRaceManifest(['short', 'long']), {
              accessMode: 'public',
              serverVersion: '1',
            })
            .then((result) => expect(result).toMatchObject({ ok: true })),
        ]);
        expect(await resolveSettingsTargets(registry, scope)).toEqual(warm);
        expect(await config.resolveConfigValues('variable', scope)).toEqual({ MODE: '"long"' });
        expect(
          custody.mock.calls.filter(
            ([kind, target]) =>
              kind === 'secret' && target.level === 'env' && target.app === tenant.app,
          ),
        ).toEqual([]);
      } finally {
        custody.mockRestore();
      }
    });

    it.each([
      'invalid-shape',
      'unknown-capability',
      'invalid-yaml',
      'missing-source',
    ])('refuses a technical mutation when persisted settings have %s', async (invalid) => {
      const { registry, config } = await fresh();
      await config.setConfigValue({ kind: 'variable', scope, name: 'MODE', value: '"short"' });
      const deployed = await registry.deploy(tenant, settingsRaceManifest(['short', 'long']), {
        accessMode: 'public',
        serverVersion: '1',
      });
      if (!deployed.ok) throw new Error('fixture deployment failed');
      const source = await registry.getDeploymentSource(tenant, deployed.deploymentId);
      if (!source) throw new Error('fixture source missing');
      const malformed = JSON.parse(source.manifest) as {
        manifestVersion: string;
        server: { variables: Array<{ requiredFor: string[] }> };
      };
      if (invalid === 'invalid-shape') malformed.manifestVersion = 'unsupported';
      else {
        const variable = malformed.server.variables[0];
        if (!variable) throw new Error('fixture declaration missing');
        variable.requiredFor = ['missing_tool'];
      }
      const read = vi.spyOn(registry, 'getDeploymentSource').mockResolvedValue(
        invalid === 'missing-source'
          ? undefined
          : {
              ...source,
              manifest:
                invalid === 'invalid-yaml'
                  ? 'server: [fixture-private-source-marker'
                  : JSON.stringify(malformed),
            },
      );
      try {
        await expect(
          new ApplicationSettings(config).writeTechnical(
            () => resolveSettingsTargets(registry, scope),
            { kind: 'variable', scope, name: 'MODE', value: '"long"' },
          ),
        ).rejects.toMatchObject({
          code: 'settings_unavailable',
          message:
            invalid === 'missing-source'
              ? 'Application settings inventory changed.'
              : 'Stored application settings are invalid.',
        });
        expect(await config.resolveConfigValues('variable', scope)).toEqual({ MODE: '"short"' });
      } finally {
        read.mockRestore();
      }
    });

    it('validates every concurrently served version sharing an environment', async () => {
      const { registry, config } = await fresh();
      await config.setConfigValue({ kind: 'variable', scope, name: 'MODE', value: '"short"' });
      expect(
        await registry.deploy(tenant, settingsRaceManifest(['short']), {
          accessMode: 'public',
          serverVersion: '1',
        }),
      ).toMatchObject({ ok: true });
      expect(
        await registry.deploy(tenant, settingsRaceManifest(['short', 'long']), {
          accessMode: 'public',
          serverVersion: '2',
        }),
      ).toMatchObject({ ok: true });
      const settings = new ApplicationSettings(config);
      await expect(
        settings.writeTechnical(() => resolveSettingsTargets(registry, scope), {
          kind: 'variable',
          scope,
          name: 'MODE',
          value: '"long"',
        }),
      ).rejects.toMatchObject({ code: 'settings_invalid' });
      expect(await config.resolveConfigValues('variable', scope)).toEqual({ MODE: '"short"' });
    });
    it.each([
      'deployment',
      'rollback',
    ])('serializes queued %s after a conflicting configuration commit', async (operation) => {
      const { registry, config } = await fresh();
      const historical = await registry.deploy(tenant, settingsRaceManifest(['short']), {
        accessMode: 'public',
      });
      if (!historical.ok) throw new Error('historical fixture failed');
      const initial = await registry.deploy(tenant, settingsRaceManifest(['short', 'long']), {
        accessMode: 'public',
      });
      if (!initial.ok || !config.transactConfig) throw new Error('fixture initialization failed');
      await config.setConfigValue({ kind: 'variable', scope, name: 'MODE', value: '"short"' });
      const entered = signal();
      const release = signal();
      const writer = config.transactConfig('acme', async (transaction) => {
        entered.resolve();
        await release.promise;
        await transaction.setConfigValue({
          kind: 'variable',
          scope,
          name: 'MODE',
          value: '"long"',
        });
      });
      await entered.promise;
      let finished = false;
      const candidate = (
        operation === 'deployment'
          ? registry.deploy(tenant, settingsRaceManifest(['short']), { accessMode: 'public' })
          : registry.rollback(tenant, historical.deploymentId)
      ).then((result) => {
        finished = true;
        return result;
      });
      try {
        await new Promise((done) => setTimeout(done, 30));
        expect(finished).toBe(false);
      } finally {
        release.resolve();
      }
      await writer;
      expect(await candidate).toMatchObject(
        operation === 'deployment'
          ? { ok: false, errors: [{ code: 'configuration_invalid' }] }
          : { ok: false, status: 409 },
      );
      expect((await registry.getActiveByTenant(tenant))?.deploymentId).toBe(initial.deploymentId);
      expect(await config.resolveConfigValues('variable', scope)).toEqual({ MODE: '"long"' });
    });

    it.each([
      'technical',
      'portal',
    ])('refreshes queued %s writer declarations only after candidate activation commits', async (kind) => {
      const { registry, config, artifacts } = await fresh();
      await config.setConfigValue({ kind: 'variable', scope, name: 'MODE', value: '"short"' });
      await registry.deploy(tenant, settingsRaceManifest(['short', 'long']), {
        accessMode: 'public',
      });
      const entered = signal();
      const release = signal();
      const settings = new ApplicationSettings(config);
      const previousTarget = (await resolveSettingsTargets(registry, scope))[0];
      if (!previousTarget) throw new Error('current settings target missing');
      const previous = await settings.read(previousTarget, true);
      const append = artifacts.append.bind(artifacts);
      const spy = vi.spyOn(artifacts, 'append').mockImplementationOnce(async (record) => {
        entered.resolve();
        await release.promise;
        await append(record);
      });
      const candidate = registry.deploy(tenant, settingsRaceManifest(['short']), {
        accessMode: 'public',
      });
      await entered.promise;
      let inspected = false;
      const inventory = async () => {
        inspected = true;
        return resolveSettingsTargets(registry, scope);
      };
      const writer =
        kind === 'technical'
          ? settings.writeTechnical(inventory, {
              kind: 'variable',
              scope,
              name: 'MODE',
              value: '"long"',
            })
          : settings.save(
              previousTarget,
              {
                expectedRevision: previous.revision,
                schemaDigest: previous.schemaDigest,
                values: { MODE: 'long' },
              },
              'owner',
              inventory,
            );
      const outcome = writer.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await new Promise((done) => setTimeout(done, 30));
        expect(inspected).toBe(false);
      } finally {
        release.resolve();
      }
      expect(await candidate).toMatchObject({ ok: true });
      expect(await outcome).toMatchObject({
        error: { code: kind === 'technical' ? 'settings_invalid' : 'settings_conflict' },
      });
      spy.mockRestore();
      expect(await config.resolveConfigValues('variable', scope)).toEqual({ MODE: '"short"' });
    });
  });
}
