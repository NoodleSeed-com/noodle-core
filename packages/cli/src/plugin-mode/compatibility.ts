import { readFileSync } from 'node:fs';
import { type PluginCompatibilityManifest, parsePluginCompatibility } from '@noodle-borg/agent-kit';

export type { PluginCompatibilityManifest } from '@noodle-borg/agent-kit';

export function readPluginCompatibility(path: string): PluginCompatibilityManifest {
  try {
    return parsePluginCompatibility(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read plugin compatibility metadata: ${detail}`);
  }
}

export function pluginServiceOrigin(manifest: PluginCompatibilityManifest): string {
  return new URL(manifest.developerMcpUrl).origin;
}

export function assertPluginServiceOrigin(
  manifest: PluginCompatibilityManifest,
  serviceUrl: string,
): void {
  const pinned = pluginServiceOrigin(manifest);
  const selected = new URL(serviceUrl).origin;
  if (selected !== pinned) {
    throw new Error(`The installed Noodle plugin is pinned to ${pinned}, not ${selected}.`);
  }
}

export function assertPluginCompatibility(input: {
  readonly manifest: PluginCompatibilityManifest;
  readonly cliVersion: string;
  readonly serviceUrl?: string;
  readonly developerMcpCapabilityVersion?: string;
}): void {
  const mismatch = pluginCompatibilityMismatch(input);
  if (mismatch !== undefined) throw new Error(mismatch.cause);
}

export interface PluginCompatibilityMismatch {
  readonly kind: 'cli' | 'server';
  readonly cause: string;
}

export function pluginCompatibilityMismatch(input: {
  readonly manifest: PluginCompatibilityManifest;
  readonly cliVersion: string;
  readonly serviceUrl?: string;
  readonly developerMcpCapabilityVersion?: string;
}): PluginCompatibilityMismatch | undefined {
  if (input.manifest.cliVersion !== input.cliVersion) {
    return {
      kind: 'cli',
      cause: `The plugin pins CLI ${input.manifest.cliVersion}, but the launcher resolved ${input.cliVersion}.`,
    };
  }
  if (input.serviceUrl !== undefined) {
    let serviceOrigin: string;
    try {
      serviceOrigin = new URL(input.serviceUrl).origin;
    } catch {
      return { kind: 'server', cause: 'The selected Noodle Cloud service URL is invalid.' };
    }
    const pinnedOrigin = pluginServiceOrigin(input.manifest);
    if (serviceOrigin !== pinnedOrigin) {
      return {
        kind: 'server',
        cause: `The plugin is pinned to ${pinnedOrigin}, not ${serviceOrigin}.`,
      };
    }
  }
  if (
    input.developerMcpCapabilityVersion !== undefined &&
    input.manifest.developerMcpCapabilityVersion !== input.developerMcpCapabilityVersion
  ) {
    return {
      kind: 'server',
      cause: `The plugin requires Developer MCP capability ${input.manifest.developerMcpCapabilityVersion}, but Noodle Cloud provides ${input.developerMcpCapabilityVersion}.`,
    };
  }
  return undefined;
}
