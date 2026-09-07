import { z } from 'zod';

export const BUILD_READINESS_SCHEMA_VERSION = 1 as const;

export const BUILD_STAGES = [
  'project',
  'validate',
  'test',
  'target-check',
  'preview',
  'deploy',
] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

export const BUILD_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type BuildRunStatus = (typeof BUILD_RUN_STATUSES)[number];

export type BuildFindingSeverity = 'info' | 'warning' | 'error';

export interface BuildFinding {
  readonly code: string;
  readonly severity: BuildFindingSeverity;
  readonly message: string;
  readonly relativePath?: string | undefined;
  readonly schemaPath?: string | undefined;
}

export interface BuildRunState {
  readonly runId: string;
  readonly stage: BuildStage;
  readonly status: BuildRunStatus;
  readonly sourceFingerprint?: string | undefined;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly finishedAt?: string | undefined;
}

export interface BuildReadinessSnapshot {
  readonly schemaVersion: typeof BUILD_READINESS_SCHEMA_VERSION;
  readonly workspaceHandle: string;
  readonly workspaceDigest: string;
  readonly updatedAt: string;
  readonly runs: readonly BuildRunState[];
  readonly findings?: readonly BuildFinding[] | undefined;
}

const opaqueHandleSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
const runIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]{22,128}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const safeRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\') && !value.includes('..'), {
    message: 'finding path must be project-relative',
  });

const findingSchema = z
  .strictObject({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    severity: z.enum(['info', 'warning', 'error']),
    message: z.string().min(1).max(500),
    relativePath: safeRelativePathSchema.optional(),
    schemaPath: z.string().min(1).max(240).optional(),
  })
  .superRefine((finding, context) => {
    if (containsSensitiveText(finding.message)) {
      context.addIssue({
        code: 'custom',
        message: 'finding contains sensitive or secret-shaped text',
      });
    }
  });

const runSchema = z
  .strictObject({
    runId: runIdSchema,
    stage: z.enum(BUILD_STAGES),
    status: z.enum(BUILD_RUN_STATUSES),
    sourceFingerprint: digestSchema.optional(),
    startedAt: timestampSchema,
    heartbeatAt: timestampSchema,
    finishedAt: timestampSchema.optional(),
  })
  .superRefine((run, context) => {
    const terminal = isTerminalBuildRunStatus(run.status);
    if (terminal && run.finishedAt === undefined) {
      context.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt is required' });
    }
    if (!terminal && run.finishedAt !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt is terminal-only',
      });
    }
  });

const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(BUILD_READINESS_SCHEMA_VERSION),
  workspaceHandle: opaqueHandleSchema,
  workspaceDigest: digestSchema,
  updatedAt: timestampSchema,
  runs: z.array(runSchema).max(64),
  findings: z.array(findingSchema).max(32).optional(),
});

export function parseBuildReadinessSnapshot(value: unknown): BuildReadinessSnapshot {
  return snapshotSchema.parse(value);
}

export function isTerminalBuildRunStatus(status: BuildRunStatus): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

export function transitionBuildRun(
  current: BuildRunState,
  update: Pick<BuildRunState, 'status' | 'heartbeatAt'> & { readonly finishedAt?: string },
): BuildRunState {
  if (isTerminalBuildRunStatus(current.status) && update.status !== current.status) {
    throw new Error(`build run is terminal (${current.status})`);
  }
  if (!allowedTransition(current.status, update.status)) {
    throw new Error(`invalid build run transition: ${current.status} -> ${update.status}`);
  }
  return runSchema.parse({ ...current, ...update });
}

function allowedTransition(from: BuildRunStatus, to: BuildRunStatus): boolean {
  if (from === to) return true;
  if (from === 'queued') return to === 'running' || to === 'cancelled' || to === 'interrupted';
  if (from === 'running') return isTerminalBuildRunStatus(to);
  return false;
}

function containsSensitiveText(value: string): boolean {
  return /authorization\s*:|\bbearer\s+|\b(?:access|refresh|auth)[_-]?token\b|\bsk-[a-z0-9]{12,}\b/i.test(
    value,
  );
}
