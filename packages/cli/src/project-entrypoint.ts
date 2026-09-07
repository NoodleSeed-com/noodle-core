import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type ProjectEntrypointSource =
  | 'NOODLE_ENTRYPOINT'
  | '.noodle/project.json'
  | 'noodle.json'
  | 'conventional discovery';

export interface ProjectEntrypointResolution {
  readonly source: ProjectEntrypointSource;
  readonly value: string;
  readonly path: string;
  readonly exists: boolean;
  readonly recoveryValue?: string;
}

export interface ProjectEntrypointValues {
  readonly environment?: string;
  readonly local?: string;
  readonly project?: string;
}

interface ConfiguredEntrypointCandidate {
  readonly source: Exclude<ProjectEntrypointSource, 'conventional discovery'>;
  readonly value: string;
}

/** Conventional authoring entrypoint filenames, in resolution order (matches `init` scaffolding). */
export const CONVENTIONAL_ENTRYPOINTS = [
  'src/server.ts',
  'server.ts',
  'manifest.ts',
  'index.ts',
] as const;

/** Resolve the first conventional authoring entrypoint that exists in `cwd`. */
export function resolveConventionalEntrypoint(cwd: string = process.cwd()): string | undefined {
  for (const name of CONVENTIONAL_ENTRYPOINTS) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function resolveConfiguredProjectEntrypoint(
  cwd: string,
  values: ProjectEntrypointValues,
): ProjectEntrypointResolution | undefined {
  const candidates = configuredCandidates(values);
  const selected = candidates[0];
  if (selected === undefined) return undefined;
  const path = resolve(cwd, selected.value);
  if (existsSync(path)) return { ...selected, path, exists: true };
  const recoveryValue = firstExistingEntrypointValue(cwd, candidates.slice(1));
  return {
    ...selected,
    path,
    exists: false,
    ...(recoveryValue === undefined ? {} : { recoveryValue }),
  };
}

export function resolveProjectEntrypoint(
  cwd: string,
  values: ProjectEntrypointValues,
): ProjectEntrypointResolution | undefined {
  const configured = resolveConfiguredProjectEntrypoint(cwd, values);
  if (configured !== undefined) return configured;
  for (const value of CONVENTIONAL_ENTRYPOINTS) {
    const path = resolve(cwd, value);
    if (existsSync(path)) {
      return { source: 'conventional discovery', value, path, exists: true };
    }
  }
  return undefined;
}

function configuredCandidates(
  values: ProjectEntrypointValues,
): readonly ConfiguredEntrypointCandidate[] {
  const candidates: ConfiguredEntrypointCandidate[] = [];
  if (values.environment !== undefined) {
    candidates.push({ source: 'NOODLE_ENTRYPOINT', value: values.environment });
  }
  if (values.local !== undefined) {
    candidates.push({ source: '.noodle/project.json', value: values.local });
  }
  if (values.project !== undefined) {
    candidates.push({ source: 'noodle.json', value: values.project });
  }
  return candidates;
}

function firstExistingEntrypointValue(
  cwd: string,
  candidates: readonly ConfiguredEntrypointCandidate[],
): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(resolve(cwd, candidate.value))) return candidate.value;
  }
  for (const value of CONVENTIONAL_ENTRYPOINTS) {
    if (existsSync(resolve(cwd, value))) return value;
  }
  return undefined;
}
