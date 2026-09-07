import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { JsonError } from './commands/output.js';
import { EXIT, printJsonFailure } from './commands/output.js';

const DISCOVERY_COMMANDS = new Set(['--help', '-h', 'help', '--version', '-v', 'version']);
const MOUNTED_WINDOWS_PATH = /^\/mnt\/[a-z](?:\/|$)/i;

export interface PlatformDoctorCheck {
  readonly level: 'PASS' | 'WARN';
  readonly name: string;
  readonly message: string;
  readonly cause?: string;
  readonly fix?: string;
  readonly next?: string;
}

export interface WslPlatformInput {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly nodePath: string;
  readonly npmPath?: string;
  readonly kernelRelease: string;
}

export function platformSupportFailure(
  argv: readonly string[],
  platform: NodeJS.Platform,
): JsonError | undefined {
  if (platform !== 'win32' || DISCOVERY_COMMANDS.has(argv[0] ?? '')) return undefined;
  return {
    code: 'unsupported_platform',
    message: 'Noodle CLI commands run on macOS or Windows through WSL2.',
    cause: 'Native PowerShell, Command Prompt, and Git Bash are not supported.',
    fix: 'Install WSL2 with Ubuntu and run Noodle from its Bash shell.',
    next: 'wsl --install -d Ubuntu',
  };
}

export function enforcePlatformSupport(
  argv: readonly string[],
  platform: NodeJS.Platform,
): number | undefined {
  const failure = platformSupportFailure(argv, platform);
  if (failure === undefined) return undefined;
  if (argv.includes('--json')) return printJsonFailure(failure, EXIT.USAGE);
  console.error(
    [
      `${failure.code}: ${failure.message}`,
      `Cause: ${failure.cause}`,
      `Fix: ${failure.fix}`,
      `Next: ${failure.next}`,
    ].join('\n'),
  );
  return EXIT.USAGE;
}

export function wslPlatformChecks(input: WslPlatformInput): readonly PlatformDoctorCheck[] {
  if (!isWsl(input.platform, input.env, input.kernelRelease)) return [];

  const distro = input.env.WSL_DISTRO_NAME;
  const isWsl2 = /wsl2/i.test(input.kernelRelease);
  const isUbuntu = distro !== undefined && /^ubuntu(?:-|$)/i.test(distro);
  const checks: PlatformDoctorCheck[] = [
    !isWsl2
      ? {
          level: 'WARN',
          name: 'Platform',
          message: `WSL version 2 not detected${distro ? ` (${distro})` : ''}`,
          cause: 'The supported Windows environment is WSL2 with Ubuntu.',
          fix: 'Upgrade this distro to WSL2 from PowerShell.',
          next:
            distro !== undefined
              ? `wsl.exe --set-version ${distro} 2`
              : 'wsl.exe --set-default-version 2',
        }
      : distro === undefined
        ? {
            level: 'WARN',
            name: 'Platform',
            message: 'WSL2 distro could not be identified',
            cause: 'The supported Windows environment is WSL2 with Ubuntu.',
            fix: 'Run Noodle from an Ubuntu WSL2 terminal.',
            next: 'wsl.exe --list --verbose',
          }
        : !isUbuntu
          ? {
              level: 'WARN',
              name: 'Platform',
              message: `WSL2 distro is not Ubuntu (${distro})`,
              cause: 'The supported Windows environment is WSL2 with Ubuntu.',
              fix: 'Install the supported Ubuntu distro for Noodle CLI work.',
              next: 'wsl.exe --install -d Ubuntu',
            }
          : {
              level: 'PASS',
              name: 'Platform',
              message: `WSL2 (${distro})`,
            },
  ];

  if (isMountedWindowsPath(input.cwd)) {
    checks.push({
      level: 'WARN',
      name: 'WSL workspace',
      message: input.cwd,
      cause:
        'The project is on a mounted Windows drive, which makes Node file watching and installs slower and less reliable.',
      fix: 'Move the repository into the WSL Linux filesystem, such as ~/src.',
      next: 'mkdir -p ~/src',
    });
  }

  if (isMountedWindowsPath(input.nodePath) || isMountedWindowsPath(input.npmPath)) {
    checks.push({
      level: 'WARN',
      name: 'WSL runtime',
      message: 'mounted Windows Node/npm detected',
      cause:
        'Node or npm resolves from /mnt, so the CLI is mixing Windows tools with the WSL environment.',
      fix: 'Install Node 24 and npm inside WSL, then ensure the Linux binaries appear first on PATH.',
      next: 'command -v node && command -v npm',
    });
  }

  return checks;
}

export function findExecutableOnPath(
  name: string,
  pathValue: string | undefined,
): string | undefined {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const candidateName of [name, `${name}.cmd`, `${name}.exe`]) {
      const candidate = join(directory, candidateName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, kernelRelease: string): boolean {
  return (
    platform === 'linux' &&
    (env.WSL_DISTRO_NAME !== undefined ||
      env.WSL_INTEROP !== undefined ||
      /microsoft|wsl/i.test(kernelRelease))
  );
}

function isMountedWindowsPath(path: string | undefined): boolean {
  return path !== undefined && MOUNTED_WINDOWS_PATH.test(path);
}
