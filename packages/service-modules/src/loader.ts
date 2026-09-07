import {
  LEGACY_MODULE_API_VERSION,
  MODULE_API_VERSION,
  type ModuleContributions,
  type ModuleContributionsV1,
  type ModuleHostContext,
  type ServiceModule,
  type ServiceModuleV1,
} from '@noodle-borg/module';
import type { Logger } from '@noodle-borg/transport-http';
import type { LoadedServiceModule } from './loaded-module.js';

export interface ModuleSpec {
  readonly package: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly onError?: 'fail-closed' | 'fail-open';
}

type AnyServiceModule = ServiceModule | ServiceModuleV1;

export type ModuleInput = ModuleSpec | AnyServiceModule;
export type ModuleImporter = (packageName: string) => Promise<unknown>;

export interface LoadModulesOptions {
  readonly allowlist?: readonly string[];
  readonly logger?: Logger;
  readonly importer?: ModuleImporter;
  readonly hostApiVersion?: typeof LEGACY_MODULE_API_VERSION | typeof MODULE_API_VERSION;
}

export async function loadModules(
  specs: readonly ModuleInput[] | undefined,
  ctx: ModuleHostContext,
  options: LoadModulesOptions = {},
): Promise<readonly LoadedServiceModule[]> {
  const loaded: LoadedServiceModule[] = [];
  let position = 0;
  for (const spec of specs ?? []) {
    if (isModuleInstance(spec)) {
      loaded.push(
        await initModule(spec, ctx, position, options.hostApiVersion ?? MODULE_API_VERSION),
      );
      position++;
      continue;
    }
    const module = await loadDynamicModule(spec, ctx, options);
    if (module === undefined) {
      position++;
      continue;
    }
    loaded.push({ ...module, position });
    position++;
  }
  return loaded;
}

async function loadDynamicModule(
  spec: ModuleSpec,
  ctx: ModuleHostContext,
  options: LoadModulesOptions,
): Promise<Omit<LoadedServiceModule, 'position'> | undefined> {
  if (!options.allowlist?.includes(spec.package)) {
    throw new Error(`module package is not allowlisted: ${spec.package}`);
  }

  let namespace: unknown;
  try {
    namespace = await (options.importer ?? ((name: string) => import(name)))(spec.package);
  } catch (error) {
    return handleSkippableLoadError(spec, options.logger, error);
  }

  const factory = moduleFactory(namespace);
  if (factory === undefined) {
    throw new Error(
      `module package ${spec.package} does not export a createModule/default factory`,
    );
  }

  const module = factory();
  assertModule(module, spec.package, options.hostApiVersion ?? MODULE_API_VERSION);
  try {
    const contributions = await initContributions(module, contextWithOptions(ctx, spec.options));
    return { module, contributions };
  } catch (error) {
    return handleSkippableLoadError(spec, options.logger, error);
  }
}

async function initModule(
  module: AnyServiceModule,
  ctx: ModuleHostContext,
  position: number,
  hostApiVersion: typeof LEGACY_MODULE_API_VERSION | typeof MODULE_API_VERSION = MODULE_API_VERSION,
): Promise<LoadedServiceModule> {
  assertModule(module, module.name, hostApiVersion);
  const contributions = await initContributions(module, ctx);
  return { module, contributions, position };
}

function moduleFactory(namespace: unknown): (() => AnyServiceModule) | undefined {
  if (typeof namespace !== 'object' || namespace === null) return undefined;
  const exports = namespace as { createModule?: unknown; default?: unknown };
  const factory = exports.createModule ?? exports.default;
  return typeof factory === 'function' ? (factory as () => AnyServiceModule) : undefined;
}

function assertModule(
  module: unknown,
  label: string,
  hostApiVersion: typeof LEGACY_MODULE_API_VERSION | typeof MODULE_API_VERSION,
): asserts module is AnyServiceModule {
  if (typeof module !== 'object' || module === null) {
    throw new Error(`module ${label} factory did not return a ServiceModule`);
  }
  const candidate = module as Partial<AnyServiceModule>;
  if (
    typeof candidate.name !== 'string' ||
    typeof candidate.version !== 'string' ||
    typeof candidate.init !== 'function'
  ) {
    throw new Error(`module ${label} has incompatible API version or shape`);
  }
  if (
    candidate.apiVersion !== LEGACY_MODULE_API_VERSION &&
    candidate.apiVersion !== MODULE_API_VERSION
  ) {
    throw new Error(`module ${label} has incompatible API version ${String(candidate.apiVersion)}`);
  }
  if (candidate.apiVersion > hostApiVersion) {
    throw new Error(
      `module ${label} requires module API v${candidate.apiVersion}, but host supports v${hostApiVersion}`,
    );
  }
}

function isModuleInstance(input: ModuleInput): input is AnyServiceModule {
  return 'apiVersion' in input && 'init' in input;
}

async function initContributions(
  module: AnyServiceModule,
  ctx: ModuleHostContext,
): Promise<ModuleContributions> {
  if (module.apiVersion === LEGACY_MODULE_API_VERSION) {
    return adaptLegacyContributions(await Promise.resolve(module.init(ctx)));
  }
  return Promise.resolve(module.init(ctx));
}

function adaptLegacyContributions(contributions: ModuleContributionsV1): ModuleContributions {
  return {
    ...(contributions.routes === undefined ? {} : { routes: contributions.routes }),
    ...(contributions.admission === undefined ? {} : { admission: contributions.admission }),
    ...(contributions.auditSinks === undefined ? {} : { auditSinks: contributions.auditSinks }),
    ...(contributions.auditStore === undefined ? {} : { auditStore: contributions.auditStore }),
    ...(contributions.policyGate === undefined ? {} : { policyGate: contributions.policyGate }),
    ...(contributions.authVerifier === undefined
      ? {}
      : { authVerifier: contributions.authVerifier }),
    ...(contributions.dataPlaneAuthorizer === undefined
      ? {}
      : { dataPlaneAuthorizer: contributions.dataPlaneAuthorizer }),
    ...(contributions.readiness === undefined ? {} : { readiness: contributions.readiness }),
    ...(contributions.dispose === undefined ? {} : { dispose: contributions.dispose }),
  };
}

function contextWithOptions(
  ctx: ModuleHostContext,
  specOptions: Readonly<Record<string, unknown>> | undefined,
): ModuleHostContext {
  return specOptions === undefined ? ctx : { ...ctx, options: specOptions };
}

function handleSkippableLoadError(
  spec: ModuleSpec,
  logger: Logger | undefined,
  error: unknown,
): undefined {
  if (spec.onError === 'fail-open') {
    logger?.warn('module.load.skipped', {
      package: spec.package,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  throw error;
}
