import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const BOOTSTRAP_STAGES = [
  'scaffold',
  'install',
  'context',
  'validate',
  'behavior',
  'types',
  'launch',
] as const;
export type BootstrapStage = (typeof BOOTSTRAP_STAGES)[number];
const stageSchema = z.enum(BOOTSTRAP_STAGES);
export const bootstrapFailureSchema = z.strictObject({
  stage: stageSchema,
  code: z.enum([
    'command_failed',
    'command_timeout',
    'missing_executable',
    'context_invalid',
    'verification_failed',
    'dependency_mismatch',
    'configuration_conflict',
    'package_manager_unsupported',
    'cancelled',
  ]),
});
const versionSchema = z
  .string()
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/);
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    cliVersion: versionSchema,
    packageManager: z.enum(['npm', 'pnpm', 'yarn']),
    managerVersion: versionSchema.optional(),
    launchedAgent: z.enum(['codex', 'claude-code']).optional(),
    completed: z.array(stageSchema).max(BOOTSTRAP_STAGES.length),
    inProgress: stageSchema.optional(),
    failed: bootstrapFailureSchema.optional(),
    dependencyFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (state) =>
      new Set(state.completed).size === state.completed.length &&
      (!state.inProgress || !state.completed.includes(state.inProgress)) &&
      (!state.failed || !state.completed.includes(state.failed.stage)),
  );
export type BootstrapState = Readonly<Omit<z.infer<typeof stateSchema>, 'completed'>> & {
  readonly completed: readonly BootstrapStage[];
};
const MAX_STATE_BYTES = 16 * 1024;
const stateError = () =>
  new Error('Bootstrap state is unreadable or not owned by this setup format.');

function stateDirectory(project: string): string {
  const path = join(project, '.noodle');
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw stateError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw stateError();
  }
  return path;
}

export function readBootstrapState(project: string): BootstrapState | undefined {
  let descriptor: number | undefined;
  try {
    const path = join(stateDirectory(project), 'setup.json');
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw stateError();
    }
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw stateError();
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_STATE_BYTES) throw stateError();
    const parsed = stateSchema.safeParse(JSON.parse(buffer.subarray(0, length).toString('utf8')));
    if (!parsed.success) throw stateError();
    return parsed.data;
  } catch {
    throw stateError();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeBootstrapState(project: string, state: BootstrapState): void {
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) throw stateError();
  // A malformed/unowned existing record is never treated as permission to replace it.
  readBootstrapState(project);
  const directory = stateDirectory(project);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.setup-${randomBytes(12).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(directory, 'setup.json'));
  } catch {
    throw stateError();
  } finally {
    rmSync(temporary, { force: true });
  }
}
