import {
  BillingMeterReadinessClientResponseSchema,
  type BillingMeterReadinessReport,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { runBillingMeterValidation } from './billing-metering-validation-ops.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

interface BillingMeteringArgs {
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

export async function runBillingMetering(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const action = rest[0];
  const json = rest.includes('--json');
  if (action === 'validation') return runBillingMeterValidation(rest.slice(1), env, home);
  if (action !== 'readiness') {
    return printCliFailure(
      'billing metering',
      meteringUsage('billing metering requires readiness or validation'),
      json,
    );
  }
  const parsed = parseBillingMeteringArgs(rest.slice(1));
  if (!parsed.ok) return printCliFailure('billing metering readiness', parsed.error, json);
  const args = parsed.args;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('billing metering readiness', authRequired(), args.json);
  }

  try {
    const body = await serviceJson<unknown>(
      `${resolved.serviceUrl}/v1/billing-accounts/metering/readiness`,
      resolved.token,
    );
    const report = parseReadinessServiceResponse(body);
    if (args.json) printJsonOk({ service: resolved.serviceUrl, readiness: report });
    else printHumanReadiness(report);
    return report.technicalReadiness === 'ready' ? EXIT.OK : EXIT.FAILURE;
  } catch (error) {
    return printCliFailure(
      'billing metering readiness',
      serviceFailure('billing metering readiness', error, 'noodle billing metering readiness'),
      args.json,
    );
  }
}

function parseReadinessServiceResponse(body: unknown): BillingMeterReadinessReport {
  const parsed = BillingMeterReadinessClientResponseSchema.safeParse(body);
  if (!parsed.success) throw invalidReadinessResponse();
  return parsed.data.data;
}

function invalidReadinessResponse(): Error {
  return new Error('The service returned an invalid billing metering readiness response.');
}

function parseBillingMeteringArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: BillingMeteringArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  let service: string | undefined;
  let authToken: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') json = true;
    else if (arg === '--service' || arg === '--auth-token') {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: meteringUsage('a flag value is missing') };
      }
      if (arg === '--service') service = value;
      else authToken = value;
      index++;
    } else {
      return {
        ok: false,
        error: meteringUsage(`unknown argument: ${arg ?? ''}`),
      };
    }
  }
  return {
    ok: true,
    args: {
      ...(service !== undefined ? { service } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
      json,
    },
  };
}

function printHumanReadiness(report: BillingMeterReadinessReport): void {
  console.log(
    `Authoritative-meter technical readiness: ${report.technicalReadiness.toUpperCase()}`,
  );
  console.log(`Checked: ${report.checkedAt}`);
  console.log(
    `Current metering: ${formatLabel(report.metering.mode)} / ${formatLabel(report.metering.coverage ?? 'unavailable')}`,
  );
  console.log(`Current enforcement: ${formatLabel(report.enforcement.state)}`);
  console.log(`Activation: ${formatLabel(report.activation.state)}`);
  console.log('Checks:');
  for (const check of report.checks) {
    console.log(`  ${check.state.toUpperCase()}  ${check.code}`);
  }
  console.log('Later cutover gates:');
  for (const gate of report.laterCutoverGates) console.log(`  ${gate}`);
  const metering = `${formatLabel(report.metering.mode)} / ${formatLabel(report.metering.coverage ?? 'unavailable')}`;
  console.log(`Metering remains ${metering}. Enforcement is unchanged. No changes were made.`);
}

function formatLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

function meteringUsage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The billing metering command or one of its arguments is invalid.',
    fix: 'Inspect authoritative-meter technical readiness without changing billing state.',
    next: 'noodle billing metering readiness [--service <url>] [--json]',
    exitCode: EXIT.USAGE,
  };
}
