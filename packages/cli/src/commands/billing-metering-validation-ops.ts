import {
  BillingMeterValidationEpochClientResponseSchema,
  type BillingMeterValidationEpochPrepareRequest,
  type BillingMeterValidationEpochResult,
  type BillingMeterValidationEpochRetireRequest,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { confirm, isInteractive } from '../prompts.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

interface ValidationArgs {
  readonly action: 'prepare' | 'retire';
  readonly epochId?: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly yes: boolean;
}

export async function runBillingMeterValidation(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const json = rest.includes('--json');
  const parsed = parseValidationArgs(rest);
  if (!parsed.ok) return printCliFailure('billing metering validation', parsed.error, json);
  const args = parsed.args;
  if (!args.yes && (args.json || !isInteractive())) {
    return printCliFailure(
      `billing metering validation ${args.action}`,
      confirmationRequired(args),
      args.json,
    );
  }
  if (!args.yes) {
    const verb = args.action === 'prepare' ? 'Prepare' : 'Retire';
    const confirmed = await confirm(
      `${verb} the validation-only meter epoch? Metering stays shadow and enforcement remains unchanged.`,
      { initial: false },
    );
    if (!confirmed) {
      console.error(`billing metering validation ${args.action}: cancelled`);
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
    return printCliFailure(`billing metering validation ${args.action}`, authRequired(), args.json);
  }

  const request:
    | BillingMeterValidationEpochPrepareRequest
    | BillingMeterValidationEpochRetireRequest =
    args.action === 'prepare'
      ? {
          schemaVersion: 1,
          mode: 'validation',
          reason: args.reason,
          idempotencyKey: args.idempotencyKey,
          confirmed: true,
        }
      : {
          schemaVersion: 1,
          epochId: args.epochId as string,
          reason: args.reason,
          idempotencyKey: args.idempotencyKey,
          confirmed: true,
        };
  const command = `billing metering validation ${args.action}`;
  try {
    const body = await serviceJson<unknown>(
      `${resolved.serviceUrl}/v1/billing-accounts/metering/validation/${args.action}`,
      resolved.token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    const result = parseValidationResult(body);
    if (args.json) printJsonOk({ service: resolved.serviceUrl, validationEpoch: result });
    else printHumanResult(result);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(command, validationServiceFailure(error, args), args.json);
  }
}

function parseValidationArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: ValidationArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const action = rest[0];
  if (action !== 'prepare' && action !== 'retire') {
    return { ok: false, error: validationUsage('validation requires prepare or retire') };
  }
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  const valueFlags = new Set([
    '--epoch',
    '--reason',
    '--idempotency-key',
    '--service',
    '--auth-token',
  ]);
  for (let index = 1; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') json = true;
    else if (arg === '--yes') yes = true;
    else if (arg !== undefined && valueFlags.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: validationUsage(`a value for ${arg} is required`) };
      }
      if (values.has(arg)) {
        return { ok: false, error: validationUsage(`${arg} may be supplied once`) };
      }
      values.set(arg, value);
      index++;
    } else {
      return { ok: false, error: validationUsage(`unknown argument: ${arg ?? ''}`) };
    }
  }
  if (!values.has('--reason')) {
    return { ok: false, error: validationUsage('--reason is required') };
  }
  if (!values.has('--idempotency-key')) {
    return { ok: false, error: validationUsage('--idempotency-key is required') };
  }
  if (action === 'retire' && !values.has('--epoch')) {
    return { ok: false, error: validationUsage('--epoch is required for retire') };
  }
  if (action === 'prepare' && values.has('--epoch')) {
    return { ok: false, error: validationUsage('--epoch is valid only for retire') };
  }
  return {
    ok: true,
    args: {
      action,
      ...(values.has('--epoch') ? { epochId: values.get('--epoch') as string } : {}),
      reason: values.get('--reason') as string,
      idempotencyKey: values.get('--idempotency-key') as string,
      ...(values.has('--service') ? { service: values.get('--service') as string } : {}),
      ...(values.has('--auth-token') ? { authToken: values.get('--auth-token') as string } : {}),
      json,
      yes,
    },
  };
}

function parseValidationResult(body: unknown): BillingMeterValidationEpochResult {
  const parsed = BillingMeterValidationEpochClientResponseSchema.safeParse(body);
  if (!parsed.success) throw invalidValidationResponse();
  return parsed.data.data;
}

function printHumanResult(result: BillingMeterValidationEpochResult): void {
  console.log(`Validation epoch: ${result.state.toUpperCase()}`);
  console.log(`Epoch ID: ${result.epochId}`);
  console.log(`Service release: ${result.serviceReleaseSha}`);
  if (result.replayed)
    console.log('The existing operation result was returned; no duplicate mutation was made.');
  console.log('Metering remains shadow. Enforcement is unchanged.');
}

function invalidValidationResponse(): Error {
  return new Error('The service returned an invalid billing meter validation epoch response.');
}

function validationUsage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The validation epoch command or one of its arguments is invalid.',
    fix: 'Supply an explicit reason, idempotency key, and confirmation.',
    next: 'noodle billing metering validation prepare --reason <text> --idempotency-key <key> --yes',
    exitCode: EXIT.USAGE,
  };
}

function confirmationRequired(args: ValidationArgs): CliFailure {
  return {
    code: 'confirmation_required',
    message: `billing metering validation ${args.action} requires confirmation`,
    cause: 'This operation changes validation-only meter lifecycle state.',
    fix: 'Review the operation, then re-run with --yes.',
    next: `noodle billing metering validation ${args.action}${args.epochId === undefined ? '' : ` --epoch ${args.epochId}`} --reason <text> --idempotency-key <key> --yes`,
    exitCode: EXIT.USAGE,
  };
}

function validationServiceFailure(error: unknown, args: ValidationArgs): CliFailure {
  const next = `noodle billing metering validation ${args.action}${args.epochId === undefined ? '' : ` --epoch ${args.epochId}`} --reason <text> --idempotency-key <same-private-key> --yes`;
  const failure = serviceFailure(`billing metering validation ${args.action}`, error, next);
  if (!(error instanceof ServiceRequestError) || error.code === undefined) return failure;
  return { ...failure, code: error.code, message: error.message, cause: error.message };
}
