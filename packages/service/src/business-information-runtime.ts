import type { DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { resolveApplicationRuntimeTarget } from './application-runtime-target.js';
import {
  InMemoryBusinessInformationStore,
  InMemorySourceIngestionStore,
  privateDefinitionFromDeployment,
  RegistrySourceReadExecutor,
  SourceIngestionCoordinator,
  validateManagedPayload,
} from './business-information/portable.js';
import { fenceSourceStore } from './business-information/source-credential-fence.js';
import { createDeploymentNativeRecordConnector } from './native-record-connector.js';
import type { ServiceOptions } from './options.js';
import type { ServerRegistry } from './registry.js';
import { sourceConfigurationAuthority } from './source-configuration-authority.js';

/** Compose generic business information ports without introducing application-specific records. */
export function createBusinessInformationRuntime(
  registry: ServerRegistry,
  options: ServiceOptions,
  publicCounters: DailyCounterStore,
) {
  const businessInformationStore =
    options.businessInformationStore ??
    (options.businessInformationEnabled === false
      ? undefined
      : new InMemoryBusinessInformationStore());
  if (businessInformationStore)
    registry.setApplicationLifecycleObserver((org, app, at, retired) =>
      businessInformationStore.pauseApplication(org, app, at, retired),
    );
  if (businessInformationStore instanceof InMemoryBusinessInformationStore) {
    businessInformationStore.configureApplicationLifecycle(async (scope) => {
      const generation = await registry.getAppGeneration(scope.org, scope.app);
      if (!generation) return undefined;
      return {
        generation,
        active:
          (await registry.getAppArchivedAt(scope.org, scope.app)) === undefined &&
          (await registry.getActiveByTenant(scope)) !== undefined,
      };
    });
  }
  const sourceStore =
    options.businessInformationSourceStore ??
    (businessInformationStore === undefined
      ? undefined
      : new InMemorySourceIngestionStore({
          identityKey: 'local-business-source-identity-key-v1',
          ...(options.clock === undefined ? {} : { now: options.clock }),
        }));
  const sourceAuthority = sourceConfigurationAuthority(
    () => registry,
    options.connectionRuntime?.sourceCredentials,
  );
  const businessInformationSourceStore = sourceStore
    ? fenceSourceStore(sourceStore, sourceAuthority)
    : undefined;
  const businessInformationSourceExecutor =
    options.businessInformationSourceExecutor ??
    (businessInformationStore === undefined
      ? undefined
      : new RegistrySourceReadExecutor(
          registry,
          businessInformationStore,
          (target) =>
            resolveApplicationRuntimeTarget(
              target,
              undefined,
              options.connectionRuntime?.readGenerations,
            ),
          sourceAuthority,
        ));
  const sourceCoordinator =
    businessInformationSourceStore === undefined || businessInformationSourceExecutor === undefined
      ? undefined
      : new SourceIngestionCoordinator({
          store: businessInformationSourceStore,
          executor: businessInformationSourceExecutor,
          workerId: 'service-refresh',
          validateRecord: (_binding, value) => validateManagedPayload(value),
          ...(options.clock === undefined ? {} : { now: options.clock }),
        });
  registry.setPlatformConnectors({
    ...(businessInformationStore === undefined
      ? {}
      : {
          nativeRecords: (input) =>
            createDeploymentNativeRecordConnector(input, {
              store: businessInformationStore,
              counters: publicCounters,
              publicIntakeEnabled: options.businessInformationPublicIntakeEnabled !== false,
              ...(options.clock === undefined ? {} : { now: options.clock }),
            }),
        }),
  });
  return { businessInformationStore, businessInformationSourceStore, sourceCoordinator };
}

/** Resolve immutable same-organization private definition bytes; publisher configuration stays private. */
export async function resolvePrivateInstallationDefinition(
  registry: ServerRegistry,
  selector: import('./business-information/definition-resolver.js').PrivateDefinitionSelector,
) {
  const source = await registry.getDeploymentSource(
    { org: selector.publisherOrg, app: selector.app, env: selector.environment },
    selector.deploymentId,
  );
  if (!source) return undefined;
  const target = await registry.get(selector.deploymentId);
  if (!target) return undefined;
  return privateDefinitionFromDeployment(selector, {
    deploymentId: selector.deploymentId,
    org: selector.publisherOrg,
    app: selector.app,
    environment: selector.environment,
    artifact: target.served.artifact,
  });
}
