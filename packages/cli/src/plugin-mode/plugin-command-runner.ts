import { type ChildProcess, spawn } from 'node:child_process';

import type { PluginMode } from './profile.js';

const CAPTURE_LIMIT_BYTES = 256 * 1024;
const ESSENTIAL_ENVIRONMENT_NAMES = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

export interface BuildCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly workspaceHandle: string;
  readonly stdin?: string;
  /** Names only. The runner resolves and renames values at the last possible moment. */
  readonly forwardEnvironment?: readonly {
    readonly sourceName: string;
    readonly targetName: string;
  }[];
}

export interface BuildCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BuildReadinessCommandRunner {
  run(request: BuildCommandRequest): Promise<BuildCommandResult>;
  cancel(runId: string): Promise<boolean>;
}

export class LocalCliBuildRunner implements BuildReadinessCommandRunner {
  readonly #cliEntrypoint: string;
  readonly #pluginMode: PluginMode;
  readonly #sourceEnvironment: NodeJS.ProcessEnv;
  #active: ChildProcess | undefined;

  constructor(input: {
    readonly cliEntrypoint: string;
    readonly pluginMode: PluginMode;
    readonly sourceEnvironment: NodeJS.ProcessEnv;
  }) {
    this.#cliEntrypoint = input.cliEntrypoint;
    this.#pluginMode = input.pluginMode;
    this.#sourceEnvironment = input.sourceEnvironment;
  }

  async run(request: BuildCommandRequest): Promise<BuildCommandResult> {
    if (this.#active !== undefined) throw new Error('A managed build process is already active.');
    const child = spawn(process.execPath, [this.#cliEntrypoint, request.command, ...request.args], {
      cwd: request.cwd,
      env: pluginChildEnvironment(
        this.#pluginMode,
        this.#sourceEnvironment,
        request.forwardEnvironment,
      ),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#active = child;
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    child.stdin?.on('error', () => {
      // A child that exits before consuming bounded input reports its own stable exit result.
    });
    if (request.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(request.stdin);
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 130));
      });
      const sensitiveValues = (request.forwardEnvironment ?? [])
        .map(({ sourceName }) => this.#sourceEnvironment[sourceName])
        .filter((value): value is string => value !== undefined && value.length > 0);
      return {
        exitCode,
        stdout: redact(stdout.text(), sensitiveValues),
        stderr: redact(stderr.text(), sensitiveValues),
      };
    } finally {
      if (this.#active === child) this.#active = undefined;
    }
  }

  async cancel(_runId: string): Promise<boolean> {
    return this.#active?.kill('SIGTERM') ?? false;
  }
}

/**
 * Build a minimal child environment. Ambient cloud, registry, CI, and host credentials are not
 * forwarded. A secret operation may map one validated source name to an inert child name explicitly.
 */
export function pluginChildEnvironment(
  mode: PluginMode,
  source: NodeJS.ProcessEnv,
  forwardedNames: readonly {
    readonly sourceName: string;
    readonly targetName: string;
  }[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ESSENTIAL_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  for (const { sourceName, targetName } of forwardedNames) {
    const value = source[sourceName];
    if (value !== undefined) env[targetName] = value;
  }
  return {
    ...env,
    NOODLE_PLUGIN_HOST: mode.host,
    NOODLE_CONFIG_HOME: mode.configHome,
    NOODLE_PLUGIN_COMPATIBILITY_FILE: mode.compatibilityFile,
    NOODLE_UPDATE_MODE: 'off',
  };
}

function capture(stream: NodeJS.ReadableStream | null): { text: () => string } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream?.on('data', (chunk: Buffer | string) => {
    if (bytes >= CAPTURE_LIMIT_BYTES) return;
    const buffer = Buffer.from(chunk);
    const remaining = CAPTURE_LIMIT_BYTES - bytes;
    chunks.push(buffer.subarray(0, remaining));
    bytes += Math.min(buffer.length, remaining);
  });
  return { text: () => Buffer.concat(chunks).toString('utf8') };
}

function redact(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitive of new Set(sensitiveValues)) {
    redacted = redacted.split(sensitive).join('[redacted]');
  }
  return redacted;
}
