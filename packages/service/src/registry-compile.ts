import type { AppPackageArtifactV1 } from '@noodle-borg/app-package';
import { publicSurfaceDelegatedAuthErrors } from '@noodle-borg/assistant-gateway/portable';
import type { CapabilityName } from '@noodle-borg/capabilities';
import {
  type CatalogConnector,
  compile,
  type HostedPackagedAsset,
  InMemoryCatalog,
  type LocalAssetOptions,
  type PackagedAsset,
  RECORD_CONNECTOR_ID,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import {
  compileConnectors,
  delegatedTokenExchangeIdentityErrors,
  type SecretBinding,
} from '@noodle-borg/connector-defs';
import type { KnowledgeSearchPortFactory } from '@noodle-borg/knowledge-operations/portable';
import type { PolicyGate } from '@noodle-borg/module';
import type { ServedArtifact } from '@noodle-borg/protocol';
import {
  type Connector,
  InMemoryConnectorRegistry,
  resolveManagedOrigins,
  resolveVariableEnvironment,
} from '@noodle-borg/runtime';
import type { OwnerTokenVerifier, ServedTarget } from '@noodle-borg/transport-http';
import {
  type AppPackageRenderer,
  AppPackageSnapshotError,
  type AppPackageSnapshotV1,
  createAppPackageSnapshot,
} from './app-package-snapshot.js';
import { missingServerConfigErrors } from './assistant-bindings.js';
import { normalizePersistedConnectorsForCompile } from './connector-normalize.js';
import { ManagedConfigBroker } from './credential-broker.js';
import { deploymentCredentialBrokerOptions } from './credential-broker-options.js';
import { deploymentRecordVersionError } from './deployment-record-version.js';
import { normalizePersistedManifestForCompile } from './manifest-normalize.js';
import type { NativeRecordConnectorFactory } from './native-record-connector.js';
import type { OAuthStore } from './oauth/store.js';
import {
  missingCapabilityErrors,
  missingSecretErrors,
  missingVariableErrors,
} from './registry-helpers.js';
import type { RegistryStateView } from './registry-state.js';
import { servedTargetFor } from './registry-targets.js';
import type { DeployError, ServerRegistryOptions } from './registry-types.js';
import {
  createDeploymentStateConnector,
  type StateHandleStoreFactory,
} from './state-connector-factory.js';
import type { DeployRecord, TenantAuthConfig } from './store.js';
import {
  type ConfigStore,
  resolveConfigScope,
  type SecretEnvelope,
  type TenantRef,
} from './store.js';

interface RegistryCompileContext {
  readonly activeArtifact: () => Promise<RuntimeArtifact | undefined>;
  readonly configStore: ConfigStore;
  readonly platformCatalog: readonly CatalogConnector[];
  readonly localAssetOptions: LocalAssetOptions | undefined;
  readonly localAssetsByPath: Map<string, PackagedAsset>;
  readonly delegatedCredentialStore:
    | Pick<OAuthStore, 'getDelegatedCredential' | 'putDelegatedCredential'>
    | undefined;
  readonly sealCustomerCredential: ((credential: string) => Promise<SecretEnvelope>) | undefined;
  readonly openCustomerCredential: ((credential: SecretEnvelope) => Promise<string>) | undefined;
  readonly delegatedExchange: ServerRegistryOptions['delegatedExchange'];
  readonly localDevtoolsDelegatedExchange: ServerRegistryOptions['localDevtoolsDelegatedExchange'];
  readonly externalCredentialExchange: ServerRegistryOptions['externalCredentialExchange'];
  readonly googleWorkloadIdentity: ServerRegistryOptions['googleWorkloadIdentity'];
  readonly stateHandleStoreFactory: StateHandleStoreFactory | undefined;
  readonly platformConnectors: readonly Connector[];
  readonly nativeRecords: NativeRecordConnectorFactory | undefined;
  readonly policyGate: PolicyGate | undefined;
  readonly appPackageRenderer: AppPackageRenderer | undefined;
  readonly knowledgeSearch: KnowledgeSearchPortFactory | undefined;
}

export interface RegistryCompileInput {
  readonly tenant: TenantRef;
  readonly manifest: string;
  readonly connectors: string | undefined;
  readonly hostedAssets?: readonly HostedPackagedAsset[] | undefined;
  readonly deploymentId?: string | undefined;
  readonly renderAppPackage: boolean;
}

export type RegistryCompileResult =
  | {
      readonly ok: true;
      readonly served: ServedArtifact;
      readonly bindDeployment: (deploymentId: string) => ServedArtifact;
      readonly appPackageArtifact?: AppPackageArtifactV1;
      readonly appPackageSnapshot?: AppPackageSnapshotV1;
    }
  | {
      readonly ok: false;
      readonly errors: readonly DeployError[];
      /** Structurally compiled input for independent checks, never a ready-to-serve artifact. */
      readonly compiledArtifact?: RuntimeArtifact;
    };

/** Reject unsupported persisted semantics before constructing executable runtime dependencies. */
export async function compilePersistedRegistryRecord(
  record: DeployRecord,
  compileTarget: (
    tenant: TenantRef,
    manifest: string,
    connectors: string | undefined,
    assets: readonly HostedPackagedAsset[] | undefined,
    renderAppPackage: boolean,
    deploymentId: string,
  ) => Promise<RegistryCompileResult>,
): Promise<RegistryCompileResult> {
  const versionError = deploymentRecordVersionError(record);
  if (versionError !== undefined) return { ok: false, errors: [versionError] };
  return compileTarget(
    { org: record.orgSlug, app: record.appSlug, env: record.environment },
    record.manifest,
    record.connectors === undefined
      ? undefined
      : normalizePersistedConnectorsForCompile(record.connectors),
    record.hostedAssets,
    false,
    record.deploymentId,
  );
}

export async function compileRegistryTarget(
  context: RegistryCompileContext,
  input: RegistryCompileInput,
): Promise<RegistryCompileResult> {
  const { tenant, manifest, connectors, hostedAssets, deploymentId } = input;
  let catalogConnectors: CatalogConnector[] = [];
  let httpConnectors: Connector[] = [];
  let secretBindings: SecretBinding[] = [];
  let variableBindings: readonly string[] = [];
  if (connectors !== undefined && connectors.trim() !== '') {
    const cc = compileConnectors(connectors);
    if (!cc.ok) return { ok: false, errors: cc.errors };
    if (cc.catalog.some((entry) => entry.id === RECORD_CONNECTOR_ID))
      return {
        ok: false,
        errors: [
          {
            code: 'reserved_connector',
            path: 'connectors',
            message:
              'The native record connector is platform-owned and cannot be supplied by an application.',
          },
        ],
      };
    catalogConnectors = cc.catalog;
    httpConnectors = cc.connectors;
    secretBindings = cc.secretBindings;
    variableBindings = cc.variableBindings;
  }
  const scope = resolveConfigScope({
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
  });
  const compiled = compile(normalizePersistedManifestForCompile(manifest), {
    catalog: new InMemoryCatalog([...context.platformCatalog, ...catalogConnectors]),
    ...(hostedAssets !== undefined && hostedAssets.length > 0
      ? { hostedAssets: { assets: hostedAssets } }
      : context.localAssetOptions !== undefined
        ? { localAssets: context.localAssetOptions }
        : {}),
  });
  const identityErrors = compiled.ok
    ? delegatedTokenExchangeIdentityErrors(secretBindings, compiled.artifact.server, {
        ...(context.localDevtoolsDelegatedExchange === undefined
          ? {}
          : { localDevtoolsCustomerIdentity: true }),
      })
    : [];
  // A delegated-auth tool on a pure public surface inevitably fails; reject it while the author can fix it.
  const projectionErrors = compiled.ok
    ? publicSurfaceDelegatedAuthErrors(compiled.artifact, secretBindings)
    : [];
  const resolvedSecrets = await context.configStore.resolveConfigValues('secret', scope);
  const resolvedVariables = await context.configStore.resolveConfigValues('variable', scope);
  const businessVariables = new Set(
    compiled.ok
      ? compiled.artifact.server.variables
          ?.filter((declaration) => declaration.portal !== undefined)
          .map((declaration) => declaration.name)
      : [],
  );
  const connectorConfigErrors = [
    ...missingSecretErrors(secretBindings, resolvedSecrets),
    ...missingVariableErrors(
      variableBindings.filter((name) => !businessVariables.has(name)),
      resolvedVariables,
    ),
  ];
  if (!compiled.ok) {
    return { ok: false, errors: [...connectorConfigErrors, ...compiled.errors] };
  }
  const missingServerConfig = missingServerConfigErrors(
    compiled.artifact,
    resolvedSecrets,
    resolvedVariables,
  ).filter(
    (error) =>
      error.code !== 'missing_variable' ||
      !businessVariables.has(error.path.replace(/^variables\./, '')),
  );
  const errors = [
    ...identityErrors,
    ...projectionErrors,
    ...connectorConfigErrors,
    ...missingServerConfig,
  ];
  const settings = resolveVariableEnvironment(
    compiled.artifact.server.variables ?? [],
    resolvedVariables,
  );
  if (!settings.ok) errors.push({ ...settings.error, path: 'server.variables' });
  if (settings.ok && deploymentId === undefined && settings.missing.length > 0) {
    const previous = await context.activeArtifact();
    if (previous !== undefined) {
      const previouslyMissing = resolveVariableEnvironment(
        previous.server.variables ?? [],
        resolvedVariables,
      );
      for (const declaration of compiled.artifact.server.variables ?? []) {
        if (!settings.missing.includes(declaration.name)) continue;
        const old = previous.server.variables?.find((entry) => entry.name === declaration.name);
        if (
          declaration.requiredFor.some(
            (tool) =>
              previous.tools.some((entry) => entry.name === tool) &&
              !(
                previouslyMissing.ok &&
                previouslyMissing.missing.includes(declaration.name) &&
                old?.requiredFor.includes(tool)
              ),
          )
        )
          errors.push({
            code: 'configuration_required',
            path: `variables.${declaration.name}`,
            message: 'Configure the new requirement before updating an existing capability.',
          });
      }
    }
  }
  const originResolution = resolveManagedOrigins(compiled.artifact, resolvedVariables, {
    allowUnconfiguredPortal: true,
  });
  if (!originResolution.ok) {
    const missingVariables = new Set(
      errors.filter((error) => error.code === 'missing_variable').map((error) => error.path),
    );
    errors.push(
      ...originResolution.errors
        // An unset binding is already actionable config, not an independent invalid-origin fault.
        .filter(
          (error) =>
            error.reason !== 'missing' || !missingVariables.has(`variables.${error.variableName}`),
        )
        .map(({ code, path, message }) => ({ code, path, message })),
    );
  }
  let appPackageSnapshot: AppPackageSnapshotV1 | undefined;
  if (input.renderAppPackage && compiled.appPackage !== undefined) {
    try {
      appPackageSnapshot = createAppPackageSnapshot(
        compiled.appPackage,
        context.appPackageRenderer,
      );
    } catch (error) {
      if (error instanceof AppPackageSnapshotError) {
        errors.push(error.deployError);
      } else {
        throw error;
      }
    }
  }
  if (errors.length > 0 || !originResolution.ok) {
    return { ok: false, errors, compiledArtifact: compiled.artifact };
  }
  // Keep declarations reusable; serving binds live operator settings once for each request.
  const artifact = compiled.artifact;
  const localAuthority =
    context.delegatedExchange === undefined &&
    secretBindings.some((binding) => binding.authKind === 'delegatedTokenExchange')
      ? await context.localDevtoolsDelegatedExchange?.resolve()
      : undefined;
  const delegatedExchange =
    context.delegatedExchange ??
    (localAuthority === undefined
      ? undefined
      : {
          ...localAuthority,
          localDevtools: true as const,
          ...(context.localDevtoolsDelegatedExchange?.onAttempt === undefined
            ? {}
            : { onAttempt: context.localDevtoolsDelegatedExchange.onAttempt }),
          ...(context.localDevtoolsDelegatedExchange?.onSuccess === undefined
            ? {}
            : { onSuccess: context.localDevtoolsDelegatedExchange.onSuccess }),
        });
  if (context.localAssetOptions !== undefined) {
    context.localAssetsByPath.clear();
    for (const asset of compiled.localAssets ?? []) {
      context.localAssetsByPath.set(new URL(asset.publicUrl).pathname, asset);
    }
  }
  const bindDeployment = (boundDeploymentId?: string): ServedArtifact => {
    const broker = new ManagedConfigBroker(secretBindings, context.configStore, scope, {
      artifact,
      ...(context.delegatedCredentialStore !== undefined
        ? { delegatedCredentialStore: context.delegatedCredentialStore }
        : {}),
      ...(artifact.server.auth !== undefined ? { serverAuth: artifact.server.auth } : {}),
      ...(context.sealCustomerCredential !== undefined
        ? { sealCustomerCredential: context.sealCustomerCredential }
        : {}),
      ...(context.openCustomerCredential !== undefined
        ? { openCustomerCredential: context.openCustomerCredential }
        : {}),
      ...deploymentCredentialBrokerOptions({
        delegatedExchange,
        externalCredentialExchange: context.externalCredentialExchange,
        googleWorkloadIdentity: context.googleWorkloadIdentity,
        tenant: `${tenant.org}/${tenant.app}/${tenant.env}`,
        deploymentId: boundDeploymentId,
      }),
    });
    const stateConnector = createDeploymentStateConnector(
      artifact.server.state,
      boundDeploymentId,
      context.stateHandleStoreFactory,
    );
    const nativeRecords = context.nativeRecords?.({
      tenant,
      artifact,
      ...(boundDeploymentId === undefined ? {} : { deploymentId: boundDeploymentId }),
    });
    return {
      artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([
          ...context.platformConnectors,
          ...(nativeRecords === undefined ? [] : [nativeRecords]),
          ...(stateConnector !== undefined ? [stateConnector] : []),
          ...httpConnectors,
        ]),
        broker,
        tenantId: `${tenant.org}/${tenant.app}/${tenant.env}`,
        ...(boundDeploymentId !== undefined ? { deploymentId: boundDeploymentId } : {}),
        env: () =>
          context.configStore.transactConfig === undefined
            ? context.configStore.resolveConfigValues('variable', scope)
            : context.configStore.transactConfig(scope.org, (transaction) =>
                transaction.resolveConfigValues('variable', scope),
              ),
        ...(context.policyGate !== undefined ? { policy: context.policyGate } : {}),
        ...(context.knowledgeSearch !== undefined && (artifact.server.knowledge?.length ?? 0) > 0
          ? {
              knowledgeSearch: context.knowledgeSearch(tenant, artifact.server.knowledge ?? []),
            }
          : {}),
      },
    };
  };
  return {
    ok: true,
    served: bindDeployment(deploymentId),
    bindDeployment,
    ...(compiled.appPackage !== undefined ? { appPackageArtifact: compiled.appPackage } : {}),
    ...(appPackageSnapshot !== undefined ? { appPackageSnapshot } : {}),
  };
}

/** Load and validate persisted semantics before publishing an executable target to caches. */
export async function loadPersistedRegistryTarget(
  source: string | DeployRecord,
  context: {
    readonly state: RegistryStateView;
    readonly compile: (record: DeployRecord) => Promise<RegistryCompileResult>;
    readonly capabilities: readonly CapabilityName[];
    readonly customerVerifierFactory: ((auth: TenantAuthConfig) => OwnerTokenVerifier) | undefined;
    readonly hasCustomerAuthConflict: (
      record: DeployRecord,
      auth: TenantAuthConfig | undefined,
    ) => Promise<boolean>;
  },
): Promise<ServedTarget | undefined> {
  const { state } = context;
  const record =
    typeof source === 'string'
      ? state.store
        ? await state.store.get(source)
        : state.records.get(source)
      : source;
  if (
    !record ||
    record.archivedAt !== undefined ||
    deploymentRecordVersionError(record) !== undefined
  )
    return undefined;
  const deploymentId = record.deploymentId;
  const built = await context.compile(record);
  if (!built.ok) {
    throw new Error(
      `deployment ${deploymentId} failed to recompile (${built.errors.map((e) => e.code).join(',')})`,
    );
  }
  const missingCapabilities = missingCapabilityErrors(
    built.served.artifact.requirements?.capabilities ?? [],
    context.capabilities,
  );
  if (missingCapabilities.length > 0) {
    throw new Error(
      `deployment ${deploymentId} failed capability requirements (${missingCapabilities.map((e) => e.path).join(',')})`,
    );
  }
  if (
    record.active &&
    (await context.hasCustomerAuthConflict(record, built.served.artifact.server.auth))
  )
    return undefined;
  const target = servedTargetFor(record, built.served, context.customerVerifierFactory);
  state.servers.set(deploymentId, target);
  state.records.set(deploymentId, record);
  return target;
}
