import {
  AppPurgeReconciliationApplyRequestSchema,
  AppPurgeReconciliationClientResponseSchema,
  AppPurgeReconciliationErrorCodeSchema,
  AppPurgeReconciliationPreviewRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import {
  type AppPurgeReconciliationArgs,
  parseAppPurgeReconciliationArgs,
} from './app-purge-reconciliation-args.js';
import {
  readAppPurgeReconciliationPreview,
  validateAppPurgeReconciliationPreview,
  writeAppPurgeReconciliationPreview,
} from './app-purge-reconciliation-files.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, printCliFailure } from './shared.js';

const COMMAND = 'service app-purge';
const DEFINITE_APPLY_REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 415]);

export async function runAppPurgeReconciliation(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseAppPurgeReconciliationArgs(rest);
  const json = rest.includes('--json');
  if (!parsed.ok) return printCliFailure(COMMAND, parsed.error, json);
  const args = parsed.args;
  try {
    const resolved = await resolveControlPlaneToken({
      serviceFlag: args.service,
      authFlag: args.authToken,
      env,
      home,
    });
    if (resolved.token === undefined) return printCliFailure(COMMAND, authRequired(), args.json);
    const root = `${resolved.serviceUrl}/v1/service/app-purge-reconciliation`;
    return args.action === 'preview'
      ? await runPreview(args, root, resolved.token)
      : await runApply(args, root, resolved.token);
  } catch (error) {
    return printCliFailure(COMMAND, appPurgeFailure(error), args.json);
  }
}

async function runPreview(
  args: Extract<AppPurgeReconciliationArgs, { readonly action: 'preview' }>,
  root: string,
  token: string,
): Promise<number> {
  const request = AppPurgeReconciliationPreviewRequestSchema.parse({ schemaVersion: 1 });
  const response = AppPurgeReconciliationClientResponseSchema.parse(
    await serviceJson<unknown>(`${root}/preview`, token, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
  if (!('artifact' in response)) throw new Error('unexpected app purge response');
  const artifact = validateAppPurgeReconciliationPreview(response.artifact);
  await writeAppPurgeReconciliationPreview(args.output, artifact);
  const safe = {
    artifactPath: args.output,
    candidateCount: artifact.candidateCount,
    checksum: artifact.checksum,
    releaseSha: artifact.releaseSha,
    expiresAt: artifact.expiresAt,
    truncated: artifact.truncated,
  };
  if (args.json) printJsonOk({ appPurge: safe });
  else {
    console.log(`Preview artifact: ${safe.artifactPath}`);
    console.log(`Candidates: ${safe.candidateCount}`);
    console.log(`Checksum: ${safe.checksum}`);
    console.log(`Release SHA: ${safe.releaseSha}`);
    console.log(`Expires at: ${safe.expiresAt}`);
    console.log(`Truncated: ${safe.truncated}`);
  }
  return EXIT.OK;
}

async function runApply(
  args: Extract<AppPurgeReconciliationArgs, { readonly action: 'apply' }>,
  root: string,
  token: string,
): Promise<number> {
  const preview = await readAppPurgeReconciliationPreview(args.approvedPreview);
  if (preview.releaseSha !== args.releaseSha) {
    throw new Error('approved preview release does not match apply evidence');
  }
  const request = AppPurgeReconciliationApplyRequestSchema.parse({
    schemaVersion: 1,
    preview,
    releaseSha: args.releaseSha,
    approvalReference: args.approvalReference,
    recoveryCheckpoint: args.recoveryCheckpoint,
    reason: args.reason,
    idempotencyKey: args.idempotencyKey,
    confirmed: true,
  });
  let rawResponse: unknown;
  try {
    rawResponse = await serviceJson<unknown>(`${root}/apply`, token, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (
      error instanceof ServiceRequestError &&
      DEFINITE_APPLY_REJECTION_STATUSES.has(error.status)
    ) {
      throw error;
    }
    throw new AppPurgeApplyOutcomeUnknownError(
      !(error instanceof ServiceRequestError) || error.status === 0,
    );
  }
  let response: ReturnType<typeof AppPurgeReconciliationClientResponseSchema.parse>;
  try {
    response = AppPurgeReconciliationClientResponseSchema.parse(rawResponse);
    if (!('result' in response)) throw new Error('unexpected app purge response');
    if (
      response.result.previewChecksum !== preview.checksum ||
      response.result.releaseSha !== args.releaseSha ||
      response.result.candidateCount !== preview.candidateCount ||
      response.result.deletedCount !== preview.candidateCount
    ) {
      throw new Error('app purge result does not match the approved preview');
    }
  } catch {
    throw new AppPurgeApplyOutcomeUnknownError(false);
  }
  const safe = {
    operationId: response.result.operationId,
    previewChecksum: response.result.previewChecksum,
    releaseSha: response.result.releaseSha,
    candidateCount: response.result.candidateCount,
    deletedCount: response.result.deletedCount,
    appliedAt: response.result.appliedAt,
    replayed: response.replayed,
  };
  if (args.json) printJsonOk({ appPurge: safe });
  else {
    console.log(`Operation ID: ${safe.operationId}`);
    console.log(`Preview checksum: ${safe.previewChecksum}`);
    console.log(`Release SHA: ${safe.releaseSha}`);
    console.log(`Candidates: ${safe.candidateCount}`);
    console.log(`Deleted: ${safe.deletedCount}`);
    console.log(`Applied at: ${safe.appliedAt}`);
    console.log(`Replayed: ${safe.replayed}`);
  }
  return EXIT.OK;
}

function appPurgeFailure(error: unknown): CliFailure {
  if (error instanceof AppPurgeApplyOutcomeUnknownError) {
    return {
      code: 'app_purge_apply_outcome_unknown',
      message: 'The app purge apply outcome could not be confirmed.',
      cause: 'The apply request was sent, but no valid result was received; it may have committed.',
      fix: 'Replay the exact apply command with the same approved artifact, evidence, and idempotency key. Do not create a new preview or change any input.',
      next: 'Replay the exact original command unchanged with the same approved artifact, evidence, and idempotency key.',
      exitCode: error.unreachable ? EXIT.UNREACHABLE : EXIT.FAILURE,
    };
  }
  if (error instanceof ServiceRequestError) {
    const auth = error.status === 401 || error.status === 403;
    const unavailable = error.status === 0;
    const code = AppPurgeReconciliationErrorCodeSchema.safeParse(error.code);
    return {
      code: auth
        ? 'auth_failed'
        : unavailable
          ? 'service_unreachable'
          : code.success
            ? code.data
            : 'app_purge_service_error',
      message: auth
        ? 'The app purge reconciliation request was not authorized.'
        : unavailable
          ? 'The app purge reconciliation service could not be reached.'
          : 'The app purge reconciliation request failed.',
      cause: auth
        ? 'The authenticated operator is not authorized for this private operation.'
        : unavailable
          ? 'The control-plane service could not be reached.'
          : 'The service rejected the request or its current state no longer matches the preview.',
      fix: auth
        ? 'Sign in again and confirm the required super-admin authorization.'
        : 'Stop, inspect the service state, and create a fresh preview before retrying changed input.',
      next: auth ? 'noodle login' : 'noodle service app-purge preview --output <absolute-path>',
      exitCode: auth ? EXIT.AUTH : unavailable ? EXIT.UNREACHABLE : EXIT.FAILURE,
    };
  }
  return {
    code: 'app_purge_artifact_invalid',
    message: 'The app purge reconciliation artifact or response is invalid.',
    cause: 'The bounded reconciliation contract could not be validated or stored safely.',
    fix: 'Stop and create a new preview artifact at a new absolute path.',
    next: 'noodle service app-purge preview --output <absolute-path>',
    exitCode: EXIT.FAILURE,
  };
}

class AppPurgeApplyOutcomeUnknownError extends Error {
  constructor(readonly unreachable: boolean) {
    super('The app purge apply outcome is unknown.');
    this.name = 'AppPurgeApplyOutcomeUnknownError';
  }
}
