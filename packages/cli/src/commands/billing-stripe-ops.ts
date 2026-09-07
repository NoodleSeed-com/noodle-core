import { randomUUID } from 'node:crypto';
import {
  BillingStripeCheckoutClientResponseSchema,
  type BillingStripeCheckoutResponse,
  BillingStripePortalClientResponseSchema,
  type BillingStripePortalResponse,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

interface BillingStripeCliArgs {
  readonly accountId: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly plan?: 'pro' | 'scale';
  readonly interval?: 'month' | 'year';
  readonly idempotencyKey?: string;
}

export async function runBillingStripeAccountAction(
  action: 'checkout' | 'portal',
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseArgs(action, rest);
  if (!parsed.ok)
    return printCliFailure(`billing accounts ${action}`, parsed.error, rest.includes('--json'));
  const args = parsed.args;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(`billing accounts ${action}`, authRequired(), args.json);
  }

  try {
    if (action === 'checkout') {
      const response = BillingStripeCheckoutClientResponseSchema.parse(
        await serviceJson<BillingStripeCheckoutResponse>(
          `${resolved.serviceUrl}/v1/billing-accounts/${encodeURIComponent(args.accountId)}/checkout`,
          resolved.token,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              plan: args.plan,
              interval: args.interval,
              idempotencyKey: args.idempotencyKey ?? randomUUID(),
            }),
          },
        ),
      );
      printCheckout(response, resolved.serviceUrl, args.json);
      return EXIT.OK;
    }
    const response = BillingStripePortalClientResponseSchema.parse(
      await serviceJson<BillingStripePortalResponse>(
        `${resolved.serviceUrl}/v1/billing-accounts/${encodeURIComponent(args.accountId)}/portal`,
        resolved.token,
        { method: 'POST' },
      ),
    );
    printPortal(response, resolved.serviceUrl, args.json);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      `billing accounts ${action}`,
      serviceFailure(
        `billing accounts ${action}`,
        error,
        `noodle billing accounts ${action} ${args.accountId}`,
      ),
      args.json,
    );
  }
}

function printCheckout(
  response: BillingStripeCheckoutResponse,
  service: string,
  json: boolean,
): void {
  if (json) {
    printJsonOk({ service, ...response.data });
    return;
  }
  console.log('Stripe Checkout is ready:');
  console.log(response.data.url);
  console.log(`Expires: ${response.data.expiresAt}`);
  console.log(`Outcome: ${response.data.outcome}`);
}

function printPortal(response: BillingStripePortalResponse, service: string, json: boolean): void {
  if (json) {
    printJsonOk({ service, ...response.data });
    return;
  }
  console.log('Stripe billing portal:');
  console.log(response.data.url);
}

function parseArgs(
  action: 'checkout' | 'portal',
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: BillingStripeCliArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  let accountId: string | undefined;
  let service: string | undefined;
  let authToken: string | undefined;
  let plan: 'pro' | 'scale' | undefined;
  let interval: 'month' | 'year' | undefined;
  let idempotencyKey: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') json = true;
    else if (
      arg === '--service' ||
      arg === '--auth-token' ||
      arg === '--plan' ||
      arg === '--interval' ||
      arg === '--idempotency-key'
    ) {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: usage(action, 'a flag value is missing') };
      }
      if (arg === '--service') service = value;
      else if (arg === '--auth-token') authToken = value;
      else if (arg === '--plan') {
        if (value !== 'pro' && value !== 'scale') {
          return { ok: false, error: usage(action, '--plan must be pro or scale') };
        }
        plan = value;
      } else if (arg === '--interval') {
        if (value !== 'month' && value !== 'year') {
          return { ok: false, error: usage(action, '--interval must be month or year') };
        }
        interval = value;
      } else idempotencyKey = value;
      index++;
    } else if (arg?.startsWith('--')) {
      return { ok: false, error: usage(action, `unknown argument: ${arg}`) };
    } else if (accountId === undefined) accountId = arg;
    else return { ok: false, error: usage(action, 'exactly one billing account id is required') };
  }
  if (accountId === undefined) {
    return { ok: false, error: usage(action, 'a billing account id is required') };
  }
  if (action === 'checkout' && (plan === undefined || interval === undefined)) {
    return { ok: false, error: usage(action, 'checkout requires --plan and --interval') };
  }
  if (
    action === 'portal' &&
    (plan !== undefined || interval !== undefined || idempotencyKey !== undefined)
  ) {
    return { ok: false, error: usage(action, 'portal does not accept checkout flags') };
  }
  return {
    ok: true,
    args: {
      accountId,
      ...(service === undefined ? {} : { service }),
      ...(authToken === undefined ? {} : { authToken }),
      ...(plan === undefined ? {} : { plan }),
      ...(interval === undefined ? {} : { interval }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      json,
    },
  };
}

function usage(action: 'checkout' | 'portal', message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The Stripe billing command or one of its arguments is invalid.',
    fix:
      action === 'checkout'
        ? 'Choose Pro or Scale and a monthly or annual billing interval.'
        : 'Pass exactly one billing account id.',
    next:
      action === 'checkout'
        ? 'noodle billing accounts checkout <account-id> --plan pro --interval month'
        : 'noodle billing accounts portal <account-id>',
    exitCode: EXIT.USAGE,
  };
}
