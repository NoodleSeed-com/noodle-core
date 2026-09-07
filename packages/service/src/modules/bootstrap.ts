import type { AuditSink } from '@noodle-borg/module';
import {
  type LoadedServiceModule,
  loadModules,
  type ModuleImporter,
  type ModuleInput,
} from '@noodle-borg/service-modules';
import type { Logger } from '@noodle-borg/transport-http';
import { ModuleHost } from './host.js';

export interface ServiceModuleBootstrapOptions {
  readonly inputs: readonly ModuleInput[] | undefined;
  readonly allowlist: readonly string[] | undefined;
  readonly importer: ModuleImporter | undefined;
  readonly logger: Logger;
  readonly postgresPool: unknown;
  readonly audit: AuditSink | undefined;
  readonly clock?: () => Date;
}

export async function bootstrapServiceModules(options: ServiceModuleBootstrapOptions): Promise<{
  readonly host: ModuleHost;
  readonly loaded: readonly LoadedServiceModule[];
}> {
  let inputs = options.inputs;
  if (options.postgresPool !== undefined) {
    const { createModule: createAuditModule } = await import('@noodle-borg/module-audit');
    inputs = [createAuditModule(), ...(inputs ?? [])];
  }
  const loaded = await loadModules(
    inputs,
    {
      logger: options.logger,
      clock: options.clock ?? (() => new Date()),
      ...(options.postgresPool === undefined
        ? {}
        : { stores: { postgresPool: () => options.postgresPool } }),
    },
    {
      logger: options.logger,
      ...(options.allowlist === undefined ? {} : { allowlist: options.allowlist }),
      ...(options.importer === undefined ? {} : { importer: options.importer }),
    },
  );
  let host: ModuleHost;
  try {
    host = new ModuleHost({
      modules: loaded,
      ...(options.audit === undefined ? {} : { audit: options.audit }),
    });
  } catch (error) {
    return disposeLoadedModules(loaded, error);
  }
  try {
    await host.platformHumanIdentity?.continuityProbe?.();
  } catch (error) {
    try {
      await host.dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'module identity continuity and cleanup both failed',
      );
    }
    throw error;
  }
  return { host, loaded };
}

async function disposeLoadedModules(
  loaded: readonly LoadedServiceModule[],
  bootError: unknown,
): Promise<never> {
  const errors: unknown[] = [bootError];
  for (const module of loaded) {
    try {
      await module.contributions.dispose?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'module host construction and cleanup both failed');
  }
  throw bootError;
}
