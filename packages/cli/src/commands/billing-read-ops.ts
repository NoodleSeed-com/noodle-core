import type {
  BillingAccountResponse,
  BillingAccountsListResponse,
  OrgBillingResponse,
} from '@noodle-borg/wire-contracts';
import {
  BillingAccountClientResponseSchema,
  BillingAccountsListClientResponseSchema,
  OrgBillingClientResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { renderDetailCard } from '../detail-card.js';
import { detectColorMode, detectGlyphMode } from '../gradient.js';
import { type Column, renderTable } from '../table.js';
import {
  type AccountMeteringView,
  accountMeteringDetail,
  accountProductionAppsView,
  type EnforcementView,
  enforcementDetail,
  type OrgMeteringView,
  orgMeteringDetail,
  orgProductionAppsView,
  type ProductionAppsView,
} from './billing-read-view.js';
import { runBillingStripeAccountAction } from './billing-stripe-ops.js';
import { EXIT, printJsonOk } from './output.js';
import { resolveOrgTarget, stdoutTableOptions } from './resource-shared.js';
import { authRequired, type CliFailure, printCliFailure, serviceFailure } from './shared.js';

interface BillingReadArgs {
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly positional: readonly string[];
}

export async function runBillingAccounts(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const action = rest[0]?.startsWith('--') === true ? undefined : rest[0];
  const actionRest = action === undefined ? rest : rest.slice(1);
  if (action === 'checkout' || action === 'portal') {
    return runBillingStripeAccountAction(action, actionRest, env, home);
  }
  const parsed = parseBillingReadArgs(actionRest);
  if (!parsed.ok) return printCliFailure('billing accounts', parsed.error, rest.includes('--json'));
  const args = parsed.args;
  if (action === 'list') {
    if (args.positional.length > 0) {
      return printCliFailure(
        'billing accounts list',
        billingReadUsage('billing accounts list does not accept a positional argument'),
        args.json,
      );
    }
    return listBillingAccounts(args, env, home);
  }
  if (action === 'inspect') {
    const [billingAccountId, ...extra] = args.positional;
    if (billingAccountId === undefined || extra.length > 0) {
      return printCliFailure(
        'billing accounts inspect',
        billingReadUsage('billing accounts inspect requires exactly one account id'),
        args.json,
      );
    }
    return inspectBillingAccount(billingAccountId, args, env, home);
  }
  return printCliFailure(
    'billing accounts',
    billingReadUsage('billing accounts requires list, inspect, checkout, or portal'),
    args.json,
  );
}

export async function runBillingOrg(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const action = rest[0]?.startsWith('--') === true ? undefined : rest[0];
  const parsed = parseBillingReadArgs(action === undefined ? rest : rest.slice(1));
  if (!parsed.ok) return printCliFailure('billing org', parsed.error, rest.includes('--json'));
  const args = parsed.args;
  if (action !== 'inspect' || args.positional.length > 1) {
    return printCliFailure(
      'billing org',
      billingReadUsage('billing org requires inspect and at most one organization slug'),
      args.json,
    );
  }
  const target = resolveOrgTarget(args.positional[0], home);
  if (!target.ok) return printCliFailure('billing org inspect', target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    // A project may select the org, but its source-controlled service URL must
    // never redirect a saved control-plane credential to another origin.
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('billing org inspect', authRequired(), args.json);
  }
  try {
    const body = OrgBillingClientResponseSchema.parse(
      await serviceJson<unknown>(
        `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}/billing`,
        resolved.token,
      ),
    );
    if (args.json) printJsonOk({ service: resolved.serviceUrl, ...body.data });
    else printOrgBilling(body.data);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'billing org inspect',
      serviceFailure('billing org inspect', error, `noodle billing org inspect ${target.org}`),
      args.json,
    );
  }
}

async function listBillingAccounts(
  args: BillingReadArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('billing accounts list', authRequired(), args.json);
  }
  try {
    const body = BillingAccountsListClientResponseSchema.parse(
      await serviceJson<unknown>(`${resolved.serviceUrl}/v1/billing-accounts`, resolved.token),
    );
    if (args.json) printJsonOk({ service: resolved.serviceUrl, accounts: body.data.accounts });
    else printBillingAccounts(body.data.accounts);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'billing accounts list',
      serviceFailure('billing accounts list', error, 'noodle billing accounts list'),
      args.json,
    );
  }
}

async function inspectBillingAccount(
  billingAccountId: string,
  args: BillingReadArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('billing accounts inspect', authRequired(), args.json);
  }
  try {
    const body = BillingAccountClientResponseSchema.parse(
      await serviceJson<unknown>(
        `${resolved.serviceUrl}/v1/billing-accounts/${encodeURIComponent(billingAccountId)}`,
        resolved.token,
      ),
    );
    if (args.json) printJsonOk({ service: resolved.serviceUrl, ...body.data });
    else printBillingAccount(body.data);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'billing accounts inspect',
      accountInspectFailure(error, billingAccountId),
      args.json,
    );
  }
}

function parseBillingReadArgs(
  rest: readonly string[],
):
  | { readonly ok: true; readonly args: BillingReadArgs }
  | { readonly ok: false; readonly error: CliFailure } {
  let service: string | undefined;
  let authToken: string | undefined;
  let json = false;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === '--json') json = true;
    else if (arg === '--service' || arg === '--auth-token') {
      const value = rest[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        return { ok: false, error: billingReadUsage('a flag value is missing') };
      }
      if (arg === '--service') service = value;
      else authToken = value;
      index++;
    } else if (arg?.startsWith('--')) {
      return { ok: false, error: billingReadUsage(`unknown argument: ${arg}`) };
    } else if (arg !== undefined) positional.push(arg);
  }
  return {
    ok: true,
    args: {
      ...(service !== undefined ? { service } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
      json,
      positional,
    },
  };
}

function printBillingAccounts(accounts: BillingAccountsListResponse['data']['accounts']): void {
  if (accounts.length === 0) {
    console.log('No billing accounts found for this identity.');
    return;
  }
  const columns: readonly Column<(typeof accounts)[number]>[] = [
    { header: 'ACCOUNT ID', get: (account) => account.id, maxWidth: 39 },
    { header: 'NAME', get: (account) => account.displayName, maxWidth: 28 },
    { header: 'PLAN', get: (account) => account.plan?.code ?? 'Unfunded' },
    { header: 'ROLE', get: (account) => account.role },
    { header: 'ORGS', get: (account) => String(account.linkedOrganizationCount), align: 'right' },
    { header: 'DEFAULT', get: (account) => (account.isDefault ? 'Yes' : 'No') },
    { header: 'STATE', get: (account) => account.state },
  ];
  console.log(renderTable(columns, accounts, stdoutTableOptions()));
}

function printBillingAccount(data: BillingAccountResponse['data']): void {
  const included = numberEntitlement(data.entitlement?.entitlements['usage.mcp_calls.included']);
  const overage = data.entitlement?.entitlements['usage.mcp_calls.overage'];
  const migration = data.legacyMigration;
  const migrationValue =
    migration.state === 'not_applicable'
      ? 'Not applicable'
      : migration.grant.state === 'pending_activation'
        ? 'Pending activation'
        : 'Prepared; no grant required';
  const migrationNote =
    migration.state === 'prepared' && migration.grant.state === 'pending_activation'
      ? '90-day clock has not started'
      : undefined;
  const production = accountProductionAppsView(
    data.productionApps as unknown as ProductionAppsView,
  );
  const metering = accountMeteringDetail(data.metering as AccountMeteringView);
  const enforcement = enforcementDetail(data.enforcement as EnforcementView);
  console.log(
    renderDetailCard(
      data.account.displayName,
      [
        { key: 'Account', value: data.account.id },
        { key: 'Plan', value: data.account.plan?.code ?? 'Unfunded' },
        { key: 'Role', value: data.account.role },
        { key: 'Default', value: data.account.isDefault ? 'Yes' : 'No' },
        { key: 'State', value: data.account.state },
        { key: 'Linked orgs', value: String(data.account.linkedOrganizationCount) },
        {
          key: 'Included calls',
          value: included === null ? 'Unavailable' : formatNumber(included),
        },
        {
          key: 'Production apps',
          value: production.value,
          note: production.note,
        },
        { key: 'Overage', value: formatEntitlement(overage) },
        {
          key: 'Subscriptions',
          value: data.commerce.state === 'available' ? 'Available through Stripe' : 'Unavailable',
        },
        { key: 'Metering', value: metering.value, tone: 'attention', note: metering.note },
        {
          key: 'Enforcement',
          value: enforcement.value,
          tone: 'attention',
          note: enforcement.note,
        },
        {
          key: 'Migration',
          value: migrationValue,
          tone: 'attention',
          ...(migrationNote ? { note: migrationNote } : {}),
        },
      ],
      detailOptions(),
      ['noodle billing accounts list'],
    ),
  );
  if (data.linkedOrganizations.length > 0) {
    const columns: readonly Column<(typeof data.linkedOrganizations)[number]>[] = [
      { header: 'ORG', get: (link) => link.org },
      { header: 'LINK', get: (link) => String(link.linkVersion), align: 'right' },
      { header: 'HOME FREE', get: (link) => accountReferenceLabel(link.homeFreeBillingAccount) },
      { header: 'FALLBACK', get: (link) => accountReferenceLabel(link.fallbackBillingAccount) },
    ];
    console.log('');
    console.log(renderTable(columns, data.linkedOrganizations, stdoutTableOptions()));
  }
}

function printOrgBilling(data: OrgBillingResponse['data']): void {
  const included = numberEntitlement(data.entitlements['usage.mcp_calls.included']);
  const production = orgProductionAppsView(data.productionApps as unknown as ProductionAppsView);
  const metering = orgMeteringDetail(data.metering as OrgMeteringView);
  const enforcement = enforcementDetail(data.enforcement as EnforcementView);
  console.log(
    renderDetailCard(
      `${data.org} billing`,
      [
        { key: 'Effective plan', value: data.plan.code },
        {
          key: 'Included calls',
          value: included === null ? 'Unavailable' : formatNumber(included),
        },
        {
          key: 'Production apps',
          value: production.value,
          note: production.note,
        },
        { key: 'Overage', value: formatEntitlement(data.entitlements['usage.mcp_calls.overage']) },
        { key: 'Metering', value: metering.value, tone: 'attention', note: metering.note },
        {
          key: 'Enforcement',
          value: enforcement.value,
          tone: 'attention',
          note: enforcement.note,
        },
      ],
      detailOptions(),
      ['noodle billing accounts list'],
    ),
  );
}

function detailOptions() {
  return { color: detectColorMode(process.stdout), glyph: detectGlyphMode() } as const;
}

function numberEntitlement(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatEntitlement(value: unknown): string {
  if (value === true) return 'Enabled';
  if (value === false) return 'Disabled';
  if (value === null || value === undefined) return 'Unavailable';
  return String(value);
}

function accountReferenceLabel(
  reference: BillingAccountResponse['data']['linkedOrganizations'][number]['homeFreeBillingAccount'],
): string {
  if (reference.relationship === 'current') return 'Current account';
  if (reference.relationship === 'member') return reference.billingAccountId;
  return 'External account';
}

function accountInspectFailure(error: unknown, billingAccountId: string): CliFailure {
  if (error instanceof ServiceRequestError && error.status === 404) {
    return {
      code: 'not_found',
      message: `billing account "${billingAccountId}" was not found`,
      cause: 'The account does not exist or this identity is not a billing member.',
      fix: 'Check the account id or list the billing accounts available to this identity.',
      next: 'noodle billing accounts list',
      exitCode: EXIT.FAILURE,
    };
  }
  return serviceFailure(
    'billing accounts inspect',
    error,
    `noodle billing accounts inspect ${billingAccountId}`,
  );
}

function billingReadUsage(message: string): CliFailure {
  return {
    code: 'usage',
    message,
    cause: 'The billing read command or one of its arguments is invalid.',
    fix: 'Choose an account list, inspect, checkout, or portal command, or inspect an organization.',
    next: 'noodle billing --help',
    exitCode: EXIT.USAGE,
  };
}
