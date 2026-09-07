import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, normalize, parse, resolve, sep } from 'node:path';

export type PluginHost = 'codex' | 'claude-code' | 'copilot' | 'cursor';

export interface PluginMode {
  readonly host: PluginHost;
  readonly configHome: string;
  readonly compatibilityFile: string;
}

const PLUGIN_VARIABLES = [
  'NOODLE_PLUGIN_HOST',
  'NOODLE_CONFIG_HOME',
  'NOODLE_PLUGIN_COMPATIBILITY_FILE',
] as const;

export class PluginModeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginModeError';
    this.code = code;
  }
}

/** Resolve the launcher's complete fail-closed environment tuple exactly once. */
export function resolvePluginMode(env: NodeJS.ProcessEnv): PluginMode | undefined {
  const values = PLUGIN_VARIABLES.map((name) => env[name]);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined || value === '')) {
    throw new PluginModeError(
      'plugin_environment_incomplete',
      `Plugin mode requires all three variables: ${PLUGIN_VARIABLES.join(', ')}.`,
    );
  }

  const host = env.NOODLE_PLUGIN_HOST;
  if (host !== 'codex' && host !== 'claude-code' && host !== 'copilot' && host !== 'cursor') {
    throw new PluginModeError(
      'plugin_host_invalid',
      `Unknown plugin host: ${host ?? '(missing)'}.`,
    );
  }
  const configHome = canonicalAbsolutePath('NOODLE_CONFIG_HOME', env.NOODLE_CONFIG_HOME);
  rejectSymlinkComponents(configHome);
  const compatibilityFile = canonicalAbsolutePath(
    'NOODLE_PLUGIN_COMPATIBILITY_FILE',
    env.NOODLE_PLUGIN_COMPATIBILITY_FILE,
  );
  return { host, configHome, compatibilityFile };
}

/** Plugin credentials and service selection are owned exclusively by the signed release tuple. */
export function assertPluginInvocation(argv: readonly string[]): void {
  const forbidden = argv.find((arg) => arg === '--auth-token' || arg === '--service');
  if (forbidden !== undefined) {
    throw new PluginModeError(
      'plugin_override_forbidden',
      `${forbidden} is not allowed in plugin mode; use the service and OAuth grant pinned by the installed plugin.`,
    );
  }
}

function canonicalAbsolutePath(name: string, value: string | undefined): string {
  if (
    value === undefined ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    resolve(value) !== value
  ) {
    throw new PluginModeError('plugin_path_invalid', `${name} must be a canonical absolute path.`);
  }
  return value;
}

function rejectSymlinkComponents(path: string): void {
  const root = parse(path).root;
  const parts = splitPluginPathComponents(path, root, sep);
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new PluginModeError(
        'plugin_profile_symlink',
        `NOODLE_CONFIG_HOME must not traverse a symbolic link (${cursor}).`,
      );
    }
  }
}

export function splitPluginPathComponents(
  path: string,
  root: string,
  separator: string,
): readonly string[] {
  return path.slice(root.length).split(separator).filter(Boolean);
}
