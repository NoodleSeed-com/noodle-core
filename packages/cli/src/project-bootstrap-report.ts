import { z } from 'zod';
import type { NextCommand } from './commands/output.js';
import { BOOTSTRAP_STAGES, bootstrapFailureSchema } from './project-bootstrap-state.js';

/** Shared, bounded progress projection: no customer values, child logs, or arbitrary commands. */
export const bootstrapStatusSchema = z
  .object({
    ready: z.boolean(),
    packageManager: z.enum(['npm', 'pnpm', 'yarn']),
    completed: z.array(z.enum(BOOTSTRAP_STAGES)).max(BOOTSTRAP_STAGES.length).readonly(),
    failed: bootstrapFailureSchema.optional(),
    restartRequired: z.boolean(),
    proof: z.enum(['local-synthetic', 'unverified']),
  })
  .refine(
    (status) =>
      new Set(status.completed).size === status.completed.length &&
      (!status.failed || !status.completed.includes(status.failed.stage)) &&
      (status.ready
        ? status.proof === 'local-synthetic' &&
          ['scaffold', 'install', 'validate', 'behavior', 'types'].every((stage) =>
            status.completed.some((value) => value === stage),
          ) &&
          !status.failed
        : status.proof === 'unverified'),
  );
export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>;
export interface BootstrapReport extends BootstrapStatus {
  readonly resumeCommand: string;
  readonly nextSteps: readonly NextCommand[];
}

/** A zero exit code alone is not the CLI's machine-readable success contract. */
export function bootstrapJsonSucceeded(stdout: string): boolean {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === 'object' && value !== null && 'ok' in value && value.ok === true;
  } catch {
    return false;
  }
}
