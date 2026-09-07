import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginCompatibilityManifest } from '@noodle-borg/agent-kit';
import { createPluginCompatibility, renderPluginCompatibilityJson } from '@noodle-borg/agent-kit';
import { type PluginHost, PluginModeError, resolvePluginMode } from './profile.js';

const BOOTSTRAP_FLAGS = [
  '--plugin-host',
  '--plugin-version',
  '--agent-kit-version',
  '--plugin-content-hash',
  '--developer-mcp-url',
  '--developer-mcp-capability-version',
] as const;

interface BootstrapOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly cliVersion: string;
}

interface BootstrappedInvocation {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Materialize the signed plugin tuple when a host launches the exact pinned CLI package. */
export async function bootstrapPluginMcpInvocation(
  argv: readonly string[],
  options: BootstrapOptions,
): Promise<BootstrappedInvocation | undefined> {
  if (argv[0] !== 'plugin-mcp' || hasManagedPluginEnvironment(options.env)) return undefined;

  const values = parseBootstrapArguments(argv.slice(1));
  const host = pluginHost(values.get('--plugin-host'));
  let compatibility: PluginCompatibilityManifest;
  try {
    compatibility = createPluginCompatibility({
      mode: 'release',
      pluginVersion: requiredValue(values, '--plugin-version'),
      agentKitVersion: requiredValue(values, '--agent-kit-version'),
      pluginContentHash: requiredValue(values, '--plugin-content-hash'),
      cliVersion: options.cliVersion,
      developerMcpUrl: requiredValue(values, '--developer-mcp-url'),
      developerMcpCapabilityVersion: requiredValue(values, '--developer-mcp-capability-version'),
    });
  } catch (error) {
    throw bootstrapError(error instanceof Error ? error.message : String(error));
  }

  const configHome = join(options.home, '.noodle', 'plugin-profiles', host);
  const compatibilityFile = join(configHome, 'plugin-mcp-compatibility.json');
  const env = {
    ...options.env,
    NOODLE_PLUGIN_HOST: host,
    NOODLE_CONFIG_HOME: configHome,
    NOODLE_PLUGIN_COMPATIBILITY_FILE: compatibilityFile,
  };
  resolvePluginMode(env);

  await mkdir(configHome, { recursive: true, mode: 0o700 });
  await chmod(configHome, 0o700);
  const temporaryFile = join(configHome, `.plugin-mcp-compatibility.${randomUUID()}.tmp`);
  await writeFile(temporaryFile, renderPluginCompatibilityJson(compatibility), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporaryFile, compatibilityFile);
  await chmod(compatibilityFile, 0o600);
  return { argv: ['plugin-mcp'], env };
}

function hasManagedPluginEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NOODLE_PLUGIN_HOST !== undefined ||
    env.NOODLE_CONFIG_HOME !== undefined ||
    env.NOODLE_PLUGIN_COMPATIBILITY_FILE !== undefined
  );
}

function parseBootstrapArguments(argv: readonly string[]): ReadonlyMap<string, string> {
  if (argv.length !== BOOTSTRAP_FLAGS.length * 2) {
    throw bootstrapError('expected one value for every supported flag');
  }
  const supported = new Set<string>(BOOTSTRAP_FLAGS);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !supported.has(flag) || values.has(flag) || value === undefined) {
      throw bootstrapError('arguments must be unique supported flag-value pairs');
    }
    values.set(flag, value);
  }
  for (const flag of BOOTSTRAP_FLAGS) requiredValue(values, flag);
  return values;
}

function requiredValue(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value === '') throw bootstrapError(`${flag} requires a value`);
  return value;
}

function pluginHost(value: string | undefined): PluginHost {
  if (value !== 'codex' && value !== 'claude-code' && value !== 'copilot' && value !== 'cursor') {
    throw bootstrapError('--plugin-host must be codex, claude-code, copilot, or cursor');
  }
  return value;
}

function bootstrapError(reason: string): PluginModeError {
  return new PluginModeError('plugin_mcp_bootstrap_invalid', `Plugin MCP bootstrap: ${reason}.`);
}
