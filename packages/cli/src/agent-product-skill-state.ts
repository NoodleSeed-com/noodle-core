import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AgentTarget,
  contentSha256,
  createProductSkillState,
  decodeProductSkillState,
  type ProductSkillState,
} from '@noodle-borg/agent-kit';
import {
  agentSkillRoot,
  assertProjectPathSafe,
  atomicWriteProjectFile,
} from './agent-skills-state.js';

export type { ProductSkillState };
export { createProductSkillState };

export type ProductSkillStateRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'valid';
      readonly state: ProductSkillState;
      readonly migrationRequired: boolean;
    };

export function productSkillStatePath(target: AgentTarget): string {
  return `${agentSkillRoot(target)}/.noodle-app-package.json`;
}

export function readProductSkillState(project: string, target: AgentTarget): ProductSkillStateRead {
  const relativePath = productSkillStatePath(target);
  assertProjectPathSafe(project, relativePath);
  const path = join(project, relativePath);
  if (!existsSync(path)) return { kind: 'absent' };
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const decoded = decodeProductSkillState(value, target);
    return decoded === undefined ? { kind: 'invalid' } : { kind: 'valid', ...decoded };
  } catch {
    return { kind: 'invalid' };
  }
}

export function writeProductSkillState(project: string, state: ProductSkillState): void {
  const path = productSkillStatePath(state.target);
  assertProjectPathSafe(project, path);
  atomicWriteProjectFile(join(project, path), `${JSON.stringify(state, null, 2)}\n`);
}

export function removeProductSkillState(project: string, target: AgentTarget): void {
  const path = productSkillStatePath(target);
  assertProjectPathSafe(project, path);
  rmSync(join(project, path), { force: true });
}

export function removeProductSkillFiles(input: {
  readonly project: string;
  readonly target: AgentTarget;
  readonly paths: readonly string[];
}): void {
  assertProductSkillPathsSafe(input);
  for (const path of input.paths) rmSync(join(input.project, path), { force: true });
  const root = agentSkillRoot(input.target);
  const directories = new Set(
    input.paths.flatMap((path) => {
      const parents: string[] = [];
      let current = dirname(path);
      while (current !== root && current.startsWith(`${root}/`)) {
        parents.push(current);
        current = dirname(current);
      }
      return parents;
    }),
  );
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(join(input.project, directory));
    } catch (cause) {
      if (!isFilesystemCode(cause, 'ENOENT') && !isFilesystemCode(cause, 'ENOTEMPTY')) throw cause;
    }
  }
}

export function assertProductSkillPathsSafe(input: {
  readonly project: string;
  readonly target: AgentTarget;
  readonly paths: readonly string[];
}): void {
  assertProjectPathSafe(input.project, agentSkillRoot(input.target));
  assertProjectPathSafe(input.project, productSkillStatePath(input.target));
  for (const path of input.paths) {
    if (!isTargetFilePath(input.target, path)) {
      throw new Error(`invalid app product skill path: ${path}`);
    }
    assertProjectPathSafe(input.project, path);
  }
}

/** Files under the app skill directory that are not declared by its ownership record are conflicts. */
export function unexpectedProductSkillPaths(input: {
  readonly project: string;
  readonly target: AgentTarget;
  readonly skillSlug: string;
  readonly expectedPaths: readonly string[];
}): readonly string[] {
  const root = `${agentSkillRoot(input.target)}/${input.skillSlug}`;
  assertProjectPathSafe(input.project, root);
  const fullRoot = join(input.project, root);
  if (!existsSync(fullRoot)) return [];
  const expected = new Set(input.expectedPaths);
  return collectFiles(fullRoot, root).filter((path) => !expected.has(path));
}

export function inspectProductSkillStateFiles(
  project: string,
  state: ProductSkillState,
): { readonly missing: boolean; readonly modified: boolean } {
  let missing = false;
  let modified = false;
  for (const file of state.files) {
    const path = join(project, file.path);
    if (!existsSync(path)) {
      missing = true;
      continue;
    }
    const content = readFileSync(path, 'utf8');
    if (
      contentSha256(content) !== file.sha256 ||
      Buffer.byteLength(content, 'utf8') !== file.byteLength
    ) {
      modified = true;
    }
  }
  return { missing, modified };
}

function collectFiles(fullDir: string, relativeDir: string): readonly string[] {
  const stats = lstatSync(fullDir);
  if (stats.isSymbolicLink()) throw new Error(`refusing app skill symbolic link: ${fullDir}`);
  if (!stats.isDirectory()) return [relativeDir];
  const files: string[] = [];
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    const full = join(fullDir, entry.name);
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`refusing app skill symbolic link: ${full}`);
    if (entry.isDirectory()) files.push(...collectFiles(full, relative));
    else files.push(relative);
  }
  return files;
}

function isTargetFilePath(target: AgentTarget, path: string): boolean {
  const root = `${agentSkillRoot(target)}/`;
  return (
    path.startsWith(root) &&
    path !== productSkillStatePath(target) &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFilesystemCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}
