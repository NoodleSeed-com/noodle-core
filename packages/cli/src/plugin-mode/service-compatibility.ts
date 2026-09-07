import { serviceJson } from '../control-plane.js';
import { currentCliVersion } from '../update.js';
import { pluginCompatibilityMismatch, readPluginCompatibility } from './compatibility.js';
import type { PluginMode } from './profile.js';

export interface PluginServiceCompatibilityFailure {
  readonly code: 'plugin_cli_incompatible' | 'plugin_server_incompatible';
  readonly message: string;
  readonly cause: string;
  readonly fix: string;
  readonly next: string;
  readonly exitCode: 1;
}

export async function pluginServiceCompatibilityFailure(input: {
  readonly pluginMode?: PluginMode;
  readonly serviceUrl: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<PluginServiceCompatibilityFailure | undefined> {
  if (input.pluginMode === undefined) return undefined;
  const manifest = readPluginCompatibility(input.pluginMode.compatibilityFile);
  const cliVersion = currentCliVersion();
  const localMismatch = pluginCompatibilityMismatch({
    manifest,
    cliVersion,
    serviceUrl: input.serviceUrl,
  });
  if (localMismatch?.kind === 'cli') {
    return {
      code: 'plugin_cli_incompatible',
      message: 'The installed Noodle plugin requires a different CLI version.',
      cause: localMismatch.cause,
      fix: 'Update or reinstall the Noodle Seed plugin so its pinned CLI is restored.',
      next: 'Reinstall the Noodle Seed plugin.',
      exitCode: 1,
    };
  }

  if (localMismatch !== undefined) return serverFailure(localMismatch.cause);

  try {
    const info = await serviceJson<{
      readonly developerPlugin?: { readonly mcpCapabilityVersion?: unknown };
    }>(`${input.serviceUrl.replace(/\/+$/, '')}/v1/service/info`, undefined, {}, input.fetchImpl);
    const provided = info.developerPlugin?.mcpCapabilityVersion;
    if (typeof provided !== 'string') {
      return serverFailure(
        'The selected Noodle Cloud service does not advertise the Developer MCP capability.',
      );
    }
    const serverMismatch = pluginCompatibilityMismatch({
      manifest,
      cliVersion,
      serviceUrl: input.serviceUrl,
      developerMcpCapabilityVersion: provided,
    });
    if (serverMismatch !== undefined) {
      return serverFailure(serverMismatch.cause);
    }
  } catch (error) {
    return serverFailure(
      `The Noodle Cloud compatibility handshake failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return undefined;
}

function serverFailure(cause: string): PluginServiceCompatibilityFailure {
  return {
    code: 'plugin_server_incompatible',
    message: 'The installed Noodle plugin is not compatible with this Noodle Cloud release.',
    cause,
    fix: 'Use the Noodle Cloud endpoint bundled with the plugin, or update the plugin.',
    next: 'Update or reinstall the Noodle Seed plugin.',
    exitCode: 1,
  };
}
