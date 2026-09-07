import {
  BillingEnforcementCohortSealClientEnvelopeSchema,
  type BillingEnforcementCohortSealRequest,
  BillingEnforcementCohortSealRequestSchema,
  type BillingEnforcementCohortSealResponse,
  BillingEnforcementCohortStatusClientEnvelopeSchema,
  type BillingEnforcementCohortStatusResponse,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { confirm, isInteractive } from '../prompts.js';
import { runBillingEnforcementActivation } from './billing-enforcement-activation-ops.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

const CLASSIFICATION_ONLY_EFFECTS = {
  classificationOnly: true,
  meteringActivated: false,
  usageQuotaEnforcementActivated: false,
  productionAppCapEnforcementActivated: false,
  migrationGrantsActivated: false,
  stripeActivated: false,
  overageBillingActivated: false,
  invoiceEvidenceActivated: false,
} as const;

const CLASSIFICATION_ONLY_NOTICE =
  'Classification only: this command does not activate metering, usage-quota enforcement, production-app-cap enforcement, migration grants, Stripe, overage billing, or invoice evidence.';

interface CohortStatusArgs {
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

interface CohortSealArgs extends CohortStatusArgs {
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly yes: boolean;
}

export async function runBillingEnforcement(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const json = rest.includes('--json');
  if (rest[0] === 'activation') {
    return runBillingEnforcementActivation(rest.slice(1), env, home);
  }
  if (rest[0] !== 'cohort') {
    return printCliFailure(
      'billing enforcement',
      cohortUsage('billing enforcement requires cohort or activation'),
      json,
    );
  }
  const action = rest[1];
  if (action === 'status') return runCohortStatus(rest.slice(2), env, home);
  if (action === 'seal') return runCohortSeal(rest.slice(2), env, home);
  return printCliFailure(
    'billing enforcement cohort',
    cohortUsage('billing enforcement cohort requires status or seal'),
    json,
  );
}

async function runCohortStatus(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseStatusArgs(rest);
  if (!parsed.ok) {
    return printCliFailure(
      'billing enforcement cohort status',
      parsed.error,
      rest.includes('--json'),
    );
  }
  const args = parsed.args;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('billing enforcement cohort status', authRequired(), args.json);
  }

  try {
    const body = await serviceJson<unknown>(
      `${resolved.serviceUrl}/v1/billing-accounts/enforcement/cohort`,
      resolved.token,
    );
    const status = parseCohortStatus(body);
    if (args.json) {
      printJsonOk({
        service: resolved.serviceUrl,
        cohort: status,
        effects: CLASSIFICATION_ONLY_EFFECTS,
      });
    } else {
      printHumanStatus(status);
    }
    return cohortReady(status) ? EXIT.OK : EXIT.FAILURE;
  } catch (error) {
    return printCliFailure(
      'billing enforcement cohort status',
      serviceFailure(
        'billing enforcement cohort status',
        error,
        'noodle billing enforcement cohort status',
      ),
      args.json,
    );
  }
}

async function runCohortSeal(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseSealArgs(rest);
  if (!parsed.ok) {
    return printCliFailure(
      'billing enforcement cohort seal',
      parsed.error,
      rest.includes('--json'),
    );
  }
  const args = parsed.args;
  const requestResult = BillingEnforcementCohortSealRequestSchema.safeParse({
    schemaVersion: 1,
    cohortKind: 'legacy_internal_v1',
    legacyAccountProfile: 'legacy_internal_exempt',
    postSealAccountProfile: 'enforced',
    reason: args.reason,
    idempotencyKey: args.idempotencyKey,
    confirmed: true,
  });
  if (!requestResult.success) {
    return printCliFailure(
      'billing enforcement cohort seal',
      cohortUsage('billing enforcement cohort seal arguments failed validation'),
      args.json,
    );
  }
  const request: BillingEnforcementCohortSealRequest = requestResult.data;

  if (!args.yes && (args.json || !isInteractive())) {
    return printCliFailure('billing enforcement cohort seal', confirmationRequired(), args.json);
  }
  if (!args.yes) {
    const confirmed = await confirm(
      'Seal the launch billing-account cohort classification? This does not activate metering, usage quotas, production-app caps, migration grants, or Stripe.',
      { initial: false },
    );
    if (!confirmed) {
      console.error('billing enforcement cohort seal: cancelled');
      return EXIT.USAGE;
    }
  }

  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('billing enforcement cohort seal', authRequired(), args.json);
  }

  try {
    const body = await serviceJson<unknown>(
      `${resolved.serviceUrl}/v1/billing-accounts/enforcement/cohort/seal`,
      resolved.token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const result = parseCohortSeal(body);
    if (args.json) {
      printJsonOk({
        service: resolved.serviceUrl,
        cohortSeal: result,
        effects: CLASSIFICATION_ONLY_EFFECTS,
      });
    } else {
      printHumanSeal(result);
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'billing enforcement cohort seal',
      cohortServiceFailure(error, request.idempotencyKey),
      args.json,
    );
  }
}

function parseStatusArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: CohortStatusArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const parsed = parseFlags(rest, false);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    args: {
      ...(parsed.values.has('--service')
        ? { service: parsed.values.get('--service') as string }
        : {}),
      ...(parsed.values.has('--auth-token')
        ? { authToken: parsed.values.get('--auth-token') as string }
        : {}),
      json: parsed.json,
    },
  };
}

function parseSealArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: CohortSealArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const parsed = parseFlags(rest, true);
  if (!parsed.ok) return parsed;
  if (!parsed.values.has('--reason')) {
    return { ok: false, error: cohortUsage('--reason is required') };
  }
  if (!parsed.values.has('--idempotency-key')) {
    return { ok: false, error: cohortUsage('--idempotency-key is required') };
  }
  return {
    ok: true,
    args: {
      reason: parsed.values.get('--reason') as string,
      idempotencyKey: parsed.values.get('--idempotency-key') as string,
      ...(parsed.values.has('--service')
        ? { service: parsed.values.get('--service') as string }
        : {}),
      ...(parsed.values.has('--auth-token')
        ? { authToken: parsed.values.get('--auth-token') as string }
        : {}),
      json: parsed.json,
      yes: parsed.yes,
    },
  };
}

function parseFlags(
  rest: readonly string[],
  allowMutationFlags: boolean,
):
  | {
      readonly ok: true;
      readonly values: ReadonlyMap<string, string>;
      readonly json: boolean;
      readonly yes: boolean;
    }
  | { readonly ok: false; readonly error: CliFailure } {
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  const valueFlags = new Set([
    '--service',
    '--auth-token',
    ...(allowMutationFlags ? ['--reason', '--idempotency-key'] : []),
  ]);
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') {
      if (json) return { ok: false, error: cohortUsage('--json may be supplied once') };
      json = true;
    } else if (arg === '--yes' && allowMutationFlags) {
      if (yes) return { ok: false, error: cohortUsage('--yes may be supplied once') };
      yes = true;
    } else if (arg !== undefined && valueFlags.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: cohortUsage(`a value for ${arg} is required`) };
      }
      if (values.has(arg)) {
        return { ok: false, error: cohortUsage(`${arg} may be supplied once`) };
      }
      values.set(arg, value);
      index++;
    } else {
      return { ok: false, error: cohortUsage(`unknown argument: ${arg ?? ''}`) };
    }
  }
  return { ok: true, values, json, yes };
}

function parseCohortStatus(body: unknown): BillingEnforcementCohortStatusResponse {
  const parsed = BillingEnforcementCohortStatusClientEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw invalidResponse('status');
  return parsed.data.data;
}

function parseCohortSeal(body: unknown): BillingEnforcementCohortSealResponse {
  const parsed = BillingEnforcementCohortSealClientEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw invalidResponse('seal');
  return parsed.data.data;
}

function invalidResponse(action: 'status' | 'seal'): Error {
  return new Error(
    `The service returned an invalid billing enforcement cohort ${action} response.`,
  );
}

function cohortReady(status: BillingEnforcementCohortStatusResponse): boolean {
  return (
    status.state === 'sealed' &&
    status.billingAttributionComplete &&
    status.unprofiledAccountCount === 0 &&
    status.attributionBlockerCount === 0
  );
}

function printHumanStatus(status: BillingEnforcementCohortStatusResponse): void {
  console.log(`Billing enforcement cohort: ${status.state.toUpperCase()}`);
  if (status.sealedAt !== null) console.log(`Sealed: ${status.sealedAt}`);
  printAggregateCounts(status);
  console.log(CLASSIFICATION_ONLY_NOTICE);
}

function printHumanSeal(result: BillingEnforcementCohortSealResponse): void {
  console.log('Billing enforcement cohort: SEALED');
  console.log(`Seal ID: ${result.sealId}`);
  console.log(`Sealed: ${result.sealedAt}`);
  printAggregateCounts(result);
  if (result.replayed) {
    console.log('The existing operation result was returned; no duplicate mutation was made.');
  }
  console.log(CLASSIFICATION_ONLY_NOTICE);
}

function printAggregateCounts(
  status: Pick<
    BillingEnforcementCohortStatusResponse,
    | 'billingAccountCount'
    | 'profiledAccountCount'
    | 'legacyInternalExemptAccountCount'
    | 'enforcedAccountCount'
    | 'unprofiledAccountCount'
    | 'billingAttributionComplete'
    | 'attributionBlockerCount'
  >,
): void {
  console.log(`Billing accounts: ${status.billingAccountCount}`);
  console.log(`Accounts profiled: ${status.profiledAccountCount}`);
  console.log(`Legacy internal exempt: ${status.legacyInternalExemptAccountCount}`);
  console.log(`Enforced profile (not active): ${status.enforcedAccountCount}`);
  console.log(`Unprofiled: ${status.unprofiledAccountCount}`);
  console.log(
    `Billing attribution: ${status.billingAttributionComplete ? 'COMPLETE' : 'INCOMPLETE'}`,
  );
  console.log(`Attribution blockers: ${status.attributionBlockerCount}`);
}

function cohortServiceFailure(error: unknown, idempotencyKey: string): CliFailure {
  const next =
    'noodle billing enforcement cohort seal --reason <text> --idempotency-key <same-private-key> --yes';
  const base = serviceFailure('billing enforcement cohort seal', error, next);
  const failure =
    error instanceof ServiceRequestError && error.code !== undefined
      ? { ...base, code: error.code }
      : base;
  return redactFailure(failure, idempotencyKey);
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

function confirmationRequired(): CliFailure {
  return {
    code: 'confirmation_required',
    message: 'billing enforcement cohort seal requires confirmation',
    cause: 'This operation persistently classifies the launch billing-account cohort.',
    fix: 'Review the classification-only operation, then re-run with --yes.',
    next: 'noodle billing enforcement cohort seal --reason <text> --idempotency-key <key> --yes',
    exitCode: EXIT.USAGE,
  };
}

function cohortUsage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The billing enforcement cohort command or one of its arguments is invalid.',
    fix: 'Inspect aggregate status, or seal the reviewed classification with explicit confirmation.',
    next: 'noodle billing enforcement cohort status',
    exitCode: EXIT.USAGE,
  };
}
