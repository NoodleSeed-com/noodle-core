import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

export interface WorkspaceIdentity {
  readonly workspaceHandle: string;
  readonly workspaceDigest: `sha256:${string}`;
}

const ROOT_INPUTS = new Set([
  'noodle.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'yarn.lock',
]);
const INPUT_DIRECTORIES = new Set(['src', 'test', 'tests', 'views']);
const INPUT_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

export function resolveWorkspaceIdentity(root: string): WorkspaceIdentity {
  const canonical = resolveWorkspacePath(root);
  const bytes = createHash('sha256').update(canonical).digest();
  return {
    workspaceHandle: bytes.subarray(0, 18).toString('base64url'),
    workspaceDigest: `sha256:${bytes.toString('hex')}`,
  };
}

export async function fingerprintAuthoringInputs(root: string): Promise<`sha256:${string}`> {
  const canonicalRoot = await realpath(root);
  const files: string[] = [];
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      if (ROOT_INPUTS.has(entry.name) || INPUT_DIRECTORIES.has(entry.name)) {
        throw new Error(`authoring input must not be a symbolic link: ${entry.name}`);
      }
      continue;
    }
    if (entry.isFile() && ROOT_INPUTS.has(entry.name)) files.push(join(canonicalRoot, entry.name));
    if (entry.isDirectory() && INPUT_DIRECTORIES.has(entry.name)) {
      await collectInputFiles(canonicalRoot, join(canonicalRoot, entry.name), files);
    }
  }
  files.sort((left, right) =>
    relative(canonicalRoot, left).localeCompare(relative(canonicalRoot, right)),
  );
  const hash = createHash('sha256');
  for (const file of files) {
    const projectPath = relative(canonicalRoot, file).split(sep).join('/');
    hash.update(projectPath);
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function collectInputFiles(root: string, directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`authoring input must not be a symbolic link: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) {
      await collectInputFiles(root, path, files);
      continue;
    }
    if (entry.isFile() && INPUT_EXTENSIONS.has(extension(entry.name))) files.push(path);
  }
}

function extension(file: string): string {
  const dot = basename(file).lastIndexOf('.');
  return dot < 0 ? '' : file.slice(dot).toLowerCase();
}

function resolveWorkspacePath(root: string): string {
  const canonical = resolve(root);
  if (canonical.includes('\0')) throw new Error('workspace path contains a null byte');
  return canonical;
}
