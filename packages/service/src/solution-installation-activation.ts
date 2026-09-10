import { sha256Canonical } from '@noodle-borg/app-package';
import { publicSurfaceOf } from '@noodle-borg/assistant-gateway/portable';
import type { ControlPlaneIdentity } from '@noodle-borg/control-plane/portable';
import { ApplicationSettings, installationSettingsTarget } from './application-settings.js';
import type {
  BusinessInformationStore,
  SolutionInstallation,
} from './business-information/contracts.js';
import { privateDefinitionFromDeployment } from './business-information/definition-resolver.js';
import { managedSolutionManifest } from './business-information/managed-solution-executable.js';
import { BUSINESS_SETUP_MESSAGE, BusinessOnboarding } from './business-onboarding.js';
import {
  type AuthorizedDeploymentDependencies,
  type AuthorizedDeploymentInput,
  executeAuthorizedDeployment,
} from './deployment-execution.js';
import type { ServerRegistry } from './registry.js';
import { provisionPublicEmbed } from './routes/deploy-public-embed.js';

type ActivationDependencies = AuthorizedDeploymentDependencies & {
  readonly businessInformationStore?: BusinessInformationStore | undefined;
};
export type InstallationActivationState = 'pending' | 'ready' | 'unavailable';
export type InstallationActivationReader = (
  installation: SolutionInstallation,
) => Promise<InstallationActivationState>;

/** Deployment/binding readiness only; channel model, origin and connection checks remain separate. */
export async function readSolutionInstallationActivation(
  installation: SolutionInstallation,
  dependencies: ActivationDependencies,
): Promise<InstallationActivationState> {
  try {
    const { registry, businessInformationStore: store, options, controlPlane } = dependencies;
    const stored = await store?.getInstallation(installation.scope);
    if (!store || !stored) return 'unavailable';
    const { org, app } = stored.scope;
    const generation = await registry.getAppGeneration(org, app);
    if (
      (await registry.getAppArchivedAt(org, app)) !== undefined ||
      (stored.applicationGeneration !== 'pending' &&
        (!generation ||
          (stored.applicationGeneration !== undefined &&
            stored.applicationGeneration !== generation))) ||
      (options.businessOnboarding !== undefined &&
        !(await new BusinessOnboarding(options.businessOnboarding, controlPlane, store).ready(
          stored,
        )))
    )
      return 'unavailable';
    const target = await registry.getActiveByTenant(stored.scope);
    if (!target || stored.applicationGeneration === 'pending') return 'pending';
    if (publicSurfaceOf(target.served.artifact.server.assistant)) {
      if (!options.publicEmbeds) return 'unavailable';
      const embeds = await options.publicEmbeds.list(stored.scope, { includeRevoked: true });
      if (!embeds.some((embed) => embed.revokedAt === undefined))
        return embeds.length > 0 ? 'unavailable' : 'pending';
    }
    return 'ready';
  } catch {
    return 'unavailable';
  }
}

export interface SolutionInstallationActivationInput {
  readonly installation: SolutionInstallation;
  /** Routine executable refresh preserves independent channels; explicit activation checks all setup. */
  readonly purpose?: 'runtime-refresh';
  /** Authorized installing operator, or an explicit system release actor for managed refresh. */
  readonly actor: ControlPlaneIdentity;
}
export type SolutionInstallationActivationResult =
  | { readonly ok: true; readonly deploymentId: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };
export type SolutionInstallationActivator = (
  input: SolutionInstallationActivationInput,
) => Promise<SolutionInstallationActivationResult>;

/** Called after installation authorization, and by the managed-runtime refresh boundary. Never copies configuration. */
export async function activateSolutionInstallation(
  input: SolutionInstallationActivationInput,
  dependencies: ActivationDependencies,
): Promise<SolutionInstallationActivationResult> {
  const { installation, actor } = input;
  if (
    dependencies.options.businessOnboarding !== undefined &&
    (!dependencies.businessInformationStore ||
      !(await new BusinessOnboarding(
        dependencies.options.businessOnboarding,
        dependencies.controlPlane,
        dependencies.businessInformationStore,
      ).ready(installation)))
  ) {
    return reject(409, 'business_setup_required', BUSINESS_SETUP_MESSAGE);
  }
  const tenant = {
    org: installation.scope.org,
    app: installation.scope.app,
    env: installation.scope.env,
  };
  const store = dependencies.businessInformationStore;
  const stored = (await store?.getInstallation(installation.scope)) ?? installation;
  const generation = await dependencies.registry.getAppGeneration(tenant.org, tenant.app);
  if (
    (await dependencies.registry.getAppArchivedAt(tenant.org, tenant.app)) !== undefined ||
    (stored.applicationGeneration !== 'pending' &&
      (generation === undefined ||
        (stored.applicationGeneration !== undefined &&
          stored.applicationGeneration !== generation)))
  ) {
    return reject(
      409,
      'installation_application_unavailable',
      'Restore the original application before activation. Retained records remain accessible.',
    );
  }
  if (
    store &&
    stored.applicationGeneration !== 'pending' &&
    !(await store.bindApplication(installation.scope, generation ?? ''))
  ) {
    return reject(
      409,
      'installation_application_unavailable',
      'The retained installation requires application ownership recovery before activation.',
    );
  }
  const bind = async (
    deploymentId: string,
    reconcileEmbed: boolean,
  ): Promise<SolutionInstallationActivationResult> => {
    const currentGeneration = await dependencies.registry.getAppGeneration(tenant.org, tenant.app);
    if (
      store &&
      (!currentGeneration || !(await store.bindApplication(installation.scope, currentGeneration)))
    )
      return reject(
        409,
        'installation_application_unavailable',
        'Application activation was interrupted; retained records remain accessible.',
      );
    if ((installation.definition.variables?.length ?? 0) > 0)
      await new ApplicationSettings(dependencies.registry.configStore).initialize(
        installationSettingsTarget(installation),
      );
    const target = await dependencies.registry.get(deploymentId);
    if (
      input.purpose !== 'runtime-refresh' &&
      dependencies.options.publicEmbeds &&
      publicSurfaceOf(target?.served.artifact.server.assistant)
    ) {
      try {
        if (reconcileEmbed)
          await provisionPublicEmbed(
            dependencies.registry,
            dependencies.options,
            tenant,
            deploymentId,
            false,
          );
        const embeds = await dependencies.options.publicEmbeds.list(tenant, {
          includeRevoked: true,
        });
        if (!embeds.some((embed) => embed.revokedAt === undefined))
          return embeds.length > 0
            ? reject(
                409,
                'installation_embed_revoked',
                'The assistant was deliberately revoked. Use explicit channel recovery; activation does not replace revoked access.',
              )
            : reject(
                503,
                'installation_activation_incomplete',
                'The installation is saved. Retry activation to finish assistant setup.',
              );
      } catch {
        return reject(
          503,
          'installation_activation_incomplete',
          'The installation is saved. Retry activation when assistant setup is available.',
        );
      }
    }
    return { ok: true, deploymentId };
  };
  const source = await executableSource(installation, dependencies.registry);
  if (!source.ok) return source;
  const current = await dependencies.registry.getActiveByTenant(tenant);
  const declarations =
    current?.served.artifact.server.variables ?? installation.definition.variables ?? [];
  if (declarations.length > 0)
    await new ApplicationSettings(dependencies.registry.configStore).initialize({
      ...installationSettingsTarget(installation),
      declarations,
    });
  const accessMode = current?.accessMode ?? source.value.accessMode;
  const ownerSubject =
    accessMode === 'owner-only'
      ? (current?.ownerSubject ?? installation.createdBySubject)
      : undefined;
  const currentSource =
    current?.deploymentId === undefined
      ? undefined
      : await dependencies.registry.getDeploymentSource(tenant, current.deploymentId);
  if (
    current?.deploymentId !== undefined &&
    currentSource !== undefined &&
    currentSource.manifest === source.value.manifest &&
    currentSource.connectors === source.value.connectors &&
    JSON.stringify(currentSource.hostedAssets) === JSON.stringify(source.value.hostedAssets)
  ) {
    return bind(current.deploymentId, true);
  }
  const key = sha256Canonical({
    scope: installation.scope,
    definition: installation.definition.reference,
    executable: source.value,
    accessMode,
    ownerSubject: ownerSubject ?? null,
    orgMembershipSources: current?.orgMembershipSources ?? null,
    predecessor: current?.deploymentId ?? null,
  });
  const deployed = await executeAuthorizedDeployment(
    {
      ...source.value,
      tenant,
      identity: actor,
      accessMode,
      ...(ownerSubject === undefined ? {} : { ownerSubject }),
      ...(current?.orgMembershipSources === undefined
        ? {}
        : { orgMembershipSources: current.orgMembershipSources }),
      deploymentSource: 'api',
      allowRevokedEmbedReplacement: false,
      idempotencyKey: key,
    },
    dependencies,
  );
  if (!deployed.ok)
    return {
      ok: false,
      status: deployed.status,
      code:
        typeof deployed.body.code === 'string'
          ? deployed.body.code
          : 'installation_activation_failed',
      message:
        'The installation is saved, but its application could not be activated. Retry installation after resolving the deployment requirement.',
    };
  return bind(deployed.result.deploymentId, false);
}

type ExecutableSource = Pick<
  AuthorizedDeploymentInput,
  'manifest' | 'connectors' | 'hostedAssets' | 'accessMode' | 'serverVersion' | 'assetSourceScope'
>;
async function executableSource(
  installation: SolutionInstallation,
  registry: ServerRegistry,
): Promise<
  | { readonly ok: true; readonly value: ExecutableSource }
  | Extract<SolutionInstallationActivationResult, { ok: false }>
> {
  const reference = installation.definition.reference;
  if (reference.kind === 'managed') {
    return {
      ok: true,
      value: {
        manifest: JSON.stringify(managedSolutionManifest(installation.definition)),
        accessMode: 'public',
        serverVersion: '1',
      },
    };
  }
  if (reference.kind !== 'private')
    return reject(
      409,
      'definition_unavailable',
      'This historical definition has no executable application.',
    );
  if (reference.publisherOrg !== installation.scope.org)
    return reject(
      403,
      'definition_forbidden',
      'Private definitions must belong to the installation organization.',
    );
  const sourceScope = { org: reference.publisherOrg, app: reference.app, env: reference.env };
  const source = await registry.getDeploymentSource(sourceScope, reference.deploymentId);
  if (source === undefined)
    return reject(
      409,
      'definition_unavailable',
      'The immutable source deployment is unavailable or archived.',
    );
  const target = await registry.get(reference.deploymentId);
  if (target === undefined)
    return reject(
      409,
      'definition_unavailable',
      'The immutable source deployment cannot be loaded.',
    );
  const verified = privateDefinitionFromDeployment(
    {
      publisherOrg: reference.publisherOrg,
      app: reference.app,
      environment: reference.env,
      deploymentId: reference.deploymentId,
    },
    {
      ...sourceScope,
      environment: sourceScope.env,
      deploymentId: reference.deploymentId,
      artifact: target.served.artifact,
    },
  );
  if (verified.reference.digest !== reference.digest)
    return reject(
      409,
      'definition_changed',
      'The installation definition does not match its immutable source deployment.',
    );
  return {
    ok: true,
    value: {
      ...source,
      accessMode: source.accessMode ?? 'public',
      serverVersion: source.serverVersion ?? '1',
      assetSourceScope: sourceScope,
    },
  };
}
function reject(
  status: number,
  code: string,
  message: string,
): Extract<SolutionInstallationActivationResult, { ok: false }> {
  return { ok: false, status, code, message };
}
