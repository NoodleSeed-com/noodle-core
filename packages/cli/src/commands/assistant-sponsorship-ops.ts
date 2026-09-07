import {
  ManagedAssistantSponsorshipClientResponseSchema,
  ManagedAssistantSponsorshipGrantMutationClientResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

interface SponsorshipArgs {
  readonly positional: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

export async function runAssistantSponsorship(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const action = rest[0];
  if (action !== 'inspect' && action !== 'grant' && action !== 'revoke') {
    return printCliFailure(
      'assistant sponsorship',
      usage('assistant sponsorship requires inspect, grant, or revoke'),
      rest.includes('--json'),
    );
  }
  const parsed = parseArgs(rest.slice(1));
  if (!parsed.ok)
    return printCliFailure(
      `assistant sponsorship ${action}`,
      parsed.error,
      rest.includes('--json'),
    );
  const args = parsed.args;
  const expectedPositionals = action === 'revoke' ? 2 : 1;
  if (args.positional.length !== expectedPositionals) {
    return printCliFailure(
      `assistant sponsorship ${action}`,
      usage(
        `assistant sponsorship ${action} requires ${
          action === 'revoke' ? 'an account id and grant id' : 'exactly one account id'
        }`,
      ),
      args.json,
    );
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(`assistant sponsorship ${action}`, authRequired(), args.json);
  }
  const accountId = args.positional[0] as string;
  const root = `${resolved.serviceUrl}/v1/billing-accounts/${encodeURIComponent(accountId)}/managed-assistant-sponsorship`;
  try {
    if (action === 'inspect') {
      const body = ManagedAssistantSponsorshipClientResponseSchema.parse(
        await serviceJson<unknown>(root, resolved.token),
      );
      if (args.json) printJsonOk({ service: resolved.serviceUrl, ...body.data });
      else printSponsorship(body.data);
      return EXIT.OK;
    }
    const reason = requiredValue(args, '--reason');
    const idempotencyKey = requiredValue(args, '--idempotency-key');
    const request =
      action === 'grant'
        ? {
            additionalTurnsPerDay: positiveInteger(
              requiredValue(args, '--turns-per-day'),
              '--turns-per-day',
            ),
            expiresAt: timestamp(requiredValue(args, '--expires-at'), '--expires-at'),
            ...(args.values['--starts-at'] === undefined
              ? {}
              : { startsAt: timestamp(args.values['--starts-at'], '--starts-at') }),
            reason,
            idempotencyKey,
          }
        : { reason, idempotencyKey };
    const grantId = args.positional[1];
    const url =
      action === 'grant'
        ? `${root}/grants`
        : `${root}/grants/${encodeURIComponent(grantId as string)}/revoke`;
    const body = ManagedAssistantSponsorshipGrantMutationClientResponseSchema.parse(
      await serviceJson<unknown>(url, resolved.token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
    if (args.json) printJsonOk({ service: resolved.serviceUrl, ...body.data });
    else {
      console.log(
        `${action === 'grant' ? 'Granted' : 'Revoked'} ${body.data.grant.id}${
          body.data.replayed ? ' (idempotent replay)' : ''
        }`,
      );
      printSponsorship(body.data.sponsorship);
    }
    return EXIT.OK;
  } catch (error) {
    const failure =
      error instanceof CliArgumentError
        ? usage(error.message)
        : serviceFailure(
            `assistant sponsorship ${action}`,
            error,
            `noodle assistant sponsorship ${action} ${accountId}`,
          );
    return printCliFailure(`assistant sponsorship ${action}`, failure, args.json);
  }
}

function printSponsorship(data: {
  readonly billingAccountId: string;
  readonly defaultTurnsPerDay: number;
  readonly bonusTurnsPerDay: number;
  readonly totalTurnsPerDay: number;
  readonly spend: { readonly state: string; readonly turnsRemaining: number };
  readonly resetAt: string;
  readonly grants: readonly {
    readonly id: string;
    readonly status: string;
    readonly expiresAt: string;
  }[];
  readonly platform?:
    | {
        readonly globalTurnsPerDay: number;
        readonly spend: { readonly state: string; readonly turnsRemaining: number };
      }
    | undefined;
}): void {
  console.log(`Managed assistant sponsorship — ${data.billingAccountId}`);
  console.log(
    `  ${data.totalTurnsPerDay.toLocaleString()} sponsored turns/day (${data.defaultTurnsPerDay.toLocaleString()} default + ${data.bonusTurnsPerDay.toLocaleString()} granted)`,
  );
  console.log(
    `  ${data.spend.turnsRemaining.toLocaleString()} turns remaining · ${data.spend.state} · resets ${data.resetAt}`,
  );
  if (data.platform !== undefined) {
    console.log(
      `  Fleet: ${data.platform.spend.turnsRemaining.toLocaleString()} remaining of ${data.platform.globalTurnsPerDay.toLocaleString()} turns/day · ${data.platform.spend.state}`,
    );
  }
  for (const grant of data.grants) {
    console.log(`  ${grant.id} · ${grant.status} · expires ${grant.expiresAt}`);
  }
}

function parseArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: SponsorshipArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  let service: string | undefined;
  let authToken: string | undefined;
  const valueFlags = new Set([
    '--service',
    '--auth-token',
    '--turns-per-day',
    '--starts-at',
    '--expires-at',
    '--reason',
    '--idempotency-key',
  ]);
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: usage(`${arg} requires a value`) };
      }
      if (values[arg] !== undefined)
        return { ok: false, error: usage(`${arg} may be supplied once`) };
      values[arg] = value;
      if (arg === '--service') service = value;
      if (arg === '--auth-token') authToken = value;
      index++;
      continue;
    }
    if (arg.startsWith('--')) return { ok: false, error: usage(`unknown argument: ${arg}`) };
    positional.push(arg);
  }
  return {
    ok: true,
    args: {
      positional,
      values,
      ...(service === undefined ? {} : { service }),
      ...(authToken === undefined ? {} : { authToken }),
      json,
    },
  };
}

function requiredValue(args: SponsorshipArgs, flag: string): string {
  const value = args.values[flag];
  if (value === undefined) throw new CliArgumentError(`${flag} is required`);
  return value;
}

function positiveInteger(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new CliArgumentError(`${flag} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000) {
    throw new CliArgumentError(`${flag} must be between 1 and 100000`);
  }
  return value;
}

function timestamp(raw: string, flag: string): string {
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime()))
    throw new CliArgumentError(`${flag} must be an ISO timestamp`);
  return value.toISOString();
}

class CliArgumentError extends Error {}

function usage(message: string): CliFailure {
  return {
    code: 'assistant_sponsorship_usage',
    message,
    cause: 'The sponsorship command arguments are incomplete or invalid.',
    fix: 'Inspect an account, or supply a bounded expiring grant with a reason and idempotency key.',
    next: 'noodle assistant sponsorship inspect <billing-account-id>',
    exitCode: EXIT.USAGE,
  };
}
