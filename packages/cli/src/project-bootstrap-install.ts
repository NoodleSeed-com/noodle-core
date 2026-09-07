import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PROJECT_LOCKFILES, type ProjectPackageManager } from './project-toolchain.js';

const manifestSchema = z.object({
  packageManager: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

/** Inspect dependency metadata only; never read dotenv files or return raw parse errors. */
export function readBootstrapManifest(project: string) {
  const file = join(project, 'package.json');
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    return manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      'Project package.json is unreadable or invalid; preserve and repair it before setup.',
    );
  }
}

export function bootstrapLockfiles(project: string): string[] {
  return Object.keys(PROJECT_LOCKFILES).filter((name) => {
    try {
      const stat = lstatSync(join(project, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(
        'Project lockfile is unreadable or unsafe; preserve and repair it before setup.',
      );
    }
  });
}

export function bootstrapDependencyFingerprint(project: string): string {
  const hash = createHash('sha256');
  readBootstrapManifest(project);
  for (const name of ['package.json', ...bootstrapLockfiles(project).sort()]) {
    hash
      .update(name)
      .update('\0')
      .update(readFileSync(join(project, name)))
      .update('\0');
  }
  return hash.digest('hex');
}

/** The dependency must be installed in this project, not discovered through a parent/global fallback. */
export function installedBootstrapCli(project: string, version: string): string | undefined {
  const root = join(project, 'node_modules/@noodleseed/one');
  try {
    const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (
      raw.name !== '@noodleseed/one' ||
      raw.version !== version ||
      raw.bin?.noodle !== 'dist/bin.js'
    )
      return undefined;
    const bin = join(root, 'dist/bin.js');
    return lstatSync(bin).isFile() ? bin : undefined;
  } catch {
    return undefined;
  }
}

export function hasCompletedBootstrapLock(
  project: string,
  manager: ProjectPackageManager,
): boolean {
  return bootstrapLockfiles(project).some(
    (name) => PROJECT_LOCKFILES[name] === manager && lstatSync(join(project, name)).size > 0,
  );
}
