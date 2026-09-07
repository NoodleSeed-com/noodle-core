/**
 * Binary ownership resolver for `noodle update` repair (#242, ADR 0124).
 *
 * npm's `EEXIST .../bin/noodle` failure happens before any of our code runs, so
 * `noodle update` inspects the expected global bin path itself: does a `noodle`
 * binary exist there, is it a symlink, where does it resolve, and is that target
 * provably a Noodle CLI install? Classification is deliberately conservative:
 *
 * - SAFE to repair: a symlink into an `@noodleseed/one` (or legacy `noodleseed-cli`)
 *   package outside the active prefix, a dangling symlink, or a launcher file that
 *   provably references a Noodle CLI package.
 * - UNSAFE: everything else — real files of unknown content, symlinks into other
 *   packages or arbitrary files, unreadable paths. Ambiguous is always UNSAFE.
 *
 * All probes are dependency-injected (fs + execPath) so every classification case
 * is unit-testable against temp prefixes, never the developer's real global prefix.
 */
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

type BinaryPathKind = 'file' | 'symlink' | 'dir' | 'other' | 'missing' | 'error';

export interface BinaryProbeDeps {
  /** The running node executable; the expected global npm bin dir is its directory. */
  readonly execPath: string;
  lstatKind(path: string): BinaryPathKind;
  readlink(path: string): string | undefined;
  realpath(path: string): string | undefined;
  /** First bytes of a file (launcher-shim sniffing). Undefined when unreadable. */
  readFileHead(path: string): string | undefined;
}

/** Real-filesystem probes; `execPath` is overridable so tests point at a temp prefix. */
export function realBinaryProbeDeps(
  overrides: Partial<Pick<BinaryProbeDeps, 'execPath'>> = {},
): BinaryProbeDeps {
  return {
    execPath: overrides.execPath ?? process.execPath,
    lstatKind: (path) => {
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) return 'symlink';
        if (stat.isFile()) return 'file';
        if (stat.isDirectory()) return 'dir';
        return 'other';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'error';
      }
    },
    readlink: (path) => {
      try {
        return readlinkSync(path);
      } catch {
        return undefined;
      }
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
    readFileHead: (path) => {
      try {
        return readFileSync(path, 'utf8').slice(0, 4096);
      } catch {
        return undefined;
      }
    },
  };
}

type BinaryStatus =
  | { readonly kind: 'none' }
  /** A healthy symlink into the active prefix's own Noodle CLI package — npm updates it in place. */
  | { readonly kind: 'active-install'; readonly target: string }
  /** A blocking binary that is provably a Noodle CLI leftover; removing it is authorized. */
  | { readonly kind: 'safe-repair'; readonly reason: string }
  /** A blocking binary of unknown or foreign ownership; never removed automatically. */
  | { readonly kind: 'unsafe'; readonly reason: string };

export interface NoodleBinaryInspection {
  readonly expectedBinDir: string;
  readonly binPath: string;
  readonly status: BinaryStatus;
}

/** The npm-installed package directory of the current CLI. */
const CURRENT_PACKAGE_PATH = join('node_modules', '@noodleseed', 'one');
/** Known previous Noodle CLI installs (also safe to replace, but never "active"). */
const LEGACY_PACKAGE_PATHS = [join('node_modules', 'noodleseed-cli')];

function containsPackagePath(path: string, packagePath: string): boolean {
  return path.includes(`${sep}${packagePath}${sep}`) || path.endsWith(`${sep}${packagePath}`);
}

function isCurrentPackagePath(path: string): boolean {
  return containsPackagePath(path, CURRENT_PACKAGE_PATH);
}

function isOwnedPackagePath(path: string): boolean {
  return (
    isCurrentPackagePath(path) ||
    LEGACY_PACKAGE_PATHS.some((legacy) => containsPackagePath(path, legacy))
  );
}

/** Inspect the expected global `noodle` binary and classify it. Never mutates anything. */
export function inspectNoodleBinary(
  deps: BinaryProbeDeps = realBinaryProbeDeps(),
): NoodleBinaryInspection {
  const expectedBinDir = dirname(deps.execPath);
  const binPath = join(expectedBinDir, 'noodle');
  return { expectedBinDir, binPath, status: classify(deps, expectedBinDir, binPath) };
}

function classify(deps: BinaryProbeDeps, expectedBinDir: string, binPath: string): BinaryStatus {
  switch (deps.lstatKind(binPath)) {
    case 'missing':
      return { kind: 'none' };
    case 'error':
      return { kind: 'unsafe', reason: 'the existing binary could not be inspected' };
    case 'dir':
    case 'other':
      return { kind: 'unsafe', reason: 'the path is not a regular file or symlink' };
    case 'symlink':
      return classifySymlink(deps, expectedBinDir, binPath);
    case 'file':
      return classifyFile(deps, binPath);
  }
}

function classifySymlink(
  deps: BinaryProbeDeps,
  expectedBinDir: string,
  binPath: string,
): BinaryStatus {
  const link = deps.readlink(binPath);
  if (link === undefined) return { kind: 'unsafe', reason: 'the symlink could not be read' };
  const linkTarget = isAbsolute(link) ? link : resolve(dirname(binPath), link);
  const real = deps.realpath(binPath);
  if (real === undefined) {
    // Dangling symlink: removing it cannot destroy anything.
    return { kind: 'safe-repair', reason: `broken symlink to ${linkTarget}` };
  }
  if (isOwnedPackagePath(real) || isOwnedPackagePath(linkTarget)) {
    // Only the current package inside the active prefix is npm-updatable in place;
    // a legacy package's bin (any prefix) still blocks `npm install -g @noodleseed/one`.
    if (isCurrentPackagePath(real)) {
      // Canonicalize the active prefix too (macOS tmp dirs resolve through /private).
      const prefixDir = dirname(expectedBinDir);
      const prefix = deps.realpath(prefixDir) ?? prefixDir;
      if (real.startsWith(`${prefix}${sep}`)) {
        return { kind: 'active-install', target: real };
      }
    }
    return {
      kind: 'safe-repair',
      reason: `symlink into a Noodle CLI install that npm cannot update in place (${real})`,
    };
  }
  return {
    kind: 'unsafe',
    reason: `the symlink resolves to ${real}, which is not a Noodle CLI install`,
  };
}

function classifyFile(deps: BinaryProbeDeps, binPath: string): BinaryStatus {
  const head = deps.readFileHead(binPath);
  if (head === undefined) return { kind: 'unsafe', reason: 'the existing file is unreadable' };
  // npm launcher shims (Windows-style .cmd/.ps1 or sh) embed the package path they run.
  if (head.includes('@noodleseed/one') || head.includes('noodleseed-cli')) {
    return { kind: 'safe-repair', reason: 'launcher script for a previous Noodle CLI install' };
  }
  return {
    kind: 'unsafe',
    reason: 'the existing file is not known to be owned by @noodleseed/one',
  };
}
