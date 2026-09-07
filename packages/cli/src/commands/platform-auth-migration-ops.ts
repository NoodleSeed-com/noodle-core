import {
  type PlatformAuthOperationPreview,
  PlatformAuthOperationPreviewClientResponseSchema,
  type PlatformAuthOperationResult,
  PlatformAuthOperationResultClientResponseSchema,
  PlatformAuthOperatorClientResponseSchema,
  type PlatformAuthOperatorSnapshot,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  type PlatformAuthMigrationArgs,
  parsePlatformAuthMigrationArgs,
} from './platform-auth-migration-args.js';
import {
  type PlatformAuthRolloutAccelerationApprovalFile,
  readPlatformAuthRolloutAccelerationApprovalFile,
} from './platform-auth-rollout-acceleration-files.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

export async function runPlatformAuthMigration(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parsePlatformAuthMigrationArgs(rest);
  const json = rest.includes('--json');
  if (!parsed.ok) return printCliFailure('platform-auth migration', parsed.error, json);
  const args = parsed.args;
  if (isMutation(args) && !args.yes) {
    return printCliFailure('platform-auth migration', confirmationRequired(args.action), args.json);
  }
  let accelerationApproval: PlatformAuthRolloutAccelerationApprovalFile | undefined;
  const approvalFile = accelerationApprovalPath(args);
  if (approvalFile !== undefined) {
    try {
      accelerationApproval = await readPlatformAuthRolloutAccelerationApprovalFile(approvalFile);
    } catch {
      return printCliFailure('platform-auth migration', invalidAccelerationApproval(), args.json);
    }
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('platform-auth migration', authRequired(), args.json);
  }
  const root = `${resolved.serviceUrl}/v1/platform-auth/migration`;
  try {
    if (args.action === 'inventory' || args.action === 'status') {
      const url =
        args.action === 'inventory' && args.generation > 0
          ? `${root}/inventory?generation=${args.generation}`
          : `${root}/${args.action}`;
      const response = PlatformAuthOperatorClientResponseSchema.parse(
        await serviceJson<unknown>(url, resolved.token, { redirect: 'manual' }),
      );
      printSuccess(resolved.serviceUrl, response.data, args.json, args);
      return args.action === 'status' && terminalSnapshot(response.data) ? EXIT.FAILURE : EXIT.OK;
    }
    if (args.action === 'preview') {
      const response = PlatformAuthOperationPreviewClientResponseSchema.parse(
        await serviceJson<unknown>(`${root}/preview`, resolved.token, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(previewBody(args, accelerationApproval)),
        }),
      );
      printPreview(resolved.serviceUrl, response.data, args.json);
      return response.data.ready ? EXIT.OK : EXIT.FAILURE;
    }
    if (!isMutation(args)) throw new InvalidServiceResponseError();
    const response = PlatformAuthOperationResultClientResponseSchema.parse(
      await serviceJson<unknown>(`${root}/${args.action}`, resolved.token, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mutationBody(args, accelerationApproval)),
      }),
    );
    if (response.data.operation !== operationForAction(args.action)) {
      throw new InvalidServiceResponseError();
    }
    printResult(resolved.serviceUrl, response.data, args.json);
    return terminalResult(response.data) ? EXIT.FAILURE : EXIT.OK;
  } catch (error) {
    const failure =
      isSchemaError(error) || error instanceof InvalidServiceResponseError
        ? invalidResponse()
        : platformAuthServiceFailure(error);
    return printCliFailure(
      'platform-auth migration',
      redactFailure(failure, privateValues(args)),
      args.json,
    );
  }
}

function previewBody(
  args: Extract<PlatformAuthMigrationArgs, { readonly action: 'preview' }>,
  accelerationApproval: PlatformAuthRolloutAccelerationApprovalFile | undefined,
) {
  if (args.operation === 'reconcile' || args.operation === 'recover_outbox') {
    return { schemaVersion: 1, operation: args.operation, batchSize: args.batchSize };
  }
  if (args.operation === 'activate') {
    return {
      schemaVersion: 1,
      operation: args.operation,
      percentage: args.percentage,
      cohortMode: args.cohortMode,
      ...(accelerationApproval === undefined ? {} : { accelerationApproval }),
      ...(args.cohortMode === 'replace'
        ? {
            canaryClientIds: args.canaryClientIds,
            recoveryClientIds: args.recoveryClientIds,
          }
        : {}),
    };
  }
  if (args.operation === 'finalize') {
    return {
      schemaVersion: 1,
      operation: args.operation,
      rollbackRehearsalChecksum: args.rollbackRehearsalChecksum,
      stagingWorkosOnlySmokeChecksum: args.stagingWorkosOnlySmokeChecksum,
    };
  }
  return { schemaVersion: 1, operation: args.operation };
}

function mutationBody(
  args: Exclude<PlatformAuthMigrationArgs, { readonly action: 'inventory' | 'status' | 'preview' }>,
  accelerationApproval: PlatformAuthRolloutAccelerationApprovalFile | undefined,
) {
  return {
    schemaVersion: 1,
    expectedGeneration: args.expectedGeneration,
    releaseSha: args.releaseSha,
    previewChecksum: args.previewChecksum,
    idempotencyKey: args.idempotencyKey,
    reason: args.reason,
    confirmed: true,
    ...(args.action === 'reconcile' || args.action === 'recover-outbox'
      ? { batchSize: args.batchSize }
      : {}),
    ...(args.action === 'activate'
      ? {
          percentage: args.percentage,
          cohortMode: args.cohortMode,
          ...(accelerationApproval === undefined ? {} : { accelerationApproval }),
          ...(args.cohortMode === 'replace'
            ? {
                canaryClientIds: args.canaryClientIds,
                recoveryClientIds: args.recoveryClientIds,
              }
            : {}),
        }
      : {}),
    ...(args.action === 'finalize'
      ? {
          rollbackRehearsalChecksum: args.rollbackRehearsalChecksum,
          stagingWorkosOnlySmokeChecksum: args.stagingWorkosOnlySmokeChecksum,
        }
      : {}),
  };
}

function printSuccess(
  service: string,
  result: PlatformAuthOperatorSnapshot,
  json: boolean,
  args: Extract<PlatformAuthMigrationArgs, { readonly action: 'inventory' | 'status' }>,
): void {
  if (json) {
    printJsonOk({ service, migration: result });
    return;
  }
  console.log(`Platform authentication migration: ${snapshotOutcome(result).toUpperCase()}`);
  console.log(`Inventory: ${result.inventory.state.toUpperCase()}`);
  if (result.inventory.phase !== null) {
    console.log(`Inventory phase: ${result.inventory.phase.toUpperCase()}`);
  }
  console.log(`WorkOS pages read: ${result.inventory.remotePages}`);
  console.log(`WorkOS users read: ${result.inventory.remoteUsers}`);
  console.log(`Local subjects frozen: ${result.inventory.localSubjects}`);
  console.log(`Rollout: ${result.rollout.lifecycle}/${result.rollout.workosPercentage}%`);
  console.log(`Generation: ${result.rollout.generation}`);
  console.log(`Candidates frozen: ${result.inventory.candidateCount}`);
  console.log(`Imported: ${result.import.linked}/${result.import.total}`);
  printRemoteVerification(result.remoteVerification);
  printNextAction(result, args);
}

function printPreview(service: string, result: PlatformAuthOperationPreview, json: boolean): void {
  if (json) {
    printJsonOk({ service, migration: result });
    return;
  }
  console.log(
    `Platform authentication ${result.operation} preview: ${result.ready ? 'READY' : 'BLOCKED'}`,
  );
  console.log(`Generation: ${result.rollout.generation}`);
  console.log(`Candidates: ${result.inventory.candidateCount}`);
  console.log(`Blockers: ${result.blockers.length}`);
  for (const blocker of result.blockers) console.log(`  [${blocker.code}] ${blocker.count}`);
  console.log('No changes were made.');
}

function printResult(service: string, result: PlatformAuthOperationResult, json: boolean): void {
  if (json) {
    printJsonOk({ service, migration: result });
    return;
  }
  const outcome = resultOutcome(result);
  console.log(`Platform authentication ${result.operation}: ${outcome.toUpperCase()}`);
  if (result.replayed) console.log('Replay: YES');
  console.log(`Migration state: ${result.import.state.toUpperCase()}`);
  console.log(`Rollout: ${result.rollout.lifecycle}/${result.rollout.workosPercentage}%`);
  console.log(`Generation: ${result.rollout.generation}`);
  console.log(`Imported: ${result.import.linked}/${result.import.total}`);
  printRemoteVerification(result.remoteVerification);
  const recovery = recoveryBatch(result.batch);
  const migration = migrationBatch(result.batch);
  if (recovery !== undefined) {
    console.log(`Recovery attempted: ${recovery.attempted}`);
    console.log(`Recovered: ${recovery.recovered}`);
    console.log(`Rejected: ${recovery.rejected}`);
  } else if (migration !== undefined) {
    console.log(`Reconciled: ${migration.attempted}`);
    console.log(`Retry required: ${migration.retryRequired}`);
  }
}

function resultOutcome(
  result: PlatformAuthOperationResult,
): 'failed' | 'blocked' | 'completed' | 'processed' | 'running' {
  const recovery = recoveryBatch(result.batch);
  const migration = migrationBatch(result.batch);
  if (recovery !== undefined && recovery.rejected > 0) return 'blocked';
  if (result.import.state === 'failed' || result.import.failed > 0 || (migration?.failed ?? 0) > 0)
    return 'failed';
  if (result.import.blocked > 0 || (migration?.blocked ?? 0) > 0) return 'blocked';
  if (
    result.import.state === 'completed' &&
    (result.remoteVerification.state === 'blocked' ||
      result.remoteVerification.state === 'not_configured')
  ) {
    return 'blocked';
  }
  if (result.import.state === 'completed' && result.remoteVerification.state === 'ready') {
    return 'completed';
  }
  if ((result.batch?.attempted ?? 0) > 0) return 'processed';
  return 'running';
}

function terminalResult(result: PlatformAuthOperationResult): boolean {
  const outcome = resultOutcome(result);
  return outcome === 'failed' || outcome === 'blocked';
}

function snapshotOutcome(
  result: PlatformAuthOperatorSnapshot,
): 'unavailable' | 'failed' | 'blocked' | 'completed' | 'running' | 'not_started' {
  if (result.inventory.state === 'unavailable') return 'unavailable';
  if (result.inventory.state === 'blocked') return 'blocked';
  if (result.inventory.state === 'running') return 'running';
  if (result.import.state === 'failed' || result.import.failed > 0) return 'failed';
  if (result.import.blocked > 0) return 'blocked';
  if (result.import.state !== 'completed') return result.import.state;
  if (
    result.remoteVerification.state === 'blocked' ||
    result.remoteVerification.state === 'not_configured'
  ) {
    return 'blocked';
  }
  return result.remoteVerification.state === 'ready' ? 'completed' : 'running';
}

function terminalSnapshot(result: PlatformAuthOperatorSnapshot): boolean {
  const outcome = snapshotOutcome(result);
  return outcome === 'unavailable' || outcome === 'failed' || outcome === 'blocked';
}

function printRemoteVerification(
  progress: PlatformAuthOperatorSnapshot['remoteVerification'],
): void {
  console.log(`Remote verification: ${progress.state.toUpperCase()}`);
  console.log(`Remote checks completed: ${progress.checkedCount}/${progress.candidateCount}`);
  console.log(`Remote identities verified: ${progress.verifiedCount}`);
  if (progress.retryAt !== null) console.log(`Remote retry at: ${progress.retryAt}`);
}

function printNextAction(
  result: PlatformAuthOperatorSnapshot,
  args: Extract<PlatformAuthMigrationArgs, { readonly action: 'inventory' | 'status' }>,
): void {
  if (result.inventory.state === 'running') {
    console.log(
      args.action === 'inventory'
        ? `Next: noodle platform-auth migration inventory --generation ${args.generation}`
        : 'Next: repeat the inventory command with its original --generation value.',
    );
    return;
  }
  if (result.inventory.state === 'blocked') {
    console.log('Next: resolve every inventory blocker, then start a new inventory generation.');
    return;
  }
  if (result.inventory.state === 'unavailable') {
    console.log('Next: inspect the inventory dependency and persisted generation before retrying.');
    return;
  }
  if (result.import.state === 'not_started') {
    console.log('Next: preview start_import, then start the import from this frozen inventory.');
    return;
  }
  if (result.import.state === 'failed' || result.import.blocked > 0) {
    console.log('Next: repair the reported import blocker, then preview another reconcile batch.');
    return;
  }
  if (result.import.state === 'running') {
    const timing = result.import.nextRetryAt === null ? '' : ` after ${result.import.nextRetryAt}`;
    console.log(`Next: preview and run another reconcile batch${timing}.`);
    return;
  }
  const remote = result.remoteVerification;
  if (remote.state === 'not_configured') {
    console.log('Next: configure remote verification before activating WorkOS.');
  } else if (remote.state === 'not_started' || remote.state === 'running') {
    console.log('Next: preview and run another reconcile batch.');
  } else if (remote.state === 'blocked' && remote.retryAt !== null) {
    console.log(
      `Next: wait until ${remote.retryAt}, then preview and run another reconcile batch.`,
    );
  } else if (remote.state === 'blocked') {
    console.log('Next: repair the remote mismatch, then preview another reconcile batch.');
  } else if (result.rollout.lifecycle !== 'finalized') {
    console.log('Next: run a fresh preview for the intended rollout operation.');
  }
}

function isMutation(
  args: PlatformAuthMigrationArgs,
): args is Exclude<
  PlatformAuthMigrationArgs,
  { readonly action: 'inventory' | 'status' | 'preview' }
> {
  return args.action !== 'inventory' && args.action !== 'status' && args.action !== 'preview';
}

function operationForAction(action: PlatformAuthMigrationArgs['action']): string {
  if (action === 'start-import') return 'start_import';
  return action === 'recover-outbox' ? 'recover_outbox' : action;
}

interface RecoveryBatch {
  readonly attempted: number;
  readonly recovered: number;
  readonly rejected: number;
}

interface MigrationBatch {
  readonly attempted: number;
  readonly blocked: number;
  readonly failed: number;
  readonly retryRequired: number;
}

function recoveryBatch(batch: PlatformAuthOperationResult['batch']): RecoveryBatch | undefined {
  return batch !== null && 'recovered' in batch ? (batch as unknown as RecoveryBatch) : undefined;
}

function migrationBatch(batch: PlatformAuthOperationResult['batch']): MigrationBatch | undefined {
  return batch !== null && !('recovered' in batch)
    ? (batch as unknown as MigrationBatch)
    : undefined;
}

function confirmationRequired(action: string): CliFailure {
  return {
    code: 'confirmation_required',
    message: `platform-auth migration ${action} requires confirmation`,
    cause: 'This operation changes durable platform authentication migration state.',
    fix: 'Review a fresh aggregate-only preview, then re-run with --yes.',
    next: `noodle platform-auth migration ${action} <evidence flags> --yes`,
    exitCode: EXIT.USAGE,
  };
}

function invalidResponse(): CliFailure {
  return {
    code: 'invalid_service_response',
    message: 'The service returned an invalid platform-auth migration response.',
    cause: 'The response did not match the strict aggregate-only schema.',
    fix: 'Confirm the CLI and service belong to the same System Release.',
    next: 'noodle platform-auth migration status --json',
    exitCode: EXIT.FAILURE,
  };
}

function invalidAccelerationApproval(): CliFailure {
  return {
    code: 'invalid_acceleration_approval',
    message: 'The rollout acceleration approval file is invalid.',
    cause: 'The file must be a mode-0600 regular non-symlink JSON file with exact typed evidence.',
    fix: 'Create a fresh approval for the exact release, generation, and stage transition.',
    next: 'noodle platform-auth migration status --json',
    exitCode: EXIT.USAGE,
  };
}

function platformAuthServiceFailure(error: unknown): CliFailure {
  const base = serviceFailure(
    'platform-auth migration',
    error,
    'noodle platform-auth migration status --json',
  );
  return error instanceof ServiceRequestError && error.code !== undefined
    ? { ...base, code: error.code }
    : base;
}

function privateValues(args: PlatformAuthMigrationArgs): readonly string[] {
  if (args.action === 'preview') {
    return args.operation === 'activate'
      ? [
          ...(args.accelerationApprovalFile === undefined ? [] : [args.accelerationApprovalFile]),
          ...(args.cohortMode === 'replace'
            ? [...args.canaryClientIds, ...args.recoveryClientIds]
            : []),
        ]
      : [];
  }
  if (!isMutation(args)) return [];
  return [
    args.idempotencyKey,
    args.reason,
    ...(args.action === 'activate' && args.accelerationApprovalFile !== undefined
      ? [args.accelerationApprovalFile]
      : []),
    ...(args.action === 'activate' && args.cohortMode === 'replace'
      ? [...args.canaryClientIds, ...args.recoveryClientIds]
      : []),
  ];
}

function accelerationApprovalPath(args: PlatformAuthMigrationArgs): string | undefined {
  if (args.action === 'activate') return args.accelerationApprovalFile;
  return args.action === 'preview' && args.operation === 'activate'
    ? args.accelerationApprovalFile
    : undefined;
}

function redactFailure(failure: CliFailure, values: readonly string[]): CliFailure {
  const redact = (value: string): string =>
    values.reduce(
      (result, privateValue) =>
        privateValue.length === 0 ? result : result.split(privateValue).join('[redacted]'),
      value,
    );
  return {
    ...failure,
    code: redact(failure.code),
    message: redact(failure.message),
    cause: redact(failure.cause),
    fix: redact(failure.fix),
    next: redact(failure.next),
    ...(failure.requestId === undefined ? {} : { requestId: redact(failure.requestId) }),
  };
}

function isSchemaError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ZodError';
}

class InvalidServiceResponseError extends Error {}
