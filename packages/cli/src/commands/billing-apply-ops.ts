import type {
  LegacyBillingMigrationApplyRequest,
  LegacyBillingMigrationApplyResult,
  LegacyBillingMigrationBlocker,
} from '@noodle-borg/wire-contracts';
import { LegacyBillingMigrationApplyClientResponseSchema } from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { confirm, isInteractive } from '../prompts.js';
import {
  approvedPreviewFileFailure,
  mappingFileFailure,
  planEvidenceFileFailure,
  readApprovedPreview,
  readMappingRequest,
  readPlanEvidence,
} from './billing-migration-files.js';
import { EXIT, printJsonOk } from './output.js';
import { type CliFailure, printCliFailure, serviceFailure } from './shared.js';

interface BillingApplyArgs {
  readonly file: string;
  readonly previewFile: string;
  readonly planEvidenceFile: string;
  readonly mode: 'shadow';
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly yes: boolean;
}

export async function runBillingMigrationApply(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const json = rest.includes('--json');
  const parsed = parseBillingApplyArgs(rest);
  if (!parsed.ok) return printCliFailure('billing migration apply', parsed.error, json);
  const args = parsed.args;

  if (!args.yes && (args.json || !isInteractive())) {
    return printCliFailure('billing migration apply', confirmationRequired(args), args.json);
  }

  let mapping: Awaited<ReturnType<typeof readMappingRequest>>;
  try {
    mapping = await readMappingRequest(args.file);
  } catch (error) {
    return printCliFailure(
      'billing migration apply',
      mappingFileFailure(args.file, error),
      args.json,
    );
  }

  let approved: Awaited<ReturnType<typeof readApprovedPreview>>;
  try {
    approved = await readApprovedPreview(args.previewFile);
  } catch (error) {
    return printCliFailure(
      'billing migration apply',
      approvedPreviewFileFailure(args.previewFile, error),
      args.json,
    );
  }
  if (!approved.preview.ready) {
    return printCliFailure(
      'billing migration apply',
      blockedApprovedPreview(args.previewFile, approved.preview.blockers),
      args.json,
    );
  }

  let legacyPlanEvidence: Awaited<ReturnType<typeof readPlanEvidence>>;
  try {
    legacyPlanEvidence = await readPlanEvidence(args.planEvidenceFile);
  } catch (error) {
    return printCliFailure(
      'billing migration apply',
      planEvidenceFileFailure(args.planEvidenceFile, error),
      args.json,
    );
  }

  if (!args.yes) {
    const organizations =
      approved.preview.organizations.length + approved.preview.linkedOrganizations.length;
    const confirmed = await confirm(
      `Prepare shadow billing data for ${organizations} organizations? This writes billing accounts and links, but does not start enforcement, usage metering, or the 90-day grant clock.`,
      { initial: false },
    );
    if (!confirmed) {
      console.error('billing migration apply: cancelled');
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
    return printCliFailure('billing migration apply', missingLogin(), args.json);
  }
  if (
    normalizeService(approved.service) !== resolved.serviceUrl ||
    normalizeService(legacyPlanEvidence.service) !== resolved.serviceUrl
  ) {
    return printCliFailure(
      'billing migration apply',
      evidenceServiceMismatch(resolved.serviceUrl),
      args.json,
    );
  }

  const request: LegacyBillingMigrationApplyRequest = {
    schemaVersion: 1,
    mode: args.mode,
    mappings: mapping.mappings ?? [],
    expectedPreviewChecksum: approved.preview.previewChecksum,
    legacyPlanEvidence,
    idempotencyKey: args.idempotencyKey,
    reason: args.reason,
    confirmed: true,
  };

  try {
    const body = LegacyBillingMigrationApplyClientResponseSchema.parse(
      await serviceJson<unknown>(
        `${resolved.serviceUrl}/v1/billing-accounts/migrations/legacy/apply`,
        resolved.token,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        },
      ),
    );
    if (args.json) printJsonOk({ service: resolved.serviceUrl, migration: body.data });
    else printHumanApply(body.data);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure('billing migration apply', applyServiceFailure(error, args), args.json);
  }
}

function printHumanApply(result: LegacyBillingMigrationApplyResult): void {
  console.log(`Billing migration: ${result.replayed ? 'ALREADY PREPARED' : 'PREPARED'}`);
  console.log(`Organizations: ${result.counts.organizations}`);
  console.log(
    `Billing accounts: ${result.counts.accountsCreated} created, ${result.counts.accountsReused} reused`,
  );
  console.log(
    `Organization links: ${result.counts.linksCreated} created, ${result.counts.linksPreserved} preserved`,
  );
  console.log(`Migration ID: ${result.migrationId}`);
  if (result.replayed) {
    console.log('The existing shadow preparation was returned; no duplicate writes were made.');
  } else {
    console.log('Billing data was written. Enforcement remains unchanged.');
  }
  console.log('Usage metering has not started. No 90-day grant clock has started.');
}

function parseBillingApplyArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: BillingApplyArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  const values = new Map<string, string>();
  let json = false;
  let yes = false;
  const valueFlags = new Set([
    '--file',
    '--preview-file',
    '--plan-evidence',
    '--mode',
    '--reason',
    '--idempotency-key',
    '--service',
    '--auth-token',
  ]);
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') json = true;
    else if (arg === '--yes') yes = true;
    else if (arg !== undefined && valueFlags.has(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: applyUsage(`a value for ${arg} is required`) };
      }
      if (values.has(arg)) return { ok: false, error: applyUsage(`${arg} may be supplied once`) };
      values.set(arg, value);
      index++;
    } else {
      return { ok: false, error: applyUsage(`unknown argument: ${arg ?? ''}`) };
    }
  }

  for (const flag of [
    '--file',
    '--preview-file',
    '--plan-evidence',
    '--mode',
    '--reason',
    '--idempotency-key',
  ]) {
    if (!values.has(flag)) return { ok: false, error: applyUsage(`${flag} is required`) };
  }
  if (values.get('--mode') !== 'shadow') {
    return { ok: false, error: applyUsage('--mode must be shadow') };
  }

  return {
    ok: true,
    args: {
      file: values.get('--file') as string,
      previewFile: values.get('--preview-file') as string,
      planEvidenceFile: values.get('--plan-evidence') as string,
      mode: 'shadow',
      reason: values.get('--reason') as string,
      idempotencyKey: values.get('--idempotency-key') as string,
      ...(values.has('--service') ? { service: values.get('--service') as string } : {}),
      ...(values.has('--auth-token') ? { authToken: values.get('--auth-token') as string } : {}),
      json,
      yes,
    },
  };
}

function applyUsage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'Shadow preparation requires the reviewed mapping, preview, and plan-evidence files.',
    fix: 'Supply every required flag and use only --mode shadow.',
    next: 'noodle billing migration apply --file <mapping.json> --preview-file <ready-preview.json> --plan-evidence <plan-evidence.json> --mode shadow --reason <text> --idempotency-key <key> --yes',
    exitCode: EXIT.USAGE,
  };
}

function confirmationRequired(args: BillingApplyArgs): CliFailure {
  return {
    code: 'confirmation_required',
    message: 'billing migration shadow apply requires confirmation',
    cause: 'The operation writes billing accounts and organization links in shadow mode.',
    fix: 'Review the private evidence, then re-run with --yes.',
    next: `noodle billing migration apply --file ${args.file} --preview-file ${args.previewFile} --plan-evidence ${args.planEvidenceFile} --mode shadow --reason <text> --idempotency-key <key> --yes`,
    exitCode: EXIT.USAGE,
  };
}

function blockedApprovedPreview(
  file: string,
  blockers: readonly LegacyBillingMigrationBlocker[],
): CliFailure {
  const codes = blockers.map((blocker) => `${blocker.org}:${blocker.code}`).join(', ');
  return {
    code: 'approved_preview_blocked',
    message: 'The approved billing migration preview is not READY.',
    cause: codes.length > 0 ? codes : 'The saved preview is blocked.',
    fix: 'Resolve every blocker and capture a new READY preview.',
    next: `noodle billing migration preview --file <mapping.json> --json > ${file}`,
    exitCode: EXIT.FAILURE,
  };
}

function evidenceServiceMismatch(service: string): CliFailure {
  return {
    code: 'evidence_service_mismatch',
    message: 'The private migration evidence targets a different service.',
    cause: `The approved preview and plan evidence must both name ${service}.`,
    fix: 'Re-capture both evidence files from the exact service being migrated.',
    next: `noodle billing migration preview --service ${service} --file <mapping.json> --json`,
    exitCode: EXIT.FAILURE,
  };
}

function applyServiceFailure(error: unknown, args: BillingApplyArgs): CliFailure {
  const failure = serviceFailure(
    'billing migration apply',
    error,
    `noodle billing migration apply --file ${args.file} --preview-file ${args.previewFile} --plan-evidence ${args.planEvidenceFile} --mode shadow --reason <text> --idempotency-key ${args.idempotencyKey} --yes`,
  );
  if (!(error instanceof ServiceRequestError) || error.code === undefined) return failure;
  return { ...failure, code: error.code, message: error.message, cause: error.message };
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

function normalizeService(value: string): string {
  return value.replace(/\/+$/, '');
}
