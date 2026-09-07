import {
  type BillingEnforcementActivateRequest,
  BillingEnforcementActivationMutationClientResponseSchema,
  type BillingEnforcementActivationMutationResult,
  type BillingEnforcementActivationPreview,
  BillingEnforcementActivationPreviewClientResponseSchema,
  type BillingEnforcementActivationStatus,
  BillingEnforcementActivationStatusClientResponseSchema,
  type BillingEnforcementRollbackRequest,
  normalizeActivationServiceUrl,
  parseBillingEnforcementActivateRequest,
  parseBillingEnforcementRollbackRequest,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { confirm, isInteractive } from '../prompts.js';
import { billingEnforcementActivationApprovalChecksum } from './billing-contract-checksums.js';
import {
  type ActivateArgs,
  type ActivationArgs,
  activationUsage,
  type PreviewArgs,
  parseActivationArgs,
  type RollbackArgs,
  type StatusArgs,
} from './billing-enforcement-activation-args.js';
import {
  activationApprovalFileFailure,
  activationPreviewFileFailure,
  readActivationApproval,
  readApprovedActivationPreview,
} from './billing-enforcement-activation-files.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

const ACTIVATION_PATH = '/v1/billing-accounts/enforcement/activation';

export async function runBillingEnforcementActivation(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseActivationArgs(rest);
  const json = rest.includes('--json');
  if (!parsed.ok) {
    return printCliFailure('billing enforcement activation', parsed.error, json);
  }
  const args = parsed.args;
  if (args.action === 'activate' || args.action === 'rollback') {
    const confirmation = await confirmMutation(args);
    if (confirmation !== undefined) return confirmation;
  }

  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(commandName(args.action), authRequired(), args.json);
  }
  if (args.action === 'status') return runStatus(args, resolved.serviceUrl, resolved.token);
  if (args.action === 'preview') return runPreview(args, resolved.serviceUrl, resolved.token);
  if (args.action === 'activate') return runActivate(args, resolved.serviceUrl, resolved.token);
  return runRollback(args, resolved.serviceUrl, resolved.token);
}

async function runStatus(args: StatusArgs, service: string, token: string): Promise<number> {
  try {
    const status = parseStatus(await serviceJson<unknown>(`${service}${ACTIVATION_PATH}`, token));
    if (args.json) printJsonOk({ service, activation: status });
    else printHumanStatus(status);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      commandName('status'),
      activationServiceFailure('status', error),
      args.json,
    );
  }
}

async function runPreview(args: PreviewArgs, service: string, token: string): Promise<number> {
  let approval: Awaited<ReturnType<typeof readActivationApproval>>;
  try {
    approval = await readActivationApproval(args.file);
    if (approval.service !== normalizeActivationServiceUrl(service)) {
      throw new Error('activation approval targets a different service');
    }
  } catch (error) {
    return printCliFailure(
      commandName('preview'),
      activationApprovalFileFailure(args.file, error),
      args.json,
    );
  }
  try {
    const preview = parsePreview(
      await serviceJson<unknown>(`${service}${ACTIVATION_PATH}/preview`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(approval),
      }),
    );
    if (args.json) printJsonOk({ service, activationPreview: preview });
    else printHumanPreview(preview, args.file);
    return preview.ready ? EXIT.OK : EXIT.FAILURE;
  } catch (error) {
    return printCliFailure(
      commandName('preview'),
      activationServiceFailure('preview', error),
      args.json,
    );
  }
}

async function runActivate(args: ActivateArgs, service: string, token: string): Promise<number> {
  let approval: Awaited<ReturnType<typeof readActivationApproval>>;
  try {
    approval = await readActivationApproval(args.file);
    if (approval.service !== normalizeActivationServiceUrl(service)) {
      throw new Error('activation approval targets a different service');
    }
  } catch (error) {
    return printCliFailure(
      commandName('activate'),
      activationApprovalFileFailure(args.file, error),
      args.json,
    );
  }

  let approved: Awaited<ReturnType<typeof readApprovedActivationPreview>>;
  try {
    approved = await readApprovedActivationPreview(args.previewFile);
    if (
      normalizeActivationServiceUrl(approved.service) !== normalizeActivationServiceUrl(service)
    ) {
      throw new Error('activation preview targets a different service');
    }
    if (
      approved.activationPreview.approvalChecksum !==
      billingEnforcementActivationApprovalChecksum(approval)
    ) {
      throw new Error('activation preview does not match the approval file');
    }
  } catch (error) {
    return printCliFailure(
      commandName('activate'),
      activationPreviewFileFailure(args.previewFile, error),
      args.json,
    );
  }

  let request: BillingEnforcementActivateRequest;
  try {
    request = parseBillingEnforcementActivateRequest({
      schemaVersion: 1,
      approval,
      expectedPreviewChecksum: approved.activationPreview.previewChecksum,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      confirmed: true,
    });
  } catch (error) {
    return printCliFailure(
      commandName('activate'),
      activationUsage(error instanceof Error ? error.message : String(error)),
      args.json,
    );
  }
  return sendMutation('activate', args, service, token, request);
}

async function runRollback(args: RollbackArgs, service: string, token: string): Promise<number> {
  let request: BillingEnforcementRollbackRequest;
  try {
    request = parseBillingEnforcementRollbackRequest({
      schemaVersion: 1,
      expectedState: 'active',
      expectedGeneration: args.generation,
      expectedEpochId: args.epochId,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      confirmed: true,
    });
  } catch (error) {
    return printCliFailure(
      commandName('rollback'),
      activationUsage(error instanceof Error ? error.message : String(error)),
      args.json,
    );
  }
  return sendMutation('rollback', args, service, token, request);
}

async function sendMutation(
  action: 'activate' | 'rollback',
  args: ActivateArgs | RollbackArgs,
  service: string,
  token: string,
  request: BillingEnforcementActivateRequest | BillingEnforcementRollbackRequest,
): Promise<number> {
  try {
    const result = parseMutation(
      await serviceJson<unknown>(`${service}${ACTIVATION_PATH}/${action}`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
      action,
    );
    if (args.json) printJsonOk({ service, activation: result });
    else printHumanMutation(result);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      commandName(action),
      activationServiceFailure(action, error, args.idempotencyKey),
      args.json,
    );
  }
}

async function confirmMutation(args: ActivateArgs | RollbackArgs): Promise<number | undefined> {
  if (!args.yes && (args.json || !isInteractive())) {
    return printCliFailure(commandName(args.action), confirmationRequired(args.action), args.json);
  }
  if (args.yes) return undefined;
  const question =
    args.action === 'activate'
      ? 'Activate Free v1 authoritative billing enforcement? Enforced Free profiles start at zero usage now; paid plans remain inactive, while legacy internal exempt profiles remain bypassed.'
      : 'Roll back authoritative billing enforcement? Admission enforcement stops, while usage and operation evidence remain preserved.';
  if (await confirm(question, { initial: false })) return undefined;
  console.error(`${commandName(args.action)}: cancelled`);
  return EXIT.USAGE;
}

function parseStatus(body: unknown): BillingEnforcementActivationStatus {
  return parseEnvelope(body, BillingEnforcementActivationStatusClientResponseSchema, 'status');
}

function parsePreview(body: unknown): BillingEnforcementActivationPreview {
  return parseEnvelope(body, BillingEnforcementActivationPreviewClientResponseSchema, 'preview');
}

function parseMutation(
  body: unknown,
  action: 'activate' | 'rollback',
): BillingEnforcementActivationMutationResult {
  const result = parseEnvelope(
    body,
    BillingEnforcementActivationMutationClientResponseSchema,
    action,
  );
  if (result.action !== action) throw invalidResponse(action);
  return result;
}

function parseEnvelope<T>(
  body: unknown,
  schema: {
    safeParse(value: unknown): { success: true; data: { data: T } } | { success: false };
  },
  action: string,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidResponse(action);
  return parsed.data.data;
}

function invalidResponse(action: string): Error {
  return new Error(
    `The service returned an invalid billing enforcement activation ${action} response.`,
  );
}

function printHumanStatus(status: BillingEnforcementActivationStatus): void {
  const label = status.state === 'not_activated' ? 'NOT ACTIVATED' : status.state.toUpperCase();
  console.log(`Billing enforcement: ${label}`);
  console.log(`Generation: ${status.generation}`);
  if (status.admissionContractVersion !== null) {
    console.log(`Admission contract: v${status.admissionContractVersion}`);
  }
  if (status.activeEpochId !== null) console.log(`Authoritative epoch: ${status.activeEpochId}`);
  if (status.activatedAt !== null) console.log(`Activated: ${status.activatedAt}`);
  if (status.rolledBackAt !== null) console.log(`Rolled back: ${status.rolledBackAt}`);
}

function printHumanPreview(preview: BillingEnforcementActivationPreview, file: string): void {
  console.log(`Billing enforcement activation preview: ${preview.ready ? 'READY' : 'BLOCKED'}`);
  console.log('Commercial scope: Free v1 only');
  console.log('Paid plans: INACTIVE');
  console.log(`Blockers: ${preview.blockers.length}`);
  for (const blocker of preview.blockers) console.log(`  [${blocker.code}]`);
  console.log('Activation would start a fresh authoritative usage epoch at zero.');
  console.log('Stripe, paid plans, migration grants, and invoice evidence remain inactive.');
  if (!preview.ready) {
    console.log(`Next: noodle billing enforcement activation preview --file ${file}`);
  }
  console.log('No changes were made.');
}

function printHumanMutation(result: BillingEnforcementActivationMutationResult): void {
  if (result.action === 'activate') {
    console.log(`Billing enforcement: ${result.replayed ? 'ALREADY ACTIVE' : 'ACTIVE'}`);
    console.log(`Generation: ${result.generation}`);
    console.log(`Authoritative epoch: ${result.lastEpochId}`);
  } else {
    console.log(`Billing enforcement: ${result.replayed ? 'ALREADY ROLLED BACK' : 'ROLLED BACK'}`);
    console.log(`Generation: ${result.generation}`);
    console.log('Meter evidence was preserved; authoritative admission enforcement is inactive.');
  }
  if (result.replayed) {
    console.log('The existing operation result was returned; no duplicate mutation was made.');
  }
}

function activationServiceFailure(
  action: ActivationArgs['action'],
  error: unknown,
  idempotencyKey?: string,
): CliFailure {
  const next =
    action === 'status'
      ? 'noodle billing enforcement activation status'
      : action === 'preview'
        ? 'noodle billing enforcement activation preview --file <approval.json>'
        : `noodle billing enforcement activation ${action} --reason <text> --idempotency-key <same-private-key> --yes`;
  const base = serviceFailure(commandName(action), error, next);
  const typed =
    error instanceof ServiceRequestError && error.code !== undefined
      ? { ...base, code: error.code }
      : base;
  return idempotencyKey === undefined ? typed : redactFailure(typed, idempotencyKey);
}

function redactFailure(failure: CliFailure, privateValue: string): CliFailure {
  const redact = (value: string): string => value.split(privateValue).join('[redacted]');
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

function confirmationRequired(action: 'activate' | 'rollback'): CliFailure {
  return {
    code: 'confirmation_required',
    message: `${commandName(action)} requires confirmation`,
    cause:
      action === 'activate'
        ? 'This starts authoritative usage at zero and enables Free v1 admission enforcement for enforced profiles; paid plans remain inactive.'
        : 'This disables authoritative admission enforcement while preserving meter evidence.',
    fix: 'Review the operation and its approved evidence, then re-run with --yes.',
    next: `noodle billing enforcement activation ${action} --reason <text> --idempotency-key <key> --yes`,
    exitCode: EXIT.USAGE,
  };
}

function commandName(action: ActivationArgs['action']): string {
  return `billing enforcement activation ${action}`;
}
