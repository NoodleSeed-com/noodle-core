import { sha256Canonical } from '@noodle-borg/app-package';
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

export interface SolutionInstallationActivationInput {
  readonly installation: SolutionInstallation;
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
  dependencies: AuthorizedDeploymentDependencies & {
    readonly businessInformationStore?: BusinessInformationStore | undefined;
  },
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
  const bind = async (deploymentId: string): Promise<SolutionInstallationActivationResult> => {
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
    return bind(current.deploymentId);
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
  return bind(deployed.result.deploymentId);
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
