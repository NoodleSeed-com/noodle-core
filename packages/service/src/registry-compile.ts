import type { AppPackageArtifactV1 } from '@noodle-borg/app-package';
import { publicSurfaceDelegatedAuthErrors } from '@noodle-borg/assistant-gateway/portable';
import {
  type CatalogConnector,
  compile,
  type HostedPackagedAsset,
  InMemoryCatalog,
  type LocalAssetOptions,
  type PackagedAsset,
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
} from '@noodle-borg/runtime';
import {
  type AppPackageRenderer,
  AppPackageSnapshotError,
  type AppPackageSnapshotV1,
  createAppPackageSnapshot,
} from './app-package-snapshot.js';
import { missingServerConfigErrors } from './assistant-bindings.js';
import { ManagedConfigBroker } from './credential-broker.js';
import { deploymentCredentialBrokerOptions } from './credential-broker-options.js';
import { normalizePersistedManifestForCompile } from './manifest-normalize.js';
import type { OAuthStore } from './oauth/store.js';
import { missingSecretErrors, missingVariableErrors } from './registry-helpers.js';
import type { DeployError, ServerRegistryOptions } from './registry-types.js';
import {
  createDeploymentStateConnector,
  type StateHandleStoreFactory,
} from './state-connector-factory.js';
import {
  type ConfigStore,
  resolveConfigScope,
  type SecretEnvelope,
  type TenantRef,
} from './store.js';

interface RegistryCompileContext {
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
  const [resolvedSecrets, resolvedVariables] = await Promise.all([
    context.configStore.resolveConfigValues('secret', scope),
    context.configStore.resolveConfigValues('variable', scope),
  ]);
  const connectorConfigErrors = [
    ...missingSecretErrors(secretBindings, resolvedSecrets),
    ...missingVariableErrors(variableBindings, resolvedVariables),
  ];
  if (!compiled.ok) {
    return { ok: false, errors: [...connectorConfigErrors, ...compiled.errors] };
  }
  const missingServerConfig = missingServerConfigErrors(
    compiled.artifact,
    resolvedSecrets,
    resolvedVariables,
  );
  const errors = [
    ...identityErrors,
    ...projectionErrors,
    ...connectorConfigErrors,
    ...missingServerConfig,
  ];
  const originResolution = resolveManagedOrigins(compiled.artifact, resolvedVariables);
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
  const artifact = originResolution.artifact;
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
    return {
      artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([
          ...context.platformConnectors,
          ...(stateConnector !== undefined ? [stateConnector] : []),
          ...httpConnectors,
        ]),
        broker,
        tenantId: `${tenant.org}/${tenant.app}/${tenant.env}`,
        ...(boundDeploymentId !== undefined ? { deploymentId: boundDeploymentId } : {}),
        env: () => context.configStore.resolveConfigValues('variable', scope),
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
