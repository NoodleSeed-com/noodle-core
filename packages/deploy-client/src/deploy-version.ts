import { dirname, parse, resolve, sep } from 'node:path';
import { normalizeServerVersion } from '@noodle-borg/module';

export function normalizeDeployVersion(input: string): string {
  return normalizeServerVersion(input);
}

export function inferDeployVersionFromPath(
  entrypoint: string,
  cwd: string = process.cwd(),
): string | undefined {
  const absolute = resolve(cwd, entrypoint);
  let current = dirname(absolute);
  const root = parse(current).root;
  while (current !== root) {
    const segment = current.split(sep).at(-1);
    if (segment !== undefined) {
      const version = versionFromDirectorySegment(segment);
      if (version !== undefined) return version;
    }
    current = dirname(current);
  }
  return undefined;
}

function versionFromDirectorySegment(segment: string): string | undefined {
  if (!segment.startsWith('v')) return undefined;
  if (!/^v\d+(?:\.\d+){0,2}$/.test(segment)) return undefined;
  return normalizeServerVersion(segment);
}
