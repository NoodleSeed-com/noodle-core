import { sha256Canonical } from '@noodle-borg/compiler';
import { resolveManagedOrigins } from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import {
  type ApplicationRuntimeTarget,
  projectApplicationBusinessNotice,
} from './application-business-notice.js';
import type { SolutionInstallationStore } from './business-information/contracts.js';
import { BusinessOnboarding } from './business-onboarding.js';
import {
  activateSolutionInstallation,
  type SolutionInstallationActivator,
} from './solution-installation-activation.js';

export type RuntimeTargetResolver = (
  target: ServedTarget,
) => Promise<ApplicationRuntimeTarget | undefined>;

/** Resolve operator-owned origins from one current configuration snapshot, never a deployment cache. */
export async function resolveTargetOrigins(
  target: ServedTarget,
): Promise<ApplicationRuntimeTarget | undefined> {
  const env = target.served.deps.env;
  const variables = typeof env === 'function' ? await env() : (env ?? {});
  const resolved = resolveManagedOrigins(target.served.artifact, variables, {
    allowUnconfiguredPortal: true,
  });
  if (!resolved.ok) return undefined;
  return {
    ...target,
    served: {
      ...target.served,
      artifact: resolved.artifact,
      deps: {
        ...target.served.deps,
        env: variables,
        executionBinding: {
          revision: sha256Canonical({ deployment: target.deploymentId ?? null, variables }),
          connections: {},
        },
      },
    },
  };
}

/** One live installation switch gates every application data-plane channel, including old sessions. */
export async function resolveApplicationRuntimeTarget(
  target: ApplicationRuntimeTarget,
  installations?: Pick<SolutionInstallationStore, 'listInstallations'> &
    Partial<import('./business-information/business-notice.js').BusinessNoticeStore>,
  readConnections?: (target: ServedTarget) => Promise<Readonly<Record<string, string>>>,
): Promise<ApplicationRuntimeTarget | undefined> {
  let notice: import('./business-information/business-notice.js').BusinessNoticeRecord | undefined;
  if (installations && target.org && target.app && target.environment) {
    const installationsInOrg = await installations.listInstallations(target.org);
    const matching = installationsInOrg.filter(
      (installation) =>
        installation.scope.app === target.app && installation.scope.env === target.environment,
    );
    if (matching.length > 1) return undefined;
    if (
      installationsInOrg.some(
        (installation) =>
          installation.scope.app === target.app &&
          installation.scope.env === target.environment &&
          !installation.intakeActive,
      )
    )
      return undefined;
    if (matching[0]) notice = await installations.getBusinessNotice?.(matching[0].scope);
  }
  const configured = await resolveTargetOrigins(target);
  const resolved =
    configured && notice ? projectApplicationBusinessNotice(configured, notice) : configured;
  if (!resolved || !readConnections) return resolved;
  const connections = await readConnections(resolved);
  return {
    ...resolved,
    served: {
      ...resolved.served,
      deps: {
        ...resolved.served.deps,
        executionBinding: {
          revision: sha256Canonical({
            config: resolved.served.deps.executionBinding?.revision,
            connections,
          }),
          connections: Object.freeze({ ...connections }),
        },
      },
    },
  };
}

/** Managed definitions update existing executable installations through the same deployment core. */
export function applicationServingResolver(input: {
  readonly registry: import('./registry.js').ServerRegistry;
  readonly installations:
    | import('./business-information/contracts.js').BusinessInformationStore
    | undefined;
  readonly connections: import('./connections/types.js').ApplicationConnections | undefined;
  readonly activity: import('./application-activity.js').ApplicationActivity | undefined;
  readonly activate: import('./solution-installation-activation.js').SolutionInstallationActivator;
  readonly businessOnboarding?: import('./business-onboarding.js').BusinessOnboarding;
}): RuntimeTargetResolver {
  return async (initial) => {
    let target = initial;
    if (input.installations && target.org && target.app && target.environment) {
      const matches = (await input.installations.listInstallations(target.org)).filter(
        (entry) => entry.scope.app === target.app && entry.scope.env === target.environment,
      );
      if (matches.length > 1) return undefined;
      const installation = matches[0];
      if (
        installation &&
        input.businessOnboarding &&
        !(await input.businessOnboarding.ready(installation))
      )
        return undefined;
      if (installation && !installation.intakeActive) return undefined;
      if (
        installation &&
        (installation.definition.reference.kind === 'managed' ||
          installation.applicationGeneration === undefined ||
          installation.applicationGeneration === 'pending')
      ) {
        const activated = await input.activate({
          installation,
          actor: { subject: 'noodle:managed-solution-release', email: '', superAdmin: false },
        });
        if (!activated.ok) return undefined;
        if (activated.deploymentId !== target.deploymentId) {
          const current = await input.registry.getServing(activated.deploymentId);
          if (!current) return undefined;
          target = current;
        }
      }
      if (installation) {
        const bound = await input.installations.getInstallation(installation.scope);
        const generation = await input.registry.getAppGeneration(
          installation.scope.org,
          installation.scope.app,
        );
        if (!bound?.intakeActive || !generation || bound.applicationGeneration !== generation)
          return undefined;
      }
    }
    const resolved = await resolveApplicationRuntimeTarget(
      target,
      input.installations,
      input.connections?.readGenerations,
    );
    return resolved && input.activity && input.installations
      ? input.activity.bind(resolved, {
          installations: input.installations,
          registry: input.registry,
          ...(input.connections === undefined ? {} : { connections: input.connections }),
        })
      : resolved;
  };
}

/** Compose installation activation and live serving with one deployment-owned onboarding policy. */
export function createApplicationServingRuntime(
  registry: import('./registry.js').ServerRegistry,
  providerOptions: import('./options.js').ServiceOptions,
  controlPlane: import('./store.js').ControlPlaneStore,
  audit: import('./store/audit.js').AuditSink,
  activity: import('./application-activity.js').ApplicationActivity | undefined,
) {
  const options = providerOptions;
  const businessInformationStore = options.businessInformationStore;
  const businessOnboarding =
    options.businessOnboarding !== undefined && businessInformationStore
      ? new BusinessOnboarding(options.businessOnboarding, controlPlane, businessInformationStore)
      : undefined;
  const activateInstallation: SolutionInstallationActivator = (input) =>
    activateSolutionInstallation(input, {
      registry,
      businessInformationStore,
      options: providerOptions,
      controlPlane,
      audit,
    });
  const resolveRuntimeTarget = applicationServingResolver({
    registry,
    installations: businessInformationStore,
    connections: options.connectionRuntime,
    activity,
    activate: activateInstallation,
    ...(businessOnboarding ? { businessOnboarding } : {}),
  });
  return { activateInstallation, resolveRuntimeTarget, businessOnboarding };
}
