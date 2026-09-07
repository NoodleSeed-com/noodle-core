import type {
  LegacyBillingMigrationPreview,
  LegacyBillingMigrationRequest,
} from '@noodle-borg/wire-contracts';
import { LegacyBillingMigrationClientPreviewResponseSchema } from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { runBillingMigrationApply } from './billing-apply-ops.js';
import { runBillingEnforcement } from './billing-enforcement-ops.js';
import { runBillingMetering } from './billing-metering-ops.js';
import { mappingFileFailure, readMappingRequest } from './billing-migration-files.js';
import { runBillingOrganizationTransfer } from './billing-org-transfer-ops.js';
import { runBillingAccounts, runBillingOrg } from './billing-read-ops.js';
import { EXIT, printJsonOk } from './output.js';
import { type CliFailure, printCliFailure, serviceFailure } from './shared.js';

interface BillingArgs {
  readonly file?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

/** Operator-only billing migration commands. */
export async function runBilling(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const json = rest.includes('--json');
  if (rest[0] === 'accounts') return runBillingAccounts(rest.slice(1), env, home);
  if (rest[0] === 'org' && rest[1] === 'transfer') {
    return runBillingOrganizationTransfer('customer', rest.slice(2), env, home);
  }
  if (rest[0] === 'org') return runBillingOrg(rest.slice(1), env, home);
  if (rest[0] === 'administration' && rest[1] === 'transfer') {
    return runBillingOrganizationTransfer('super_admin', rest.slice(2), env, home);
  }
  if (rest[0] === 'enforcement') return runBillingEnforcement(rest.slice(1), env, home);
  if (rest[0] === 'metering') return runBillingMetering(rest.slice(1), env, home);
  if (rest[0] === 'migration' && rest[1] === 'apply') {
    return runBillingMigrationApply(rest.slice(2), env, home);
  }
  if (rest[0] !== 'migration' || rest[1] !== 'preview') {
    return printCliFailure('billing', billingUsage(), json);
  }
  const parsed = parseBillingArgs(rest.slice(2));
  if (!parsed.ok) return printCliFailure('billing migration preview', parsed.error, json);
  const args = parsed.args;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('billing migration preview', missingLogin(), args.json);
  }

  let request: LegacyBillingMigrationRequest;
  try {
    request = await readMappingRequest(args.file);
  } catch (error) {
    return printCliFailure(
      'billing migration preview',
      mappingFileFailure(args.file, error),
      args.json,
    );
  }

  try {
    const body = LegacyBillingMigrationClientPreviewResponseSchema.parse(
      await serviceJson<unknown>(
        `${resolved.serviceUrl}/v1/billing-accounts/migrations/legacy/preview`,
        resolved.token,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
      ),
    );
    const preview = body.data as LegacyBillingMigrationPreview;
    if (args.json) printJsonOk({ service: resolved.serviceUrl, preview });
    else printHumanPreview(preview, args.file);
    return preview.ready ? EXIT.OK : EXIT.FAILURE;
  } catch (error) {
    return printCliFailure(
      'billing migration preview',
      serviceFailure(
        'billing migration preview',
        error,
        'noodle billing migration preview --file <mapping.json>',
      ),
      args.json,
    );
  }
}

function printHumanPreview(preview: LegacyBillingMigrationPreview, file: string | undefined): void {
  console.log(`Billing migration preview: ${preview.ready ? 'READY' : 'BLOCKED'}`);
  console.log(`Organizations requiring mapping: ${preview.organizations.length}`);
  console.log(`Already linked: ${preview.linkedOrganizations.length}`);
  console.log(`Funding sets: ${preview.fundingSets.length}`);
  console.log(
    `Legacy cohort grant policy: ${preview.grantPolicy.durationDays} days when the account footprint exceeds plan capacity`,
  );
  if (preview.blockers.length > 0) {
    console.log('Blockers:');
    for (const blocker of preview.blockers) {
      console.log(`  ${blocker.org} [${blocker.code}] ${blocker.message}`);
    }
    console.log(`Next: noodle billing migration preview --file ${file ?? '<mapping.json>'}`);
  }
  console.log('No changes were made.');
}

function parseBillingArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: BillingArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  let file: string | undefined;
  let service: string | undefined;
  let authToken: string | undefined;
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') json = true;
    else if (arg === '--file' || arg === '--service' || arg === '--auth-token') {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: billingUsage('a flag value is missing') };
      }
      if (arg === '--file') file = value;
      else if (arg === '--service') service = value;
      else authToken = value;
      index++;
    } else return { ok: false, error: billingUsage(`unknown argument: ${arg ?? ''}`) };
  }
  return {
    ok: true,
    args: {
      ...(file !== undefined ? { file } : {}),
      ...(service !== undefined ? { service } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
      json,
    },
  };
}

function billingUsage(message = 'billing migration requires preview or apply'): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The billing command or one of its arguments is invalid.',
    fix: 'Run preview first; use apply only with reviewed private evidence.',
    next: 'noodle billing migration preview [--file <mapping.json>] [--json]',
    exitCode: EXIT.USAGE,
  };
}

function missingLogin(): CliFailure {
  return {
    code: 'auth_required',
    message: 'A control-plane login token is required.',
    cause: 'No control-plane login token is available.',
    fix: 'Sign in or pass an explicit auth token.',
    next: 'noodle login',
    exitCode: EXIT.AUTH,
  };
}
