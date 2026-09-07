import { currentCliVersion } from './update.js';

export type ProjectPackageManager = 'npm' | 'pnpm' | 'yarn';

/** Versions qualified with the generated profiles. System Release supplies the CLI's own version. */
const TOOLCHAIN: Readonly<Record<string, string>> = {
  vitest: '4.1.8',
  typescript: '6.0.3',
  vite: '8.1.0',
  '@vitejs/plugin-react': '6.1.1',
  '@types/node': '24.13.1',
  react: '19.2.7',
  'react-dom': '19.2.7',
  '@types/react': '19.2.17',
  '@types/react-dom': '19.2.3',
};

export function projectDependencyPins(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => {
      const version = name === '@noodleseed/one' ? currentCliVersion() : TOOLCHAIN[name];
      if (!version) throw new Error('Starter dependency has no qualified version.');
      return [name, version];
    }),
  );
}

export function isProjectPackageManager(value: unknown): value is ProjectPackageManager {
  return value === 'npm' || value === 'pnpm' || value === 'yarn';
}

export const PROJECT_LOCKFILES: Readonly<Record<string, ProjectPackageManager>> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
};

export function selectPackageManager(input: {
  readonly requested?: ProjectPackageManager;
  readonly packageManager?: string;
  readonly lockfiles?: readonly string[];
  readonly userAgent?: string;
}): ProjectPackageManager {
  const owners = new Set(
    (input.lockfiles ?? [])
      .map((name) => PROJECT_LOCKFILES[name])
      .filter((owner) => owner !== undefined),
  );
  if (input.packageManager !== undefined) {
    const declared = /^(npm|pnpm|yarn)@\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.exec(
      input.packageManager,
    )?.[1];
    if (!isProjectPackageManager(declared))
      throw new Error('unsupported package manager declaration');
    owners.add(declared);
  }
  if (input.requested) owners.add(input.requested);
  if (owners.size > 1)
    throw new Error('package-manager conflict: preserve the existing manager and lockfile');
  const existing = [...owners][0];
  if (existing) return existing;
  const invoking = input.userAgent?.split('/')[0];
  return isProjectPackageManager(invoking) ? invoking : 'npm';
}

/** Installation stays local, retains existing locks and never runs dependency lifecycle scripts. */
export function installArguments(
  manager: ProjectPackageManager,
  version: string,
  locked: boolean,
): string[] {
  const major = Number(/^(\d+)\./.exec(version)?.[1]);
  if (!Number.isSafeInteger(major) || major < 1)
    throw new Error('Package manager version could not be verified.');
  if (manager === 'npm')
    return [
      locked ? 'ci' : 'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--workspaces=false',
    ];
  if (manager === 'pnpm')
    return [
      'install',
      locked ? '--frozen-lockfile' : '--no-frozen-lockfile',
      '--ignore-scripts',
      '--ignore-workspace',
    ];
  throw new Error('Yarn cannot install the CLI bundled runtime; preserve its existing lockfile.');
}
