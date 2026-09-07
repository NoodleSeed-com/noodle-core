import type { ModuleContributions, ServiceModule, ServiceModuleV1 } from '@noodle-borg/module';

/** What the loader produces for the host: the module, its contributions, and boot order. */
export interface LoadedServiceModule {
  readonly module: ServiceModule | ServiceModuleV1;
  readonly contributions: ModuleContributions;
  readonly position: number;
}
