import { PlatformAccountResetResultClientResponseSchema } from '@noodle-borg/wire-contracts';
import type { z } from 'zod';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  type PlatformAccountResetArgs,
  parsePlatformAccountResetArgs,
} from './platform-account-reset-args.js';
import { readPlatformAccountResetTargetFile } from './platform-account-reset-files.js';
import { authRequired, type CliFailure, printCliFailure } from './shared.js';

const COMMAND = 'platform-auth account-reset';
type PlatformAccountResetSafeResult = z.infer<
  typeof PlatformAccountResetResultClientResponseSchema
>['data'];

export async function runPlatformAccountReset(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parsePlatformAccountResetArgs(rest);
  const json = rest.includes('--json');
  if (!parsed.ok) return printCliFailure(COMMAND, parsed.error, json);
  const args = parsed.args;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) return printCliFailure(COMMAND, authRequired(), args.json);

  const root = `${resolved.serviceUrl}/v1/platform-auth/account-reset`;
  try {
    if (args.action === 'status') {
      const response = PlatformAccountResetResultClientResponseSchema.parse(
        await serviceJson<unknown>(
          `${root}/status?operation_id=${encodeURIComponent(args.operationId)}`,
          resolved.token,
          { redirect: 'manual' },
        ),
      );
      const blockerCount = aggregateBlockerCount(response.data);
      printResult('status', response.data, args.json, false, blockerCount);
      return resultExitCode(blockerCount);
    }
    if (args.action === 'preview') {
      const body = await previewBody(args);
      const response = PlatformAccountResetResultClientResponseSchema.parse(
        await serviceJson<unknown>(`${root}/preview`, resolved.token, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const blockerCount = aggregateBlockerCount(response.data);
      printResult(`${args.operation} preview`, response.data, args.json, true, blockerCount);
      return resultExitCode(blockerCount);
    }
    const response = PlatformAccountResetResultClientResponseSchema.parse(
      await serviceJson<unknown>(`${root}/${args.action}`, resolved.token, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          action: args.action,
          operationId: args.operationId,
          expectedGeneration: args.expectedGeneration,
          releaseSha: args.releaseSha,
          previewChecksum: args.previewChecksum,
          idempotencyKey: args.idempotencyKey,
          reason: args.reason,
          confirmed: true,
        }),
      }),
    );
    const blockerCount = aggregateBlockerCount(response.data);
    printResult(args.action, response.data, args.json, false, blockerCount);
    return resultExitCode(blockerCount);
  } catch (error) {
    return printCliFailure(COMMAND, failureFor(error), args.json);
  }
}

async function previewBody(
  args: Extract<PlatformAccountResetArgs, { readonly action: 'preview' }>,
): Promise<Record<string, unknown>> {
  if (args.operation === 'quarantine') {
    return {
      schemaVersion: 1,
      operation: 'quarantine',
      targetSet: await readPlatformAccountResetTargetFile(args.targetFile),
    };
  }
  return { schemaVersion: 1, operation: args.operation, operationId: args.operationId };
}

function printResult(
  operation: string,
  result: PlatformAccountResetSafeResult,
  json: boolean,
  preview: boolean,
  blockerCount: number,
): void {
  const safe = safeResult(operation, result, preview, blockerCount);
  if (json) {
    printJsonOk({ accountReset: safe });
    return;
  }
  console.log(`Platform account reset ${operation}: ${safe.outcome}`);
  console.log(`Operation ID: ${safe.operationId}`);
  console.log(`Release SHA: ${safe.releaseSha}`);
  console.log(`Rollout generation: ${safe.rolloutGeneration}`);
  console.log(`Source epoch: ${safe.sourceEpoch}`);
  console.log(`Preview checksum: ${safe.previewChecksum ?? 'none'}`);
  console.log(`Targets: ${safe.targetCount}`);
  console.log(`Personal organizations: ${safe.personalOrganizationCount}`);
  console.log(`Sole-owned organizations: ${safe.soleOwnedOrganizationCount}`);
  console.log(`Owner-only apps: ${safe.ownerOnlyAppCount}`);
  console.log(`Preserved shared organizations: ${safe.preservedSharedOrganizationCount}`);
  console.log(`Blockers: ${safe.blockerCount}`);
  if (preview) console.log('No changes were made.');
}

function safeResult(
  operation: string,
  result: PlatformAccountResetSafeResult,
  preview: boolean,
  blockerCount: number,
) {
  return {
    operation,
    outcome: preview ? (blockerCount > 0 ? 'BLOCKED' : 'READY') : result.lifecycle.toUpperCase(),
    operationId: result.operationId,
    releaseSha: result.releaseSha,
    rolloutGeneration: result.rolloutGeneration,
    sourceEpoch: result.sourceEpoch,
    previewChecksum: result.previewChecksum,
    targetCount: result.counts.targetCount,
    personalOrganizationCount: result.counts.personalOrganizationCount,
    soleOwnedOrganizationCount: result.counts.soleOwnedOrganizationCount,
    ownerOnlyAppCount: result.counts.ownerOnlyAppCount,
    preservedSharedOrganizationCount: result.counts.preservedSharedOrganizationCount,
    blockerCount,
  };
}

function aggregateBlockerCount(result: PlatformAccountResetSafeResult): number {
  return result.blockers.reduce((total, blocker) => total + blocker.count, 0);
}

function resultExitCode(blockerCount: number): number {
  return blockerCount > 0 ? EXIT.FAILURE : EXIT.OK;
}

function failureFor(error: unknown): CliFailure {
  if (error instanceof ServiceRequestError) {
    if (error.status === 401 || error.status === 403) {
      return {
        code: 'auth_failed',
        message: 'The control-plane request was not authorized.',
        cause: 'The authenticated operator is not authorized for this private operation.',
        fix: 'Sign in again and confirm the required operator authorization.',
        next: 'noodle login',
        exitCode: EXIT.AUTH,
      };
    }
    return {
      code: error.status === 0 ? 'service_unreachable' : 'service_error',
      message: 'The account-reset control-plane request failed.',
      cause:
        error.status === 0
          ? 'The service could not be reached.'
          : 'The service rejected the request.',
      fix: 'Check the control-plane service and retry from a fresh preview.',
      next: 'noodle platform-auth account-reset status --operation-id <reset-operation-id>',
      exitCode: error.status === 0 ? EXIT.UNREACHABLE : EXIT.FAILURE,
    };
  }
  return {
    code: 'account_reset_response_invalid',
    message: 'The account-reset response or target file is invalid.',
    cause: 'The private account-reset contract could not be validated.',
    fix: 'Use a fresh secure target file and a matching System Release.',
    next: 'noodle platform-auth account-reset status --operation-id <reset-operation-id>',
    exitCode: EXIT.FAILURE,
  };
}
