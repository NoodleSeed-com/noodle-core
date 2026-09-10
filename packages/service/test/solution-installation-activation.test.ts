import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway/portable';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { DeploymentActivationError } from '@noodle-borg/module';
import { executeTool } from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationServingRuntime } from '../src/application-runtime-target.js';
import { ApplicationSettings, installationSettingsTarget } from '../src/application-settings.js';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { managedSolutionManifest } from '../src/business-information/managed-solution-executable.js';
import { createDeploymentNativeRecordConnector } from '../src/native-record-connector.js';
import { ServerRegistry } from '../src/registry.js';
import {
  activateSolutionInstallation,
  readSolutionInstallationActivation,
} from '../src/solution-installation-activation.js';
import { InMemoryAuditStore } from '../src/store/audit.js';

async function setup() {
  const store = new InMemoryBusinessInformationStore();
  const counters = new InMemoryDailyCounterStore();
  const registry = new ServerRegistry(undefined, undefined, undefined, {
    nativeRecords: (input) => createDeploymentNativeRecordConnector(input, { store, counters }),
  });
  registry.setApplicationLifecycleObserver((org, app, at, retired) =>
    store.pauseApplication(org, app, at, retired),
  );
  const controlPlane = new InMemoryControlPlaneStore();
  const actor = { subject: 'owner', email: 'owner@example.com', superAdmin: false };
  await controlPlane.createOrgWithOwner({ slug: 'acme', owner: actor });
  const dependencies = {
    registry,
    controlPlane,
    businessInformationStore: store,
    options: {},
    audit: new InMemoryAuditStore(),
  };
  return { store, registry, actor, dependencies };
}

describe('installation executable activation', () => {
  it('never reattaches retained memory custody to an archived, purged or recreated application', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    try {
      const { store, registry, actor, dependencies } = await setup();
      const { installation } = await store.createInstallation({
        scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' },
        profileKey: 'travel',
        managedCollections: ['travel_requests'],
        actorSubject: actor.subject,
      });
      expect(
        await activateSolutionInstallation({ installation, actor }, dependencies),
      ).toMatchObject({ ok: true });
      const generation = (await store.getInstallation(installation.scope))?.applicationGeneration;
      expect(generation).toBe(await registry.getAppGeneration('acme', 'travel'));
      await registry.archiveApp('acme', 'travel', '2026-01-01T00:00:00.000Z');
      expect(await store.getInstallation(installation.scope)).toMatchObject({
        intakeActive: false,
      });
      expect(
        await activateSolutionInstallation({ installation, actor }, dependencies),
      ).toMatchObject({ ok: false, code: 'installation_application_unavailable' });
      await registry.sweepArchived('2026-02-01T00:00:00.000Z');
      expect(await readSolutionInstallationActivation(installation, dependencies)).toBe(
        'unavailable',
      );
      expect(
        await activateSolutionInstallation({ installation, actor }, dependencies),
      ).toMatchObject({ ok: false });
      await registry.deploy(
        installation.scope,
        JSON.stringify(managedSolutionManifest(installation.definition)),
        { actor, accessMode: 'public' },
      );
      expect(await registry.getAppGeneration('acme', 'travel')).toBe(generation);
      expect(await readSolutionInstallationActivation(installation, dependencies)).toBe(
        'unavailable',
      );
      expect(
        await activateSolutionInstallation({ installation, actor }, dependencies),
      ).toMatchObject({ ok: false, code: 'installation_application_unavailable' });
      expect((await store.getInstallation(installation.scope))?.applicationGeneration).toBe(
        'retired',
      );
      expect(await store.getGrant(installation.scope, actor.subject)).toMatchObject({
        role: 'administrator',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('deploys a managed installation through normal deployment and retries without another activation', async () => {
    const { store, registry, actor, dependencies } = await setup();
    const { installation } = await store.createInstallation({
      scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' },
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: actor.subject,
      actorEmail: actor.email,
    });
    const deploy = vi.spyOn(registry, 'deploy');
    const first = await activateSolutionInstallation({ installation, actor }, dependencies);
    expect(first).toMatchObject({ ok: true, deploymentId: expect.any(String) });
    expect(await activateSolutionInstallation({ installation, actor }, dependencies)).toEqual(
      first,
    );
    expect(deploy).toHaveBeenCalledTimes(1);
    const active = await registry.getActiveByTenant(installation.scope);
    expect(active?.served.artifact.tools[0]?.name).toBe('submit_travel_request');
  });
  it('refreshes managed executable bytes while retaining operator access and business records', async () => {
    const { store, registry, actor, dependencies } = await setup();
    const { installation } = await store.createInstallation({
      scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' },
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: actor.subject,
      actorEmail: actor.email,
    });
    const initial = managedSolutionManifest(installation.definition);
    const prior = await registry.deploy(
      installation.scope,
      JSON.stringify({
        ...initial,
        server: { ...(initial.server as Record<string, unknown>), title: 'Previous executable' },
      }),
      { actor, accessMode: 'owner-only', ownerSubject: actor.subject, serverVersion: '1' },
    );
    expect(prior.ok).toBe(true);
    await store.createRequest({
      scope: installation.scope,
      collectionKey: 'travel_requests',
      payload: { request_type: 'service', summary: 'Preserve me' },
      idempotencyKey: 'existing-record',
      origin: { kind: 'portal' },
      actorSubject: actor.subject,
    });
    const updated = await activateSolutionInstallation(
      { installation, actor: { subject: 'noodle:managed-solution-release' } },
      dependencies,
    );
    expect(updated).toMatchObject({ ok: true });
    const active = await registry.getActiveByTenant(installation.scope);
    expect(active?.accessMode).toBe('owner-only');
    expect(active?.ownerSubject).toBe(actor.subject);
    expect(active?.served.artifact.server.title).toBe('Travel');
    expect(
      (await store.listRequests({ scope: installation.scope, collectionKey: 'travel_requests' }))
        .records,
    ).toHaveLength(1);
  });
  it('preserves normal commercial activation refusal and a system release actor on retry', async () => {
    const { store, registry, actor, dependencies } = await setup();
    const { installation } = await store.createInstallation({
      scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' },
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: actor.subject,
      actorEmail: actor.email,
    });
    const deploy = vi
      .spyOn(registry, 'deploy')
      .mockRejectedValueOnce(new DeploymentActivationError('production_app_limit_exceeded'));
    expect(await activateSolutionInstallation({ installation, actor }, dependencies)).toMatchObject(
      { ok: false, status: 409, code: 'production_app_limit_exceeded' },
    );
    expect(await registry.getActiveByTenant(installation.scope)).toBeUndefined();
    const systemActor = { subject: 'noodle:managed-solution-release' };
    expect(
      await activateSolutionInstallation({ installation, actor: systemActor }, dependencies),
    ).toMatchObject({ ok: true });
    expect(deploy.mock.calls[1]?.[2]?.actor).toEqual(systemActor);
  });
  it('pins same-organization private executable bytes and refuses cross-tenant source substitution', async () => {
    const { store, registry, actor, dependencies } = await setup();
    const tenant = { org: 'acme', app: 'source', env: 'prod' };
    const manifest = JSON.stringify({
      manifestVersion: '2',
      server: {
        name: 'source',
        version: '1.0.0',
        title: 'Private tools',
        variables: [
          {
            name: 'GREETING',
            schemaVersion: 1,
            valueSchema: { type: 'string', maxLength: 100 },
            portal: { label: 'Greeting' },
            requiredFor: ['hello'],
          },
          {
            name: 'ENABLED',
            schemaVersion: 1,
            valueSchema: { type: 'boolean' },
            default: false,
            portal: { label: 'Enabled' },
            requiredFor: [],
          },
        ],
      },
      tools: [
        {
          name: 'hello',
          description: 'Read a greeting.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {} },
          fulfilment: {
            steps: [{ id: 'greeting', map: { message: '${env.GREETING}' } }],
            output: { message: '${steps.greeting.message}' },
          },
        },
      ],
    });
    const source = await registry.deploy(tenant, manifest, {
      accessMode: 'public',
      serverVersion: '1',
    });
    if (!source.ok) throw new Error(JSON.stringify(source));
    const target = await registry.get(source.deploymentId);
    if (target === undefined) throw new Error('source missing');
    const definition = privateDefinitionFromDeployment(
      {
        publisherOrg: 'acme',
        app: 'source',
        environment: 'prod',
        deploymentId: source.deploymentId,
      },
      {
        ...tenant,
        environment: tenant.env,
        deploymentId: source.deploymentId,
        artifact: target.served.artifact,
      },
    );
    // An existing buyer deployment without declarations must pin newly accepted defaults too.
    expect(
      await registry.deploy(
        { org: 'acme', app: 'buyer', env: 'prod' },
        JSON.stringify({
          manifestVersion: '2',
          server: { name: 'buyer', version: '1', title: 'Previous application' },
          tools: [
            {
              name: 'legacy',
              description: 'Read the prior application.',
              inputSchema: { type: 'object' },
              fulfilment: { steps: [], output: { ok: true } },
            },
          ],
        }),
        { accessMode: 'public', serverVersion: '1' },
      ),
    ).toMatchObject({ ok: true });
    const { installation } = await store.createInstallation({
      scope: { org: 'acme', app: 'buyer', env: 'prod', installationId: 'buyer-prod' },
      definition,
      managedCollections: [],
      actorSubject: actor.subject,
      actorEmail: actor.email,
    });
    const result = await activateSolutionInstallation({ installation, actor }, dependencies);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(
      await registry.configStore.listConfigValues('variable', {
        level: 'env',
        org: 'acme',
        app: 'buyer',
        env: 'prod',
      }),
    ).toMatchObject([{ name: 'ENABLED', value: 'false', valueOrigin: 'default' }]);
    const installed = await registry.get(result.deploymentId);
    if (!installed) throw new Error('installed application missing');
    expect(
      await executeTool(installed.served.artifact, 'hello', {}, installed.served.deps),
    ).toMatchObject({ ok: false, error: { code: 'configuration_required' } });
    const settings = new ApplicationSettings(registry.configStore);
    const settingsTarget = installationSettingsTarget(installation);
    const projection = await settings.read(settingsTarget, true);
    await settings.save(
      settingsTarget,
      {
        expectedRevision: projection.revision,
        schemaDigest: projection.schemaDigest,
        values: { GREETING: 'Configured through Portal' },
      },
      actor.subject,
    );
    expect(
      await executeTool(installed.served.artifact, 'hello', {}, installed.served.deps),
    ).toMatchObject({ ok: true, output: { message: 'Configured through Portal' } });
    expect(
      await registry.configStore.resolveConfigValues('variable', { level: 'env', ...tenant }),
    ).toEqual({});
    expect(
      (await registry.getDeploymentSource(installation.scope, result.deploymentId))?.manifest,
    ).toBe(manifest);
    expect(
      await registry.getDeploymentSource({ ...tenant, org: 'other' }, source.deploymentId),
    ).toBeUndefined();
    const sameScope = await store.createInstallation({
      scope: { ...tenant, installationId: 'source-prod' },
      definition,
      managedCollections: [],
      actorSubject: actor.subject,
      actorEmail: actor.email,
    });
    const deploy = vi.spyOn(registry, 'deploy');
    expect(
      await activateSolutionInstallation(
        { installation: sameScope.installation, actor },
        dependencies,
      ),
    ).toEqual({ ok: true, deploymentId: source.deploymentId });
    expect(deploy).not.toHaveBeenCalled();
    expect(
      await activateSolutionInstallation(
        {
          installation: { ...installation, scope: { ...installation.scope, org: 'other' } },
          actor,
        },
        dependencies,
      ),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe('saved installation recovery', () => {
  it.each([
    'revoked',
    'unavailable',
  ] as const)('keeps independent MCP serving available when public embed custody is %s', async (failure) => {
    const { store, registry, actor, dependencies } = await setup();
    const publicEmbeds = new InMemoryPublicEmbedStore();
    const options = { businessInformationStore: store, publicEmbeds };
    const deps = { ...dependencies, options };
    const { installation } = await store.createInstallation({
      scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' },
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: actor.subject,
    });
    expect(await activateSolutionInstallation({ installation, actor }, deps)).toMatchObject({
      ok: true,
    });
    const target = await registry.getActiveByTenant(installation.scope);
    const [embed] = await publicEmbeds.list(installation.scope);
    if (!target || !embed) throw new Error('activated fixture is missing');
    const list = vi.spyOn(publicEmbeds, 'list');
    if (failure === 'revoked') await publicEmbeds.revoke(embed.embedId, new Date());
    else list.mockRejectedValue(new Error('synthetic embed custody outage'));
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('unavailable');
    expect(await activateSolutionInstallation({ installation, actor }, deps)).toMatchObject({
      ok: false,
      code:
        failure === 'revoked' ? 'installation_embed_revoked' : 'installation_activation_incomplete',
    });
    const { resolveRuntimeTarget } = createApplicationServingRuntime(
      registry,
      options,
      dependencies.controlPlane,
      dependencies.audit,
      undefined,
    );
    const resolved = await resolveRuntimeTarget(target);
    expect(resolved?.deploymentId).toBe(target.deploymentId);
    expect(resolved?.served.artifact.tools.map((tool) => tool.name)).toContain(
      'submit_travel_request',
    );
    list.mockRestore();
    expect(await publicEmbeds.list(installation.scope, { includeRevoked: true })).toHaveLength(1);
    if (failure === 'revoked') expect(await publicEmbeds.lookup(embed.embedId)).toBeUndefined();
    const saved = await store.getInstallation(installation.scope);
    await store.setIntakeState({
      scope: installation.scope,
      active: false,
      expectedRevision: saved?.revision ?? 0,
      actorSubject: actor.subject,
    });
    expect(await resolveRuntimeTarget(target)).toBeUndefined();
  });

  it('repairs a lost embed allocation without deploying twice or resuming paused intake', async () => {
    const { store, registry, actor, dependencies } = await setup();
    const publicEmbeds = new InMemoryPublicEmbedStore();
    const deps = { ...dependencies, options: { publicEmbeds } };
    const { installation } = await store.createInstallation({
      scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' },
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: actor.subject,
    });
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('pending');
    const deploy = vi.spyOn(registry, 'deploy');
    vi.spyOn(publicEmbeds, 'ensure').mockRejectedValueOnce(new Error('synthetic store outage'));
    expect(await activateSolutionInstallation({ installation, actor }, deps)).toMatchObject({
      ok: false,
      code: 'installation_activation_incomplete',
    });
    const saved = await store.getInstallation(installation.scope);
    expect(saved?.applicationGeneration).not.toBe('pending');
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('pending');
    await store.setIntakeState({
      scope: installation.scope,
      active: false,
      expectedRevision: saved?.revision ?? 0,
      actorSubject: actor.subject,
    });
    const repaired = await activateSolutionInstallation({ installation, actor }, deps);
    expect(repaired).toMatchObject({ ok: true });
    expect(await activateSolutionInstallation({ installation, actor }, deps)).toEqual(repaired);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('ready');
    vi.spyOn(publicEmbeds, 'list').mockRejectedValueOnce(new Error('synthetic read outage'));
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('unavailable');
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('ready');
    expect((await store.getInstallation(installation.scope))?.intakeActive).toBe(false);
    const [embed] = await publicEmbeds.list(installation.scope);
    expect(embed).toBeDefined();
    await publicEmbeds.revoke(embed?.embedId ?? '', new Date());
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('unavailable');
    expect(await activateSolutionInstallation({ installation, actor }, deps)).toMatchObject({
      ok: false,
      code: 'installation_embed_revoked',
    });
    expect(await publicEmbeds.lookup(embed?.embedId ?? '')).toBeUndefined();
    expect(await publicEmbeds.list(installation.scope, { includeRevoked: true })).toHaveLength(1);
    expect(deploy).toHaveBeenCalledTimes(1);
    await registry.archiveApp('acme', 'travel', new Date().toISOString());
    expect(await readSolutionInstallationActivation(installation, deps)).toBe('unavailable');
  });
});
