import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type AgentTarget, contentSha256 } from '@noodle-borg/agent-kit';

export interface ManagedSkillFileInput {
  readonly path: string;
  readonly content: string;
  readonly skill: string;
  readonly skillVersion: string;
}

export interface ManagedSkillFileAction {
  readonly path: string;
  readonly target: AgentTarget;
  readonly action: 'created' | 'unchanged' | 'overwritten' | 'removed' | 'skipped';
  readonly reason?: 'user-edited-removed-generated-file';
}

interface ManagedSkillStateFile {
  readonly path: string;
  readonly sha256: string;
  readonly skill: string;
  readonly skillVersion: string;
}

export interface ManagedSkillState {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly target: AgentTarget;
  readonly files: readonly ManagedSkillStateFile[];
}

function managedSkillsStatePath(target: AgentTarget): string {
  return `${agentSkillRoot(target)}/.noodle-managed.json`;
}

export function assertManagedSkillFilesSafe(input: {
  readonly project: string;
  readonly target: AgentTarget;
  readonly files: readonly Pick<ManagedSkillFileInput, 'path'>[];
}): void {
  assertProjectPathSafe(input.project, agentSkillRoot(input.target));
  assertProjectPathSafe(input.project, managedSkillsStatePath(input.target));
  for (const file of input.files) {
    if (!isOwnedPath(input.target, file.path)) {
      throw new Error(`invalid managed skill path: ${file.path}`);
    }
    assertProjectPathSafe(input.project, file.path);
  }
}

export function reconcileManagedSkillFiles(input: {
  readonly project: string;
  readonly target: AgentTarget;
  readonly packageVersion: string;
  readonly files: readonly ManagedSkillFileInput[];
  readonly write: boolean;
}): readonly ManagedSkillFileAction[] {
  const files = validateInputs(input.target, input.files);
  if (input.write) {
    assertManagedSkillFilesSafe({
      project: input.project,
      target: input.target,
      files,
    });
  }
  const nextPaths = new Set(files.map((file) => file.path));
  const previous = readState(input.project, input.target);
  if (input.write && previous !== undefined) {
    for (const file of previous.files) assertProjectPathSafe(input.project, file.path);
  }
  const actions: ManagedSkillFileAction[] = files.map((file) => {
    const full = join(input.project, file.path);
    const existing = existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    return {
      path: file.path,
      target: input.target,
      action:
        existing === undefined
          ? 'created'
          : existing === file.content
            ? 'unchanged'
            : 'overwritten',
    };
  });
  const removable: string[] = [];
  for (const file of previous?.files ?? []) {
    if (nextPaths.has(file.path) || !isOwnedPath(input.target, file.path)) continue;
    const full = join(input.project, file.path);
    if (!existsSync(full)) continue;
    if (contentSha256(readFileSync(full, 'utf8')) === file.sha256) {
      removable.push(file.path);
      actions.push({ path: file.path, target: input.target, action: 'removed' });
    } else {
      actions.push({
        path: file.path,
        target: input.target,
        action: 'skipped',
        reason: 'user-edited-removed-generated-file',
      });
    }
  }
  if (!input.write) return actions;
  for (const file of files) {
    const action = actions.find((candidate) => candidate.path === file.path)?.action;
    if (action !== 'unchanged')
      atomicWriteProjectFile(join(input.project, file.path), file.content);
  }
  for (const path of removable) rmSync(join(input.project, path), { force: true });
  const state: ManagedSkillState = {
    schemaVersion: 1,
    packageVersion: input.packageVersion,
    target: input.target,
    files: files.map((file) => ({
      path: file.path,
      sha256: contentSha256(file.content),
      skill: file.skill,
      skillVersion: file.skillVersion,
    })),
  };
  atomicWriteProjectFile(
    join(input.project, managedSkillsStatePath(input.target)),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return actions;
}

export function readManagedSkillState(
  project: string,
  target: AgentTarget,
): ManagedSkillState | undefined {
  return readState(project, target);
}

function validateInputs(
  target: AgentTarget,
  files: readonly ManagedSkillFileInput[],
): readonly ManagedSkillFileInput[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (!isOwnedPath(target, file.path) || paths.has(file.path)) {
      throw new Error(`invalid or duplicate managed skill path: ${file.path}`);
    }
    if (!file.path.startsWith(`${agentSkillRoot(target)}/${file.skill}/`)) {
      throw new Error(`managed skill identity does not match path: ${file.path}`);
    }
    paths.add(file.path);
  }
  return files;
}

function readState(project: string, target: AgentTarget): ManagedSkillState | undefined {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(project, managedSkillsStatePath(target)), 'utf8'),
    );
    if (!isRecord(value) || value.schemaVersion !== 1 || value.target !== target) return undefined;
    if (typeof value.packageVersion !== 'string' || !Array.isArray(value.files)) return undefined;
    const files: ManagedSkillStateFile[] = [];
    const paths = new Set<string>();
    for (const file of value.files) {
      if (
        !isRecord(file) ||
        typeof file.path !== 'string' ||
        typeof file.sha256 !== 'string' ||
        typeof file.skill !== 'string' ||
        typeof file.skillVersion !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !isOwnedPath(target, file.path) ||
        paths.has(file.path)
      ) {
        return undefined;
      }
      paths.add(file.path);
      files.push({
        path: file.path,
        sha256: file.sha256,
        skill: file.skill,
        skillVersion: file.skillVersion,
      });
    }
    return { schemaVersion: 1, packageVersion: value.packageVersion, target, files };
  } catch {
    return undefined;
  }
}

export function atomicWriteProjectFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export function assertProjectPathSafe(project: string, relativePath: string): void {
  const absoluteProject = resolve(project);
  const segments = relativePath.split('/');
  let current = absoluteProject;
  for (let index = 0; index <= segments.length; index += 1) {
    const stats = lstatIfPresent(current);
    if (stats?.isSymbolicLink()) {
      throw new Error(`refusing managed skill path with symbolic link: ${current}`);
    }
    if (index < segments.length && stats !== undefined && !stats.isDirectory()) {
      throw new Error(`refusing managed skill path with non-directory ancestor: ${current}`);
    }
    if (index < segments.length) current = join(current, segments[index] ?? '');
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function agentSkillRoot(target: AgentTarget): string {
  return target === 'codex' ? '.agents/skills' : '.claude/skills';
}

function isOwnedPath(target: AgentTarget, path: string): boolean {
  const prefix = `${agentSkillRoot(target)}/`;
  return (
    path.startsWith(prefix) &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    path !== managedSkillsStatePath(target)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
