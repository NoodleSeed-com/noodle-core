import type {
  BillingOrganizationTransferApplyResponse,
  BillingOrganizationTransferArtifact,
  BillingOrganizationTransferAuthorityPath,
  BillingOrganizationTransferCandidatesResponse,
  BillingOrganizationTransferPreviewResponse,
} from '@noodle-borg/wire-contracts';
import {
  BILLING_ORGANIZATION_TRANSFER_ERROR_CODES,
  BillingAdministrationTransferApplyRequestSchema,
  BillingAdministrationTransferPreviewRequestSchema,
  BillingOrganizationTransferApplyClientResponseSchema,
  BillingOrganizationTransferApplyRequestSchema,
  BillingOrganizationTransferCandidatesClientResponseSchema,
  BillingOrganizationTransferCandidatesRequestSchema,
  BillingOrganizationTransferPreviewClientResponseSchema,
  BillingOrganizationTransferPreviewRequestSchema,
  normalizeBillingOrganizationTransferServiceOrigin,
} from '@noodle-borg/wire-contracts';
import { type ConfigLocation, readConfig, resolveServiceUrl } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { DEFAULT_SERVICE_URL } from '../deploy.js';
import {
  assertBillingTransferArtifactDestination,
  readBillingTransferArtifact,
  writeBillingTransferArtifact,
} from './billing-org-transfer-files.js';
import { EXIT, printJsonOk } from './output.js';
import { authRequired, type CliFailure, parseCommandFlags, printCliFailure } from './shared.js';

type CandidatePage = BillingOrganizationTransferCandidatesResponse['data'];
type TransferPreview = BillingOrganizationTransferPreviewResponse['data'];
type TransferResult = BillingOrganizationTransferApplyResponse['data'];

interface CommonArgs {
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

const STABLE_TRANSFER_CODES: ReadonlySet<string> = new Set(
  BILLING_ORGANIZATION_TRANSFER_ERROR_CODES,
);

export async function runBillingOrganizationTransfer(
  authorityPath: BillingOrganizationTransferAuthorityPath,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const action = rest[0];
  const actionRest = rest.slice(1);
  if (authorityPath === 'customer' && action === 'candidates') {
    return runCandidates(actionRest, env, home);
  }
  if (action === 'preview') return runPreview(authorityPath, actionRest, env, home);
  if (action === 'apply') return runApply(authorityPath, actionRest, env, home);
  const command = commandName(authorityPath, action ?? '');
  return printCliFailure(
    command,
    usageFailure(
      command,
      `${command} requires ${authorityPath === 'customer' ? 'candidates, preview, or apply' : 'preview or apply'}`,
    ),
    rest.includes('--json'),
  );
}

async function runCandidates(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const command = 'billing org transfer candidates';
  const parsedArgs = parseCandidatesArgs(rest, command);
  if (!parsedArgs.ok) return printCliFailure(command, parsedArgs.error, rest.includes('--json'));
  const args = parsedArgs.args;
  const request = BillingOrganizationTransferCandidatesRequestSchema.safeParse({
    ...(args.query === undefined ? {} : { query: args.query }),
    ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
  });
  const destination = BillingOrganizationTransferPreviewRequestSchema.safeParse({
    schemaVersion: 1,
    destinationBillingAccountId: args.account,
  });
  if (!request.success || !destination.success) {
    return printCliFailure(
      command,
      usageFailure(command, 'candidate arguments failed validation'),
      args.json,
    );
  }
  const configuredOrigin = configuredServiceOrigin(args, env, home, command);
  if (!configuredOrigin.ok) return printCliFailure(command, configuredOrigin.error, args.json);
  const resolved = await resolveControlPlaneToken(commonResolution(args, env, home));
  if (resolved.token === undefined) return printCliFailure(command, authRequired(), args.json);
  const normalized = parsedServiceOrigin(resolved.serviceUrl, command);
  if (!normalized.ok) return printCliFailure(command, normalized.error, args.json);
  const service = normalized.origin;
  if (service !== configuredOrigin.origin) {
    return printCliFailure(command, serviceOriginFailure(command), args.json);
  }
  const query = new URLSearchParams();
  if (request.data.query !== undefined) query.set('query', request.data.query);
  if (request.data.cursor !== undefined) query.set('cursor', request.data.cursor);
  query.set('limit', String(request.data.limit));
  const url = `${service}/v1/billing-accounts/${encodeURIComponent(destination.data.destinationBillingAccountId)}/organization-transfer-candidates?${query.toString()}`;
  try {
    const response = BillingOrganizationTransferCandidatesClientResponseSchema.parse(
      await serviceJson<unknown>(url, resolved.token),
    );
    if (args.json) printJsonOk({ service, candidates: response.data });
    else printCandidatePage(response.data);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(command, transferServiceFailure(error, command), args.json);
  }
}

async function runPreview(
  authorityPath: BillingOrganizationTransferAuthorityPath,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const command = commandName(authorityPath, 'preview');
  const parsedArgs = parsePreviewArgs(authorityPath, rest, command);
  if (!parsedArgs.ok) return printCliFailure(command, parsedArgs.error, rest.includes('--json'));
  const args = parsedArgs.args;
  let request: BillingOrganizationTransferArtifact['request'];
  if (authorityPath === 'customer') {
    const parsed = BillingAdministrationTransferPreviewRequestSchema.omit({
      administrativeReason: true,
    }).safeParse({
      schemaVersion: 1,
      organizationSlug: args.org,
      destinationBillingAccountId: args.account,
    });
    if (!parsed.success) {
      return printCliFailure(
        command,
        usageFailure(command, 'preview arguments failed validation'),
        args.json,
      );
    }
    request = parsed.data;
  } else {
    const parsed = BillingAdministrationTransferPreviewRequestSchema.safeParse({
      schemaVersion: 1,
      organizationSlug: args.org,
      destinationBillingAccountId: args.account,
      administrativeReason: args.reason,
    });
    if (!parsed.success) {
      return printCliFailure(
        command,
        usageFailure(command, 'preview arguments failed validation'),
        args.json,
      );
    }
    request = parsed.data;
  }
  try {
    await assertBillingTransferArtifactDestination(args.out);
  } catch {
    return printCliFailure(
      command,
      artifactDestinationFailure(args.out, privateInputs(args)),
      args.json,
    );
  }
  const configuredOrigin = configuredServiceOrigin(args, env, home, command);
  if (!configuredOrigin.ok) return printCliFailure(command, configuredOrigin.error, args.json);
  const resolved = await resolveControlPlaneToken(commonResolution(args, env, home));
  if (resolved.token === undefined) return printCliFailure(command, authRequired(), args.json);
  const normalized = parsedServiceOrigin(resolved.serviceUrl, command);
  if (!normalized.ok) return printCliFailure(command, normalized.error, args.json);
  const service = normalized.origin;
  if (service !== configuredOrigin.origin) {
    return printCliFailure(command, serviceOriginFailure(command), args.json);
  }
  const url =
    authorityPath === 'customer'
      ? `${service}/v1/orgs/${encodeURIComponent(args.org)}/billing-transfer/preview`
      : `${service}/v1/billing-administration/organization-transfers/preview`;
  try {
    const serviceRequest =
      authorityPath === 'customer'
        ? BillingOrganizationTransferPreviewRequestSchema.parse({
            schemaVersion: request.schemaVersion,
            destinationBillingAccountId: request.destinationBillingAccountId,
          })
        : request;
    const response = BillingOrganizationTransferPreviewClientResponseSchema.parse(
      await serviceJson<unknown>(url, resolved.token, jsonPost(serviceRequest)),
    );
    const artifact = {
      schemaVersion: 1,
      serviceOrigin: service,
      authorityPath,
      request,
      preview: response.data,
    } as BillingOrganizationTransferArtifact;
    await writeBillingTransferArtifact(args.out, artifact);
    if (args.json) {
      printJsonOk({
        service,
        authority: authorityPath,
        ...(authorityPath === 'super_admin'
          ? {
              administrativeReason: (request as { administrativeReason: string })
                .administrativeReason,
            }
          : {}),
        preview: response.data,
        previewFile: args.out,
      });
    } else {
      printTransferPreview(
        response.data,
        args.out,
        authorityPath,
        authorityPath === 'super_admin'
          ? (request as { administrativeReason: string }).administrativeReason
          : undefined,
      );
    }
    return response.data.blockers.length === 0 ? EXIT.OK : EXIT.FAILURE;
  } catch (error) {
    const failure =
      error instanceof ServiceRequestError
        ? transferServiceFailure(error, command)
        : artifactDestinationFailure(args.out, privateInputs(args));
    return printCliFailure(command, failure, args.json);
  }
}

async function runApply(
  authorityPath: BillingOrganizationTransferAuthorityPath,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const command = commandName(authorityPath, 'apply');
  const parsedArgs = parseApplyArgs(rest, command);
  if (!parsedArgs.ok) return printCliFailure(command, parsedArgs.error, rest.includes('--json'));
  const args = parsedArgs.args;
  let artifact: BillingOrganizationTransferArtifact;
  try {
    artifact = await readBillingTransferArtifact(args.previewFile, authorityPath);
  } catch {
    return printCliFailure(
      command,
      artifactFailure(args.previewFile, [args.idempotencyKey]),
      args.json,
    );
  }
  if (artifact.preview.blockers.length > 0) {
    return printCliFailure(
      command,
      blockedArtifactFailure(args.previewFile, privateInputs(args, artifact)),
      args.json,
    );
  }
  const additions = {
    expectedLinkVersion: artifact.preview.expectedLinkVersion,
    previewChecksum: artifact.preview.previewChecksum,
    idempotencyKey: args.idempotencyKey,
    confirmed: true,
  } as const;
  const parsedRequest =
    authorityPath === 'customer'
      ? BillingOrganizationTransferApplyRequestSchema.safeParse({
          schemaVersion: artifact.request.schemaVersion,
          destinationBillingAccountId: artifact.request.destinationBillingAccountId,
          ...additions,
        })
      : BillingAdministrationTransferApplyRequestSchema.safeParse({
          ...artifact.request,
          ...additions,
        });
  if (!parsedRequest.success) {
    return printCliFailure(
      command,
      artifactFailure(args.previewFile, privateInputs(args, artifact)),
      args.json,
    );
  }
  const configuredOrigin = configuredServiceOrigin(args, env, home, command);
  if (!configuredOrigin.ok) return printCliFailure(command, configuredOrigin.error, args.json);
  if (configuredOrigin.origin !== artifact.serviceOrigin) {
    return printCliFailure(
      command,
      artifactFailure(args.previewFile, privateInputs(args, artifact)),
      args.json,
    );
  }
  const resolved = await resolveControlPlaneToken(commonResolution(args, env, home));
  const normalized = parsedServiceOrigin(resolved.serviceUrl, command);
  if (!normalized.ok) return printCliFailure(command, normalized.error, args.json);
  const currentService = normalized.origin;
  if (currentService !== artifact.serviceOrigin) {
    return printCliFailure(
      command,
      artifactFailure(args.previewFile, privateInputs(args, artifact)),
      args.json,
    );
  }
  if (resolved.token === undefined) return printCliFailure(command, authRequired(), args.json);
  const url =
    authorityPath === 'customer'
      ? `${artifact.serviceOrigin}/v1/orgs/${encodeURIComponent(artifact.request.organizationSlug)}/billing-transfer`
      : `${artifact.serviceOrigin}/v1/billing-administration/organization-transfers`;
  try {
    const response = BillingOrganizationTransferApplyClientResponseSchema.parse(
      await serviceJson<unknown>(url, resolved.token, jsonPost(parsedRequest.data)),
    );
    if (args.json)
      printJsonOk({
        service: artifact.serviceOrigin,
        authority: authorityPath,
        transfer: response.data,
      });
    else printTransferResult(response.data, authorityPath);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(command, transferServiceFailure(error, command), args.json);
  }
}

function parseCandidatesArgs(rest: readonly string[], command: string) {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--account': 'account',
      '--query': 'query',
      '--cursor': 'cursor',
      '--limit': 'limit',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  if (parsed.parseError !== undefined) return failedUsage(command, parsed.parseError);
  const duplicate = duplicateFlag(rest);
  if (duplicate !== undefined) return failedUsage(command, `${duplicate} may be supplied once`);
  if (parsed.positional.length > 0)
    return failedUsage(command, 'candidates accepts no positional arguments');
  if (parsed.account === undefined) return failedUsage(command, '--account is required');
  return {
    ok: true as const,
    args: {
      account: parsed.account,
      ...commonArgs(parsed),
      ...(parsed.query === undefined ? {} : { query: parsed.query }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    },
  };
}

function parsePreviewArgs(
  authorityPath: BillingOrganizationTransferAuthorityPath,
  rest: readonly string[],
  command: string,
) {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--account': 'account',
      '--reason': 'reason',
      '--out': 'out',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  if (parsed.parseError !== undefined) return failedUsage(command, parsed.parseError);
  const duplicate = duplicateFlag(rest);
  if (duplicate !== undefined) return failedUsage(command, `${duplicate} may be supplied once`);
  if (authorityPath === 'customer' && (parsed.org !== undefined || parsed.reason !== undefined))
    return failedUsage(command, 'unknown customer preview option');
  const org = authorityPath === 'customer' ? parsed.positional[0] : parsed.org;
  if (parsed.account === undefined) return failedUsage(command, '--account is required');
  if (parsed.out === undefined) return failedUsage(command, '--out is required');
  if (org === undefined)
    return failedUsage(
      command,
      authorityPath === 'customer' ? 'one organization slug is required' : '--org is required',
    );
  if (authorityPath === 'customer' && parsed.positional.length !== 1)
    return failedUsage(command, 'exactly one organization slug is required');
  if (authorityPath === 'super_admin' && parsed.positional.length > 0)
    return failedUsage(command, 'administrator preview accepts no positional arguments');
  if (authorityPath === 'super_admin' && parsed.reason === undefined)
    return failedUsage(command, '--reason is required');
  return {
    ok: true as const,
    args: {
      org,
      account: parsed.account,
      out: parsed.out,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      ...commonArgs(parsed),
    },
  };
}

function parseApplyArgs(rest: readonly string[], command: string) {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--preview-file': 'previewFile',
      '--idempotency-key': 'idempotencyKey',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--yes': 'yes', '--json': 'json' },
  });
  if (parsed.parseError !== undefined) return failedUsage(command, parsed.parseError);
  const duplicate = duplicateFlag(rest);
  if (duplicate !== undefined) return failedUsage(command, `${duplicate} may be supplied once`);
  if (parsed.positional.length > 0)
    return failedUsage(command, 'apply accepts no positional arguments');
  if (parsed.previewFile === undefined) return failedUsage(command, '--preview-file is required');
  if (parsed.idempotencyKey === undefined)
    return failedUsage(command, '--idempotency-key is required');
  if (!parsed.yes) return failedUsage(command, '--yes is required');
  return {
    ok: true as const,
    args: {
      previewFile: parsed.previewFile,
      idempotencyKey: parsed.idempotencyKey,
      ...commonArgs(parsed),
    },
  };
}

function duplicateFlag(rest: readonly string[]): string | undefined {
  const flags = rest.filter((argument) => argument.startsWith('--'));
  return flags.find((flag, index) => flags.indexOf(flag) !== index);
}

function commonArgs(parsed: {
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}): CommonArgs {
  return {
    ...(parsed.service === undefined ? {} : { service: parsed.service }),
    ...(parsed.authToken === undefined ? {} : { authToken: parsed.authToken }),
    json: parsed.json,
  };
}

function configuredServiceOrigin(
  args: CommonArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  command: string,
):
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly error: CliFailure } {
  try {
    return parsedServiceOrigin(
      resolveServiceUrl(args.service, env, readConfig(home)) ?? DEFAULT_SERVICE_URL,
      command,
    );
  } catch {
    return { ok: false, error: serviceOriginFailure(command) };
  }
}

function parsedServiceOrigin(
  value: string,
  command: string,
):
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly error: CliFailure } {
  try {
    return { ok: true, origin: normalizeBillingOrganizationTransferServiceOrigin(value) };
  } catch {
    return { ok: false, error: serviceOriginFailure(command) };
  }
}

function commonResolution(args: CommonArgs, env: NodeJS.ProcessEnv, home: ConfigLocation) {
  return { serviceFlag: args.service, authFlag: args.authToken, env, home };
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function printCandidatePage(page: CandidatePage): void {
  console.log(`Billing organization transfer candidates: ${page.items.length}`);
  if (page.items.length === 0) console.log('No owned organizations matched this request.');
  for (const candidate of page.items) {
    console.log(
      `${candidate.organization.displayName} (${candidate.organization.slug}) — ${candidate.state}`,
    );
    printCodes('Warnings', candidate.warnings);
    printCodes('Blockers', candidate.blockers);
  }
  console.log(`Next cursor: ${page.nextCursor ?? 'none'}`);
}

function printTransferPreview(
  preview: TransferPreview,
  file: string,
  authorityPath: BillingOrganizationTransferAuthorityPath,
  administrativeReason?: string,
): void {
  console.log(
    `Billing organization transfer preview: ${preview.blockers.length === 0 ? 'READY' : 'BLOCKED'}`,
  );
  console.log(`Authority: ${authorityPath === 'customer' ? 'CUSTOMER OWNER' : 'SUPER ADMIN'}`);
  if (administrativeReason !== undefined)
    console.log(`Administrative reason: ${administrativeReason}`);
  console.log(`Organization: ${preview.organization.displayName} (${preview.organization.slug})`);
  console.log(`Destination: ${preview.destination.displayName} (${preview.destination.id})`);
  console.log(
    `Plan: ${preview.currentPlan?.code ?? 'unavailable'} → ${preview.resultingPlan?.code ?? 'unavailable'}`,
  );
  console.log(
    `Production apps: ${preview.productionCapacity.prospective}/${preview.productionCapacity.limit} after move`,
  );
  console.log(`Fallback: ${preview.fallback}`);
  printCodes('Warnings', preview.warnings);
  printCodes('Blockers', preview.blockers);
  console.log(`Reviewed preview: ${file}`);
  console.log('No changes were made.');
}

function printTransferResult(
  result: TransferResult,
  authorityPath: BillingOrganizationTransferAuthorityPath,
): void {
  console.log(`Billing organization transfer: ${result.replayed ? 'ALREADY APPLIED' : 'APPLIED'}`);
  console.log(`Authority: ${authorityPath === 'customer' ? 'CUSTOMER OWNER' : 'SUPER ADMIN'}`);
  console.log(`Operation ID: ${result.operationId}`);
  console.log(`Organization: ${result.organization.displayName} (${result.organization.slug})`);
  console.log(`Destination: ${result.destination.displayName} (${result.destination.id})`);
  console.log(`Resulting plan: ${result.resultingPlan.code}`);
  console.log(
    `Production apps: ${result.productionCapacity.prospective}/${result.productionCapacity.limit}`,
  );
  console.log(`Effective: ${result.effectiveAt}`);
  console.log(`Audit recorded: ${result.recordedAt}`);
  printCodes('Warnings', result.warnings);
  if (result.replayed)
    console.log('The exact stored result was returned; no duplicate transfer was made.');
}

function printCodes(label: string, codes: readonly string[]): void {
  console.log(`${label}: ${codes.length}`);
  for (const code of codes) console.log(`  [${code}]`);
}

function commandName(
  authorityPath: BillingOrganizationTransferAuthorityPath,
  action: string,
): string {
  return authorityPath === 'customer'
    ? `billing org transfer${action.length > 0 ? ` ${action}` : ''}`
    : `billing administration transfer${action.length > 0 ? ` ${action}` : ''}`;
}

function usageFailure(command: string, message: string): CliFailure {
  return {
    code: 'usage_error',
    message,
    cause: 'The billing organization transfer arguments are invalid.',
    fix: 'Supply every required exact-review input.',
    next: `noodle ${command} --help`,
    exitCode: EXIT.USAGE,
  };
}

function failedUsage(command: string, message: string) {
  return { ok: false as const, error: usageFailure(command, message) };
}

function artifactFailure(
  file: string,
  privateValues: readonly (string | undefined)[] = [],
): CliFailure {
  const location = redact(file, privateValues);
  return {
    code: 'invalid_billing_transfer_preview_file',
    message: `Cannot use billing organization transfer preview file ${location}.`,
    cause:
      'The private preview file is missing, unsafe, malformed, mismatched, or no longer exact.',
    fix: 'Capture a fresh private preview from the same service and authority path; do not edit it.',
    next: 'Run the matching billing organization transfer preview command again.',
    exitCode: EXIT.FAILURE,
  };
}

function artifactDestinationFailure(
  file: string,
  privateValues: readonly (string | undefined)[],
): CliFailure {
  const location = redact(file, privateValues);
  return {
    code: 'invalid_billing_transfer_preview_file',
    message: `Cannot write billing organization transfer preview file ${location}.`,
    cause: 'The output path is unsafe, unavailable, or already exists.',
    fix: 'Choose a new output path; reviewed preview artifacts are never overwritten.',
    next: 'Run the matching billing organization transfer preview command with a new --out path.',
    exitCode: EXIT.FAILURE,
  };
}

function blockedArtifactFailure(
  file: string,
  privateValues: readonly (string | undefined)[],
): CliFailure {
  const location = redact(file, privateValues);
  return {
    code: 'billing_transfer_preview_blocked',
    message: `The reviewed billing organization transfer preview at ${location} is blocked.`,
    cause: 'The saved preview contains one or more blockers.',
    fix: 'Resolve every blocker and capture a fresh preview.',
    next: 'Run the matching billing organization transfer preview command again.',
    exitCode: EXIT.FAILURE,
  };
}

function serviceOriginFailure(command: string): CliFailure {
  return {
    code: 'invalid_service_origin',
    message: 'The billing organization transfer service must be one HTTP(S) origin.',
    cause: 'The configured service includes an invalid URL, credentials, path, query, or fragment.',
    fix: 'Use only the canonical control-plane origin.',
    next: `noodle ${command} --service <https-origin>`,
    exitCode: EXIT.USAGE,
  };
}

function transferServiceFailure(error: unknown, command: string): CliFailure {
  const service = error instanceof ServiceRequestError ? error : undefined;
  const auth = service?.status === 401 || service?.status === 403;
  const unreachable = service?.status === 0;
  const code =
    service?.code !== undefined && STABLE_TRANSFER_CODES.has(service.code)
      ? service.code
      : auth
        ? 'auth_failed'
        : unreachable
          ? 'service_unreachable'
          : 'service_error';
  return {
    code,
    message: auth
      ? 'The billing organization transfer request was not authorized.'
      : unreachable
        ? 'The billing organization transfer service could not be reached.'
        : 'The billing organization transfer request failed.',
    cause: auth
      ? 'The current identity is not authorized for this transfer authority path.'
      : unreachable
        ? 'The service outcome is uncertain; preserve the reviewed preview file and private idempotency key.'
        : 'The service rejected the request without exposing private billing details.',
    fix: unreachable
      ? 'Retry the exact apply with the same preview file and private idempotency key.'
      : 'Check the typed failure and capture a fresh preview when required.',
    next: unreachable
      ? `noodle ${command} --preview-file <same-reviewed-preview.json> --idempotency-key <same-private-key> --yes`
      : `noodle ${command} --help`,
    exitCode: auth ? EXIT.AUTH : unreachable ? EXIT.UNREACHABLE : EXIT.FAILURE,
  };
}

function privateInputs(
  args: { readonly reason?: string; readonly idempotencyKey?: string },
  artifact?: BillingOrganizationTransferArtifact,
): readonly (string | undefined)[] {
  return [
    args.reason,
    args.idempotencyKey,
    artifact?.authorityPath === 'super_admin' ? artifact.request.administrativeReason : undefined,
  ];
}

function redact(value: string, privateValues: readonly (string | undefined)[]): string {
  return privateValues.reduce<string>(
    (safe, privateValue) =>
      privateValue === undefined || privateValue.length === 0
        ? safe
        : safe.split(privateValue).join('[redacted]'),
    value,
  );
}
