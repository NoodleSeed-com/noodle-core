import {
  ARTIFACT_SCHEMA_VERSION,
  computeConnectionConfigRevision,
  computeSignatureHash,
  type ResolvedOperationRef,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import {
  type ConnectorCall,
  ConnectorInvocationError,
  type CredentialRequest,
} from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeTargetResolver } from '../src/application-runtime-target.js';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { RegistrySourceReadExecutor } from '../src/business-information/source-executor.js';
import type { SourceBindingRecord } from '../src/business-information/source-ingestion-contracts.js';
import { buildCredentialBindingIndex } from '../src/credential-binding-index.js';
import type { ServerRegistry } from '../src/registry.js';

const recordSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: { code: { type: 'string' } },
} as const;

const scanInput = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'limit'],
  properties: {
    mode: { type: 'string', enum: ['snapshot', 'changes'] },
    cursor: { type: 'string' },
    checkpoint: { type: 'string' },
    limit: { type: 'integer' },
  },
};

const scanOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['records', 'deletedIds', 'complete'],
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'record'],
        properties: {
          id: { type: 'string' },
          version: { type: 'string' },
          record: recordSchema,
        },
      },
    },
    deletedIds: { type: 'array', items: { type: 'string' } },
    nextCursor: { type: 'string' },
    checkpoint: { type: 'string' },
    complete: { type: 'boolean' },
    resetRequired: { type: 'boolean' },
  },
};

const scanSignature = { type: 'read' as const, input: scanInput, output: scanOutput };
const signatureHash = computeSignatureHash('scan_stock', scanSignature);

interface TenantFixture {
  readonly org: string;
  readonly deploymentId: string;
  readonly connectionId: string;
  readonly token: string;
}

function scopeFor(fixture: TenantFixture, installationId = 'equipment-prod') {
  return {
    org: fixture.org,
    app: 'equipment-installed',
    env: 'prod',
    installationId,
  };
}

function definitionFor(fixture: TenantFixture, publisherOrg = fixture.org) {
  return privateDefinitionFromDeployment(
    { publisherOrg, app: 'equipment', environment: 'prod', deploymentId: fixture.deploymentId },
    {
      org: publisherOrg,
      app: 'equipment',
      environment: 'prod',
      deploymentId: fixture.deploymentId,
      artifact: artifactFor(operationFor(fixture)),
    },
  );
}

function operationFor(fixture: TenantFixture): ResolvedOperationRef {
  return {
    resolved: true,
    alias: 'inventory',
    connectorId: 'inventory_api',
    connectorVersion: '1.0.0',
    operation: 'scan_stock',
    signatureHash,
    credentialBinding: {
      bindingId: 'inventory',
      connectionId: fixture.connectionId,
      connectionConfigRevision: 'configuration-1',
      profile: 'account',
      presentation: { kind: 'bearer' },
      requiredScopes: ['inventory.read'],
    },
  };
}

function artifactFor(operation: ResolvedOperationRef): RuntimeArtifact {
  return {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    resolution: 'resolved',
    source: { manifestName: 'equipment', manifestVersion: '1.0.0', coreVersion: '2' },
    server: {
      name: 'equipment',
      title: 'Equipment operations',
      version: '1.0.0',
      managedCollections: [
        {
          name: 'stock',
          title: 'Stock',
          description: 'Externally authoritative stock.',
          schemaVersion: 1,
          schemaDigest: `sha256:${'a'.repeat(64)}`,
          recordSchema,
          source: {
            authority: 'external',
            connectorAlias: 'inventory',
            connectorId: 'inventory_api',
            connectorVersion: '1.0.0',
            scan: operation,
          },
        },
      ],
    },
    tools: [],
    capabilities: { tools: [] },
  };
}

function bindingFor(fixture: TenantFixture): SourceBindingRecord {
  return {
    scope: scopeFor(fixture),
    collectionKey: 'stock',
    id: 'stock',
    generation: 1,
    bindingReference: fixture.connectionId,
    configurationReference: 'configuration-1',
    schemaVersion: 1,
    schemaDigest: 'a'.repeat(64),
    queryFingerprint: 'd'.repeat(64),
    scan: {
      connector: 'inventory_api',
      connectorVersion: '1.0.0',
      operation: 'scan_stock',
      signatureDigest: signatureHash.replace(/^sha256v2:/, ''),
    },
    retentionDays: 30,
    pollIntervalMs: 60_000,
    state: 'active',
    health: 'initializing',
    completeness: 'incomplete',
    revision: 1,
    fence: 0,
    scanGeneration: 0,
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

describe('registry collection source executor', () => {
  it('admits the exact compiled managed-collection credential binding to the broker', () => {
    const fixture: TenantFixture = {
      org: 'acme',
      deploymentId: 'dep_equipment_acme',
      connectionId: 'acme_inventory_account',
      token: 'acme-downstream-token',
    };
    const connection = {
      id: fixture.connectionId,
      source: { kind: 'managedSecret' as const, secret: 'INVENTORY_TOKEN' },
    };
    const operation = operationFor(fixture);
    const boundOperation = {
      ...operation,
      credentialBinding: {
        ...operation.credentialBinding,
        connectionConfigRevision: computeConnectionConfigRevision(connection),
      },
    };
    const artifact = {
      ...artifactFor(boundOperation),
      connectorBindings: { inventory: { profile: 'account', connection } },
    };

    expect(buildCredentialBindingIndex(artifact).byKey.size).toBe(1);
  });

  it('uses the pinned source declaration with installed credentials, config and current generations', async () => {
    const installations = new InMemoryBusinessInformationStore();
    const fixtures: readonly TenantFixture[] = [
      {
        org: 'acme',
        deploymentId: 'dep_equipment_acme',
        connectionId: 'acme_inventory_account',
        token: 'acme-downstream-token',
      },
      {
        org: 'beta',
        deploymentId: 'dep_equipment_beta',
        connectionId: 'beta_inventory_account',
        token: 'beta-downstream-token',
      },
    ];
    for (const fixture of fixtures) {
      await installations.createInstallation({
        scope: scopeFor(fixture),
        definition: definitionFor(fixture),
        managedCollections: ['stock'],
        actorSubject: 'owner',
      });
    }
    const publisherFixture = fixtures[0];
    if (publisherFixture === undefined) throw new Error('publisher fixture missing');
    const secondInstallationId = 'equipment-prod-second';
    await installations.createInstallation({
      scope: scopeFor(publisherFixture, secondInstallationId),
      definition: definitionFor(publisherFixture),
      managedCollections: ['stock'],
      actorSubject: 'owner',
    });
    const crossOrgFixture: TenantFixture = {
      org: 'customer',
      deploymentId: publisherFixture.deploymentId,
      connectionId: publisherFixture.connectionId,
      token: publisherFixture.token,
    };
    await installations.createInstallation({
      scope: scopeFor(crossOrgFixture),
      definition: definitionFor(crossOrgFixture, 'acme'),
      managedCollections: ['stock'],
      actorSubject: 'owner',
    });

    const credentialRequests: CredentialRequest[] = [];
    let connectorFailureStatus: number | undefined;
    let connectorInvocations = 0;
    const installedTargets = new Map(
      fixtures.map((fixture) => {
        const operation = operationFor(fixture);
        return [
          fixture.deploymentId,
          {
            deploymentId: `installed-${fixture.deploymentId}`,
            org: fixture.org,
            app: 'equipment-installed',
            environment: 'prod',
            served: {
              artifact: artifactFor(operation),
              deps: {
                connectors: {
                  resolve: () => ({
                    id: 'inventory_api',
                    version: '1.0.0',
                    signature: () => scanSignature,
                    invoke: async ({ credential, env }: ConnectorCall) => {
                      connectorInvocations += 1;
                      expect(credential?.token).toBe(fixture.token);
                      expect(env).toEqual({ OPERATOR_SETTING: fixture.org });
                      if (connectorFailureStatus !== undefined) {
                        throw new ConnectorInvocationError('upstream rejected the credential', {
                          status: connectorFailureStatus,
                          category: connectorFailureStatus >= 500 ? 'upstream_5xx' : 'upstream_4xx',
                          retryable: connectorFailureStatus >= 500,
                        });
                      }
                      return {
                        records: [
                          { id: `${fixture.org}-sku-1`, record: { code: `${fixture.org}-SKU-1` } },
                        ],
                        deletedIds: [],
                        complete: true,
                      };
                    },
                  }),
                },
                broker: {
                  getCredential: async (request: CredentialRequest) => {
                    credentialRequests.push(request);
                    return { token: fixture.token };
                  },
                },
                tenantId: `${fixture.org}/equipment-installed/prod`,
                deploymentId: `installed-${fixture.deploymentId}`,
                env: { OPERATOR_SETTING: fixture.org },
              },
            },
          },
        ] as const;
      }),
    );
    const publisherBroker = vi.fn(() => {
      throw new Error('Publisher credentials must never be used');
    });
    const targets = new Map(
      fixtures.map((fixture) => {
        const installed = installedTargets.get(fixture.deploymentId);
        if (!installed) throw new Error('installed fixture missing');
        return [
          fixture.deploymentId,
          {
            ...installed,
            deploymentId: fixture.deploymentId,
            app: 'equipment',
            served: {
              ...installed.served,
              deps: {
                ...installed.served.deps,
                broker: { getCredential: publisherBroker },
                env: { PUBLISHER_SECRET_SETTING: 'never copied' },
                tenantId: `${fixture.org}/equipment/prod`,
                deploymentId: fixture.deploymentId,
              },
            },
          },
        ] as const;
      }),
    );
    const get = vi.fn((deploymentId: string) => Promise.resolve(targets.get(deploymentId)));
    const getActiveByTenant = vi.fn(async (scope: { org: string; app: string; env: string }) =>
      [...installedTargets.values()].find(
        (target) =>
          target.org === scope.org && target.app === scope.app && target.environment === scope.env,
      ),
    );
    const getAppArchivedAt = vi.fn(() => Promise.resolve<string | undefined>(undefined));
    const applicationGeneration = '2026-09-05T00:00:00.000Z';
    const getAppGeneration = vi.fn(() =>
      Promise.resolve<string | undefined>(applicationGeneration),
    );
    for (const fixture of fixtures) {
      for (const { scope } of await installations.listInstallations(fixture.org)) {
        expect(await installations.bindApplication(scope, applicationGeneration)).toBe(true);
      }
    }
    let connectionGeneration = 'connected-generation-1';
    const resolve = vi.fn<RuntimeTargetResolver>(async (target) => ({
      ...target,
      served: {
        ...target.served,
        deps: {
          ...target.served.deps,
          executionBinding: {
            revision: connectionGeneration,
            connections: Object.fromEntries(
              fixtures.map((fixture) => [fixture.connectionId, connectionGeneration]),
            ),
          },
        },
      },
    }));
    const executor = new RegistrySourceReadExecutor(
      { get, getActiveByTenant, getAppArchivedAt, getAppGeneration } as unknown as ServerRegistry,
      installations,
      resolve,
    );

    for (const fixture of fixtures) {
      await expect(
        executor.scan({
          binding: bindingFor(fixture),
          operation: bindingFor(fixture).scan,
          request: { mode: 'snapshot', limit: 100 },
        }),
      ).resolves.toEqual({
        records: [{ id: `${fixture.org}-sku-1`, record: { code: `${fixture.org}-SKU-1` } }],
        deletedIds: [],
        complete: true,
      });
    }

    const fencedBinding = {
      ...bindingFor(publisherFixture),
      credentialIdentity: { generation: connectionGeneration, account: 'opaque-account-digest' },
    };
    connectionGeneration = 'reconnected-generation';
    const beforeStaleScan = credentialRequests.length;
    await expect(
      executor.scan({
        binding: fencedBinding,
        operation: fencedBinding.scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_authorization_lost' });
    expect(credentialRequests).toHaveLength(beforeStaleScan);
    connectionGeneration = 'connected-generation-1';

    getAppGeneration.mockResolvedValueOnce('2026-09-06T00:00:00.000Z');
    await expect(
      executor.scan({
        binding: bindingFor(publisherFixture),
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_installation_unavailable' });
    const credentialCount = credentialRequests.length;
    await expect(
      executor.scan({
        binding: { ...bindingFor(publisherFixture), bindingReference: 'different-account' },
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_credential_binding_unavailable' });
    const secondInstallationBinding = {
      ...bindingFor(publisherFixture),
      scope: scopeFor(publisherFixture, secondInstallationId),
      bindingReference: 'second-installation-account',
    };
    await expect(
      executor.scan({
        binding: secondInstallationBinding,
        operation: secondInstallationBinding.scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_credential_binding_unavailable' });
    await expect(
      executor.scan({
        binding: { ...bindingFor(publisherFixture), configurationReference: 'configuration-2' },
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_credential_binding_unavailable' });
    await expect(
      executor.scan({
        binding: bindingFor(publisherFixture),
        operation: { ...bindingFor(publisherFixture).scan, signatureDigest: 'e'.repeat(64) },
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_operation_drift' });
    await expect(
      executor.scan({
        binding: { ...bindingFor(publisherFixture), collectionKey: 'undeclared' },
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_operation_unavailable' });
    await expect(
      executor.scan({
        binding: bindingFor(crossOrgFixture),
        operation: bindingFor(crossOrgFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_cross_org_binding_unavailable' });
    expect(credentialRequests).toHaveLength(credentialCount);

    expect(get).toHaveBeenCalledTimes(8);
    expect(get.mock.calls.every(([deploymentId]) => targets.has(deploymentId))).toBe(true);
    expect(credentialRequests).toHaveLength(2);
    for (const fixture of fixtures) {
      expect(credentialRequests).toContainEqual(
        expect.objectContaining({
          tenantId: `${fixture.org}/equipment-installed/prod`,
          deploymentId: `installed-${fixture.deploymentId}`,
          expectedConnectionGeneration: 'connected-generation-1',
          bindingId: 'inventory',
          connectionId: fixture.connectionId,
          profile: 'account',
          requiredScopes: ['inventory.read'],
        }),
      );
    }

    const scan = () =>
      executor.scan({
        binding: bindingFor(publisherFixture),
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      });
    const installed = installedTargets.get(publisherFixture.deploymentId);
    if (!installed) throw new Error('installed fixture missing');
    const deniedTargets: readonly (ServedTarget | undefined)[] = [
      undefined,
      { ...installed, app: 'other-app' },
      {
        ...installed,
        served: {
          ...installed.served,
          deps: {
            ...installed.served.deps,
            tenantId: 'acme/equipment/prod',
          },
        },
      },
    ];
    for (const value of deniedTargets) {
      resolve.mockResolvedValueOnce(value);
      await expect(scan()).rejects.toMatchObject({ code: 'source_installation_unavailable' });
    }
    getActiveByTenant.mockResolvedValueOnce(undefined);
    await expect(scan()).rejects.toMatchObject({ code: 'source_installation_unavailable' });
    const collection = installed.served.artifact.server.managedCollections?.[0];
    if (!collection) throw new Error('collection missing');
    const changedOperation = operationFor(publisherFixture);
    const changedArtifacts: RuntimeArtifact[] = [
      {
        ...installed.served.artifact,
        server: {
          ...installed.served.artifact.server,
          managedCollections: [{ ...collection, recordSchema: { ...recordSchema, required: [] } }],
        },
      },
      artifactFor({
        ...changedOperation,
        credentialBinding: {
          ...changedOperation.credentialBinding,
          connectionConfigRevision: 'configuration-changed',
        },
      }),
    ];
    for (const artifact of changedArtifacts) {
      resolve.mockResolvedValueOnce({ ...installed, served: { ...installed.served, artifact } });
      await expect(scan()).rejects.toMatchObject({ code: 'source_operation_drift' });
    }
    await expect(
      executor.scan({
        binding: { ...bindingFor(publisherFixture), schemaDigest: 'e'.repeat(64) },
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_schema_drift' });
    const publisher = targets.get(publisherFixture.deploymentId);
    if (!publisher) throw new Error('publisher fixture missing');
    get.mockResolvedValueOnce({
      ...publisher,
      served: {
        ...publisher.served,
        artifact: {
          ...publisher.served.artifact,
          server: { ...publisher.served.artifact.server, title: 'Changed' },
        },
      },
    });
    await expect(scan()).rejects.toMatchObject({ code: 'source_definition_drift' });
    expect(credentialRequests).toHaveLength(credentialCount);
    expect(publisherBroker).not.toHaveBeenCalled();
    connectionGeneration = 'connected-generation-2';
    await executor.scan({
      binding: bindingFor(publisherFixture),
      operation: bindingFor(publisherFixture).scan,
      request: { mode: 'snapshot', limit: 100 },
    });
    expect(credentialRequests.at(-1)?.expectedConnectionGeneration).toBe('connected-generation-2');

    let configChecks = 0;
    const configExecutor = new RegistrySourceReadExecutor(
      { get, getActiveByTenant, getAppArchivedAt, getAppGeneration } as unknown as ServerRegistry,
      installations,
      resolve,
      {
        withCurrent: async (_binding, work) =>
          work({
            configuration:
              configChecks++ === 0 ? 'original' : 'changed-during-credential-acquisition',
          }),
      },
    );
    const beforeConfigDrift = connectorInvocations;
    await expect(
      configExecutor.scan({
        binding: {
          ...bindingFor(publisherFixture),
          credentialIdentity: { configuration: 'original' },
        },
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_authorization_lost' });
    expect(configChecks).toBe(2);
    expect(connectorInvocations).toBe(beforeConfigDrift);

    getAppArchivedAt.mockResolvedValueOnce('2026-09-05T00:00:00.000Z');
    await expect(
      executor.scan({
        binding: bindingFor(publisherFixture),
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'source_app_archived' });

    for (const status of [401, 403]) {
      connectorFailureStatus = status;
      await expect(
        executor.scan({
          binding: bindingFor(publisherFixture),
          operation: bindingFor(publisherFixture).scan,
          request: { mode: 'snapshot', limit: 100 },
        }),
      ).rejects.toMatchObject({ code: 'source_authorization_lost' });
    }
    connectorFailureStatus = 503;
    await expect(
      executor.scan({
        binding: bindingFor(publisherFixture),
        operation: bindingFor(publisherFixture).scan,
        request: { mode: 'snapshot', limit: 100 },
      }),
    ).rejects.toMatchObject({ code: 'upstream_5xx' });
    const installation = await installations.getInstallation(scopeFor(publisherFixture));
    if (!installation) throw new Error('installation missing');
    await installations.setIntakeState({
      scope: installation.scope,
      expectedRevision: installation.revision,
      active: false,
      actorSubject: 'owner',
    });
    const beforePausedScan = credentialRequests.length;
    await expect(scan()).rejects.toMatchObject({ code: 'source_application_paused' });
    expect(credentialRequests).toHaveLength(beforePausedScan);
    expect(publisherBroker).not.toHaveBeenCalled();
  });
});
