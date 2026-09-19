import { InMemoryConnectorRegistry, StaticServiceBroker } from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import { createApplicationConnections } from '../src/application-connections.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import { fenceSourceStore } from '../src/business-information/source-credential-fence.js';
import { InMemorySourceIngestionStore } from '../src/business-information/source-ingestion-memory-store.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { InMemoryConnectionStore } from '../src/connections/store.js';
import { buildCredentialBindingIndex } from '../src/credential-binding-index.js';
import { oauthFixture } from './connection-oauth-fixture.js';
import { boundArtifact } from './external-credential-exchange.fixtures.js';
import { sourceBinding } from './source-credential-fence-suite.js';

async function fixture() {
  const provider = await oauthFixture();
  const scope = { org: 'acme', app: 'workflow', env: 'prod', installationId: 'installation' };
  const installations = new InMemoryBusinessInformationStore();
  const installed = await installations.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: [],
    actorSubject: 'owner',
  });
  const artifact = boundArtifact('records', 'account', 'search', ['records.read']);
  const served: ServedTarget = {
    org: scope.org,
    app: scope.app,
    environment: scope.env,
    deploymentId: 'deployment',
    served: {
      artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([]),
        broker: new StaticServiceBroker({ token: 'unused' }),
      },
    },
  };
  let providerAvailable = true;
  const runtime = createApplicationConnections({
    store: new InMemoryConnectionStore(),
    installations,
    providers: async () => (providerAvailable ? provider.provider : undefined),
    portalOrigins: ['https://portal.example.test'],
    credentialEpoch: 'fixture-epoch-0001',
    guardedFetch: (url, init) => provider.fetch(url, init),
    getRegistry: () => ({
      getActiveByTenant: async (ref) =>
        ref.org === scope.org && ref.app === scope.app && ref.env === scope.env
          ? served
          : undefined,
    }),
  });
  const target = (await runtime.resolveConnectionTargets(installed.installation))[0];
  const descriptor = buildCredentialBindingIndex(artifact).externalExchange[0]?.descriptor;
  if (!target || !descriptor) throw new Error('fixture missing target');
  return {
    provider,
    scope,
    installations,
    installed: installed.installation,
    served,
    runtime,
    target,
    descriptor,
    removeProvider: () => {
      providerAvailable = false;
    },
  };
}
describe('application connection composition', () => {
  it('does not install credentials when workspace revocation wins during provider consent', async () => {
    const f = await fixture();
    const workspaces = new BusinessWorkspaceStore(new InMemoryBusinessWorkspaceBackend(), {
      isIdentityActive: async () => true,
    });
    await workspaces.initializeNewWorkspace({ org: f.scope.org, ownerSubject: 'workspace-owner' });
    const invitation = await workspaces.invite({
      org: f.scope.org,
      actor: 'workspace-owner',
      expectedRevision: 1,
      email: 'owner@example.test',
      role: 'administrator',
    });
    await workspaces.accept({
      org: f.scope.org,
      subject: 'owner',
      verifiedEmail: 'owner@example.test',
      token: invitation.token,
    });
    f.installations.staff.configure(workspaces);
    const started = await f.runtime.connections.connect(
      f.target,
      {
        expectedRevision: 0,
        returnUrl: 'https://portal.example.test/o/acme/workflow/integrations',
        sessionBinding: 'b'.repeat(43),
      },
      'owner',
    );
    const providerFetch = f.provider.fetch;
    const spy = vi.spyOn(f.provider, 'fetch').mockImplementation(async (url, init) => {
      if (url.href === f.provider.provider.server.token_endpoint)
        await workspaces.changeRole({
          org: f.scope.org,
          actor: 'workspace-owner',
          expectedRevision: 3,
          subject: 'owner',
          role: null,
        });
      return providerFetch(url, init);
    });
    try {
      await expect(
        f.runtime.connections.callback(
          {
            ...f.provider.authorize(started.authorizationUrl),
            sessionBinding: 'b'.repeat(43),
          },
          'owner',
        ),
      ).rejects.toThrow('connection_denied');
      expect((await f.runtime.connections.inspect(f.target)).state).toBe('unconfigured');
      expect(f.provider.metrics().tokenCalls).toBe(1);
      expect((await f.installations.getGrant(f.scope, 'owner'))?.role).toBe('administrator');
    } finally {
      spy.mockRestore();
    }
  });
  it('uses workspace Owner/Admin authority, never supplementing it with old installation grants', async () => {
    const f = await fixture();
    const workspaces = new BusinessWorkspaceStore(new InMemoryBusinessWorkspaceBackend(), {
      isIdentityActive: async () => true,
    });
    await workspaces.initializeNewWorkspace({ org: f.scope.org, ownerSubject: 'workspace-owner' });
    f.installations.staff.configure(workspaces);
    const input = {
      expectedRevision: 0,
      returnUrl: 'https://portal.example.test/o/acme/workflow/integrations',
      sessionBinding: 'b'.repeat(43),
    };
    await expect(f.runtime.connections.connect(f.target, input, 'owner')).rejects.toThrow(
      'connection_denied',
    );
    for (const role of ['administrator', 'builder', 'operator', 'viewer'] as const) {
      const invitation = await workspaces.invite({
        org: f.scope.org,
        actor: 'workspace-owner',
        expectedRevision: (await workspaces.inspect(f.scope.org, 'workspace-owner')).revision,
        email: `${role}@example.test`,
        role,
      });
      await workspaces.accept({
        org: f.scope.org,
        subject: role,
        verifiedEmail: `${role}@example.test`,
        token: invitation.token,
      });
    }
    for (const actor of ['builder', 'operator', 'viewer', 'stranger'])
      await expect(f.runtime.connections.connect(f.target, input, actor)).rejects.toThrow(
        'connection_denied',
      );
    await expect(
      f.runtime.connections.connect(f.target, input, 'workspace-owner'),
    ).resolves.toHaveProperty('authorizationUrl');
    await expect(
      f.runtime.connections.connect(f.target, { ...input, expectedRevision: 1 }, 'administrator'),
    ).resolves.toHaveProperty('authorizationUrl');
  });
  it('keeps unconfigured apps available while binding account credentials to the active installation/deployment', async () => {
    const f = await fixture();
    expect(await f.runtime.readGenerations(f.served)).toMatchObject({
      account: expect.stringContaining('unconfigured:'),
    });
    const start = await f.runtime.connections.connect(
      f.target,
      {
        expectedRevision: 0,
        returnUrl: 'https://portal.example.test/o/acme/workflow/integrations',
        sessionBinding: 'b'.repeat(43),
      },
      'owner',
    );
    await f.runtime.connections.callback(
      { ...f.provider.authorize(start.authorizationUrl), sessionBinding: 'b'.repeat(43) },
      'owner',
    );
    const generations = await f.runtime.readGenerations(f.served);
    const generation = generations.account;
    if (!generation) throw new Error('fixture missing generation');
    const input = {
      tenantId: 'acme/workflow/prod',
      deploymentId: 'deployment',
      descriptor: f.descriptor,
      expectedConnectionGeneration: generation,
    };
    expect(await f.runtime.localProvider.getCredential(input)).toMatchObject({
      access_token: 'fixture-access-token',
    });
    for (const invalid of [
      { ...input, tenantId: 'other/workflow/prod' },
      { ...input, deploymentId: 'old' },
      { ...input, descriptor: { ...f.descriptor, operation: 'unregistered' } },
      { ...input, expectedConnectionGeneration: 'stale' },
    ])
      await expect(f.runtime.localProvider.getCredential(invalid)).rejects.toThrow();
    await expect(
      f.runtime.localProvider.getCredential({
        tenantId: input.tenantId,
        deploymentId: input.deploymentId,
        descriptor: f.descriptor,
      }),
    ).rejects.toThrow('connection_denied');
    await f.installations.setIntakeState({
      scope: f.scope,
      expectedRevision: f.installed.revision,
      active: false,
      actorSubject: 'owner',
    });
    await expect(f.runtime.localProvider.getCredential(input)).rejects.toThrow(
      'connection_unavailable',
    );
  });
  it('captures actual portable account authority and refuses registration removal or declared config drift', async () => {
    const f = await fixture();
    const start = await f.runtime.connections.connect(
      f.target,
      {
        expectedRevision: 0,
        returnUrl: 'https://portal.example.test/o/acme/workflow/integrations',
        sessionBinding: 'b'.repeat(43),
      },
      'owner',
    );
    await f.runtime.connections.callback(
      { ...f.provider.authorize(start.authorizationUrl), sessionBinding: 'b'.repeat(43) },
      'owner',
    );
    const raw = new InMemorySourceIngestionStore({ identityKey: 'x'.repeat(32) });
    const source = fenceSourceStore(raw, f.runtime.sourceCredentials);
    const declaration = {
      ...sourceBinding,
      scope: f.scope,
      bindingReference: f.descriptor.connectionId,
      configurationReference: f.descriptor.connectionConfigRevision,
    };
    const created = await source.createBinding(declaration);
    expect(created.credentialIdentity).toMatchObject({
      generation: (await f.runtime.readGenerations(f.served)).account,
      account: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      source.replaceBinding({
        ...declaration,
        generation: 2,
        configurationReference: 'forged',
        expectedRevision: created.revision,
        now: new Date(),
      }),
    ).rejects.toThrow('source_authorization_lost');
    f.removeProvider();
    const read = vi.spyOn(raw, 'listExternalRecords');
    await expect(source.listExternalRecords(created)).rejects.toThrow('source_authorization_lost');
    await expect(
      source.replaceBinding({
        ...declaration,
        generation: 2,
        expectedRevision: created.revision,
        now: new Date(),
      }),
    ).rejects.toThrow('source_authorization_lost');
    expect(read).not.toHaveBeenCalled();
    expect((await raw.getBinding(declaration))?.credentialIdentity).toEqual(
      created.credentialIdentity,
    );
  });
  it('revoked business administrator grants cannot authorize a callback', async () => {
    const f = await fixture();
    await expect(
      f.runtime.connections.connect(
        f.target,
        {
          expectedRevision: 0,
          returnUrl: 'https://portal.example.test/o/acme/workflow/integrations',
          sessionBinding: 'b'.repeat(43),
        },
        'developer',
      ),
    ).rejects.toThrow('connection_denied');
    expect(f.provider.metrics().tokenCalls).toBe(0);
  });
});
