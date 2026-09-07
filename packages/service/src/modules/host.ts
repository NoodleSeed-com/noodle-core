import { CAPABILITY_NAMES, type CapabilityName } from '@noodle-borg/capabilities';
import type {
  AdmissionDecision,
  AdmissionGate,
  AssetStore,
  AuditSink,
  AuditStore,
  DataPlaneIdentityAuthorizer,
  DeploymentAutomationAuthorizer,
  HostedToolDispatchHook,
  ModuleRoute,
  NamedDeploymentActivationHook,
  OrganizationProvisioningHook,
  OwnerTokenVerifier,
  PlatformHumanIdentityContribution,
  PolicyGate,
  ReadinessProbe,
  ResolveActivityHistoryAllowance,
} from '@noodle-borg/module';
import { DEPLOYMENT_ACTIVATION_PHASE } from '@noodle-borg/module';
import type { LoadedServiceModule } from '@noodle-borg/service-modules';
import type { ServiceOptions } from '../options.js';
import { InMemoryAuditStore, MultiSink } from '../store/audit.js';

export interface ModuleCapabilityDetail {
  readonly name: string;
  readonly capabilities: readonly CapabilityName[];
}

export interface ModuleHostOptions {
  readonly modules?: readonly LoadedServiceModule[];
  readonly audit?: AuditSink;
  readonly auditMirrors?: readonly AuditSink[];
  readonly admissionGate?: AdmissionGate;
  readonly readinessProbe?: ReadinessProbe;
  readonly assetStore?: AssetStore;
  readonly platformHumanIdentity?: PlatformHumanIdentityContribution;
  readonly toolDispatch?: HostedToolDispatchHook;
}

export class ModuleHost {
  readonly routes: readonly ModuleRoute[];
  readonly audit: AuditSink;
  readonly policyGate: PolicyGate | undefined;
  readonly authVerifier: OwnerTokenVerifier | undefined;
  readonly dataPlaneAuthorizer: DataPlaneIdentityAuthorizer | undefined;
  readonly assetStore: AssetStore | undefined;
  readonly deploymentAutomation: DeploymentAutomationAuthorizer | undefined;
  readonly platformHumanIdentity: PlatformHumanIdentityContribution | undefined;
  readonly toolDispatch: HostedToolDispatchHook | undefined;
  readonly deploymentActivation: readonly NamedDeploymentActivationHook[];
  readonly organizationProvisioning: OrganizationProvisioningHook | undefined;
  readonly resolveActivityHistoryAllowance: ResolveActivityHistoryAllowance | undefined;
  readonly admissionGate: AdmissionGate;
  readonly moduleCapabilities: readonly CapabilityName[];
  readonly moduleCapabilityDetails: readonly ModuleCapabilityDetail[];
  readonly #readiness: readonly ReadinessProbe[];
  readonly #dispose: readonly (() => void | Promise<void>)[];
  #disposePromise: Promise<void> | undefined;

  constructor(options: ModuleHostOptions = {}) {
    const modules = options.modules ?? [];
    this.routes = collectRoutes(modules);
    this.policyGate = singleContribution(modules, 'policyGate');
    this.authVerifier = singleContribution(modules, 'authVerifier');
    this.dataPlaneAuthorizer = singleContribution(modules, 'dataPlaneAuthorizer');
    this.assetStore = singleContribution(modules, 'assetStore') ?? options.assetStore;
    this.deploymentAutomation = singleContribution(modules, 'deploymentAutomation');
    this.platformHumanIdentity =
      singleContribution(modules, 'platformHumanIdentity') ?? options.platformHumanIdentity;
    this.toolDispatch = toolDispatchFor(modules, options.toolDispatch);
    this.deploymentActivation = collectDeploymentActivation(modules);
    this.organizationProvisioning = singleContribution(modules, 'organizationProvisioning');
    this.resolveActivityHistoryAllowance = singleContribution(
      modules,
      'resolveActivityHistoryAllowance',
    );
    if (
      this.deploymentAutomation !== undefined &&
      !this.deploymentActivation.some(
        (hook) => hook.phase === DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS,
      )
    ) {
      throw new Error('deployment automation requires an automation-freshness activation hook');
    }
    this.admissionGate = admissionGateFor(modules, options.admissionGate);
    this.audit = auditFor(modules, options.audit, options.auditMirrors ?? []);
    this.moduleCapabilities = deriveModuleCapabilities(modules);
    this.moduleCapabilityDetails = deriveModuleCapabilityDetails(modules);
    this.#readiness = [
      ...(options.readinessProbe !== undefined ? [options.readinessProbe] : []),
      ...modules.flatMap((loaded) =>
        loaded.contributions.readiness !== undefined ? [loaded.contributions.readiness] : [],
      ),
    ];
    this.#dispose = modules.flatMap((loaded) =>
      loaded.contributions.dispose !== undefined ? [loaded.contributions.dispose] : [],
    );
  }

  async ready(): Promise<boolean> {
    for (const probe of this.#readiness) {
      try {
        if (!(await probe())) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= disposeAll(this.#dispose);
    return this.#disposePromise;
  }
}

async function disposeAll(disposers: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'module cleanup failed');
}

export function createServiceModuleProviders(input: {
  readonly options: ServiceOptions;
  readonly auditMirror: AuditSink;
  readonly admissionGate: AdmissionGate;
  readonly toolDispatch?: HostedToolDispatchHook;
}): {
  readonly host: ModuleHost;
  readonly options: ServiceOptions;
  readonly verifyOwnerToken: OwnerTokenVerifier | undefined;
} {
  const host = new ModuleHost({
    ...(input.options.audit !== undefined ? { audit: input.options.audit } : {}),
    auditMirrors: [input.auditMirror],
    admissionGate: input.admissionGate,
    ...(input.options.loadedModules !== undefined ? { modules: input.options.loadedModules } : {}),
    ...(input.options.readinessProbe !== undefined
      ? { readinessProbe: input.options.readinessProbe }
      : {}),
    ...(input.options.assetStore !== undefined ? { assetStore: input.options.assetStore } : {}),
    ...(input.toolDispatch !== undefined ? { toolDispatch: input.toolDispatch } : {}),
  });
  const providerOptions = { ...input.options };
  delete providerOptions.deploymentAutomation;
  return {
    host,
    options: {
      ...providerOptions,
      ...(host.assetStore !== undefined ? { assetStore: host.assetStore } : {}),
      ...(host.deploymentAutomation !== undefined
        ? { deploymentAutomation: host.deploymentAutomation }
        : {}),
    },
    verifyOwnerToken: input.options.verifyOwnerToken ?? host.authVerifier,
  };
}

function deriveModuleCapabilityDetails(
  modules: readonly LoadedServiceModule[],
): readonly ModuleCapabilityDetail[] {
  return modules
    .map((loaded) => ({
      name: loaded.module.name,
      capabilities: deriveModuleCapabilities([loaded]),
    }))
    .filter((detail) => detail.capabilities.length > 0);
}

function deriveModuleCapabilities(
  modules: readonly LoadedServiceModule[],
): readonly CapabilityName[] {
  const found = new Set<CapabilityName>();
  for (const loaded of modules) {
    const contributions = loaded.contributions;
    if (contributions.authVerifier !== undefined) found.add('identity');
    if (contributions.platformHumanIdentity !== undefined) found.add('identity');
    if (contributions.dataPlaneAuthorizer !== undefined || contributions.policyGate !== undefined) {
      found.add('access');
    }
    if (
      contributions.admission !== undefined ||
      contributions.toolDispatch !== undefined ||
      contributions.deploymentActivation !== undefined ||
      contributions.organizationProvisioning !== undefined ||
      contributions.deploymentAutomation !== undefined ||
      contributions.resolveActivityHistoryAllowance !== undefined
    ) {
      found.add('controls');
    }
    if (
      contributions.auditStore !== undefined ||
      (contributions.auditSinks !== undefined && contributions.auditSinks.length > 0)
    ) {
      found.add('audit');
    }
    if (contributions.readiness !== undefined) found.add('observability');
  }
  return CAPABILITY_NAMES.filter((name) => found.has(name));
}

function collectRoutes(modules: readonly LoadedServiceModule[]): readonly ModuleRoute[] {
  const seen = new Set<string>();
  const routes: ModuleRoute[] = [];
  for (const loaded of modules) {
    for (const route of loaded.contributions.routes ?? []) {
      if (seen.has(route.id)) {
        throw new Error(`duplicate module route id: ${route.id}`);
      }
      seen.add(route.id);
      routes.push(route);
    }
  }
  return routes;
}

function admissionGateFor(
  modules: readonly LoadedServiceModule[],
  fallback?: AdmissionGate,
): AdmissionGate {
  const hooks = modules
    .flatMap((loaded) =>
      loaded.contributions.admission !== undefined
        ? [{ ...loaded.contributions.admission, position: loaded.position }]
        : [],
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.position - b.position);

  return async (context): Promise<AdmissionDecision> => {
    for (const hook of hooks) {
      const decision = await hook.gate(context);
      if (!decision.allow) return decision;
    }
    return fallback ? fallback(context) : { allow: true };
  };
}

function toolDispatchFor(
  modules: readonly LoadedServiceModule[],
  fallback: HostedToolDispatchHook | undefined,
): HostedToolDispatchHook | undefined {
  const hooks = modules
    .flatMap((loaded) =>
      loaded.contributions.toolDispatch !== undefined
        ? [{ ...loaded.contributions.toolDispatch, position: loaded.position }]
        : [],
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.position - b.position);
  if (hooks.length === 0) return fallback;
  return async (context) => {
    for (const hook of hooks) {
      const decision = await hook.dispatch(context);
      if (!decision.allow) return decision;
    }
    return fallback?.(context) ?? { allow: true };
  };
}

function collectDeploymentActivation(
  modules: readonly LoadedServiceModule[],
): readonly NamedDeploymentActivationHook[] {
  const hooks = modules.flatMap((loaded) =>
    loaded.contributions.deploymentActivation !== undefined
      ? [loaded.contributions.deploymentActivation]
      : [],
  );
  const phases = [
    DEPLOYMENT_ACTIVATION_PHASE.COMMERCIAL_AUTHORITY,
    DEPLOYMENT_ACTIVATION_PHASE.AUTOMATION_FRESHNESS,
  ] as const;
  for (const hook of hooks) {
    if (!phases.includes(hook.phase)) {
      throw new Error(`unknown module deployment activation phase: ${String(hook.phase)}`);
    }
    if (hooks.filter((candidate) => candidate.phase === hook.phase).length > 1) {
      throw new Error(`multiple module activation phase contributions: ${hook.phase}`);
    }
  }
  return phases.flatMap((phase) => hooks.filter((hook) => hook.phase === phase));
}

function auditFor(
  modules: readonly LoadedServiceModule[],
  fallback: AuditSink | undefined,
  fallbackMirrors: readonly AuditSink[],
): AuditSink {
  const stores = modules.flatMap((loaded) =>
    loaded.contributions.auditStore !== undefined ? [loaded.contributions.auditStore] : [],
  );
  if (stores.length > 1) {
    throw new Error('multiple module auditStore contributions are not allowed');
  }
  const primary = stores[0] ?? fallback ?? new InMemoryAuditStore();
  const mirrors = [
    ...modules.flatMap((loaded) => loaded.contributions.auditSinks ?? []),
    ...(stores[0] !== undefined && fallback !== undefined && fallback !== primary
      ? [fallback]
      : []),
    ...fallbackMirrors,
  ];
  return new MultiSink(primary, mirrors);
}

function singleContribution<K extends keyof SingletonContributions>(
  modules: readonly LoadedServiceModule[],
  key: K,
): SingletonContributions[K] | undefined {
  const values = modules.flatMap((loaded) =>
    loaded.contributions[key] !== undefined ? [loaded.contributions[key]] : [],
  );
  if (values.length > 1) {
    throw new Error(`multiple module ${key} contributions are not allowed`);
  }
  return values[0] as SingletonContributions[K] | undefined;
}

interface SingletonContributions {
  readonly resolveActivityHistoryAllowance: ResolveActivityHistoryAllowance;
  readonly policyGate: PolicyGate;
  readonly authVerifier: OwnerTokenVerifier;
  readonly dataPlaneAuthorizer: DataPlaneIdentityAuthorizer;
  readonly auditStore: AuditStore;
  readonly assetStore: AssetStore;
  readonly deploymentAutomation: DeploymentAutomationAuthorizer;
  readonly organizationProvisioning: OrganizationProvisioningHook;
  readonly platformHumanIdentity: PlatformHumanIdentityContribution;
}
