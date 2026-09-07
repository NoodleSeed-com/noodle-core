import { CAPABILITY_NAMES, type CapabilityName } from '@noodle-borg/capabilities';
import type { ModuleCapabilityDetail, ModuleHost } from './modules/host.js';

const CORE_CAPABILITIES: readonly CapabilityName[] = [
  'observability',
  'secrets',
  'connectors',
  'apps',
];

export interface ServiceCapabilityReport {
  readonly capabilities: readonly CapabilityName[];
  readonly modules: readonly ModuleCapabilityDetail[];
}

export function serviceCapabilityReport(moduleHost: ModuleHost): ServiceCapabilityReport {
  const found = new Set<CapabilityName>(CORE_CAPABILITIES);
  for (const name of moduleHost.moduleCapabilities) found.add(name);
  return {
    capabilities: CAPABILITY_NAMES.filter((name) => found.has(name)),
    modules: moduleHost.moduleCapabilityDetails,
  };
}
