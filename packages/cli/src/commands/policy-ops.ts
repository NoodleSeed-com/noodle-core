import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { type RGB, ROSE } from '../gradient.js';
import { relativeTime } from '../relative-time.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { EXIT, printJsonFailure, printJsonOk, printRawJsonForHumanDebug } from './output.js';
import {
  ACTIVE_GREEN,
  ARCHIVED_AMBER,
  DIM_GRAY,
  dimText,
  stdoutTableOptions,
} from './resource-shared.js';
import { missingLogin, printCliFailure, serviceFailure } from './shared.js';

type Category = 'protocol' | 'discovery' | 'read' | 'execute';
type Scope =
  | { readonly level: 'platform' }
  | { readonly level: 'org'; readonly org: string }
  | { readonly level: 'app'; readonly org: string; readonly app: string }
  | { readonly level: 'env'; readonly org: string; readonly app: string; readonly env: string }
  | { readonly level: 'deployment'; readonly deploymentId: string }
  | {
      readonly level: 'operation';
      readonly org: string;
      readonly app: string;
      readonly env: string;
      readonly name: string;
    };

interface PolicyArgs {
  readonly serviceFlag?: string;
  readonly authFlag?: string;
  readonly org?: string;
  readonly app?: string;
  readonly envName?: string;
  readonly deploymentId?: string;
  readonly operation?: string;
  readonly reason?: string;
  readonly file?: string;
  readonly id?: string;
  readonly externalRef?: string;
  readonly idempotencyKey?: string;
  readonly limit?: number;
  readonly windowSeconds?: number;
  readonly burst?: number;
  readonly partition?: 'subject' | 'route';
  readonly expectedVersion?: number;
  readonly json: boolean;
  readonly history: boolean;
}

export async function runPolicy(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation = homedir(),
): Promise<number> {
  const [action, maybeCategory, ...tail] = rest;
  const json = rest.includes('--json');
  if (action === undefined || action === 'help') return usage(json);
  if (action === 'plan') {
    return runPlan(maybeCategory, tail, env, home, json);
  }
  const category = isCategory(maybeCategory) ? maybeCategory : undefined;
  let args: PolicyArgs;
  try {
    args = parseArgs(
      category === undefined && maybeCategory !== undefined ? [maybeCategory, ...tail] : tail,
    );
  } catch (error) {
    return usage(json, error instanceof Error ? error.message : String(error));
  }
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return missingLogin(`policy ${action}`, args.json);
  }
  try {
    if (action === 'status') return status(resolved.serviceUrl, resolved.token, args);
    if (action === 'list') return list(resolved.serviceUrl, resolved.token, args);
    if (action === 'show') return show(resolved.serviceUrl, resolved.token, args, maybeCategory);
    if (action === 'effective') return effective(resolved.serviceUrl, resolved.token, args, false);
    if (action === 'simulate') return effective(resolved.serviceUrl, resolved.token, args, true);
    if (action === 'usage') return usageCommand(resolved.serviceUrl, resolved.token, args);
    if (action === 'apply') return applyFile(resolved.serviceUrl, resolved.token, args);
    if (action === 'delete')
      return deletePolicy(resolved.serviceUrl, resolved.token, args, maybeCategory);
    if (action === 'suspend')
      return guided(resolved.serviceUrl, resolved.token, args, suspend(args));
    if (action === 'resume')
      return deletePolicy(resolved.serviceUrl, resolved.token, args, suspendId(args));
    if (action === 'deny' && category !== undefined) {
      return guided(resolved.serviceUrl, resolved.token, args, deny(args, category));
    }
    if (action === 'quota' && category !== undefined) {
      return guided(resolved.serviceUrl, resolved.token, args, quota(args, category));
    }
    if (action === 'rate' && category !== undefined) {
      return guided(resolved.serviceUrl, resolved.token, args, rate(args, category));
    }
  } catch (error) {
    return printCliFailure(
      `policy ${action}`,
      serviceFailure(`policy ${action}`, error, 'noodle policy status'),
      args.json,
    );
  }
  return usage(args.json);
}

async function runPlan(
  action: string | undefined,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  jsonMode: boolean,
): Promise<number> {
  if (action === undefined || action === 'help') return planUsage(jsonMode);
  let args: PolicyArgs;
  try {
    args = parseArgs(rest);
  } catch (error) {
    return planUsage(jsonMode, error instanceof Error ? error.message : String(error));
  }
  const validation = validatePlanArgs(action, args, jsonMode);
  if (validation !== undefined) return validation;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.serviceFlag,
    authFlag: args.authFlag,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return missingLogin(`policy plan ${action}`, args.json);
  }
  try {
    if (action === 'show') return planShow(resolved.serviceUrl, resolved.token, args);
    if (action === 'set') return planSet(resolved.serviceUrl, resolved.token, args);
    if (action === 'suspend') return planSuspend(resolved.serviceUrl, resolved.token, args);
  } catch (error) {
    return printCliFailure(
      `policy plan ${action}`,
      serviceFailure(`policy plan ${action}`, error, 'noodle policy plan show --org <slug>'),
      args.json,
    );
  }
  return planUsage(jsonMode || args.json);
}

async function status(serviceUrl: string, token: string, args: PolicyArgs): Promise<number> {
  const body = await serviceJson<{ ok: true; capabilities: readonly string[] }>(
    `${serviceUrl}/v1/service/capabilities`,
    token,
  );
  const enabled = body.capabilities.includes('controls');
  if (args.json) {
    printJsonOk({ service: serviceUrl, enabled, status: enabled ? 'enabled' : 'disabled' });
  } else {
    console.log(`service: ${serviceUrl}`);
    console.log(`policy: ${enabled ? 'enabled' : 'disabled'}`);
  }
  return enabled ? 0 : 1;
}

async function list(serviceUrl: string, token: string, args: PolicyArgs): Promise<number> {
  const body = await serviceJson<{ ok: true; policies: readonly Record<string, unknown>[] }>(
    policyUrl(serviceUrl, args).toString(),
    token,
  );
  if (args.json) printJsonOk({ ...body, service: serviceUrl });
  else {
    if (body.policies.length > 0) {
      console.log(renderPoliciesTable(body.policies, stdoutTableOptions()));
    }
    console.log(dimText(`\n${body.policies.length} policy assignment(s).`, process.stdout));
  }
  return 0;
}

// --- table rendering ---------------------------------------------------------------

/** Derive the display state of one policy assignment from its document. */
function policyState(policy: Record<string, unknown>): 'active' | 'suspended' | 'denied' {
  const doc = policy.policy as
    | {
        readonly suspended?: unknown;
        readonly categories?: Record<string, { readonly effect?: unknown } | undefined>;
      }
    | undefined;
  if (doc?.suspended === true) return 'suspended';
  for (const rule of Object.values(doc?.categories ?? {})) {
    if (rule?.effect === 'deny') return 'denied';
  }
  return 'active';
}

const POLICY_STATE_COLORS: Record<string, RGB> = {
  active: ACTIVE_GREEN,
  suspended: ARCHIVED_AMBER,
  denied: ROSE,
};

// UPDATED renders the assignment's `createdAt`: every policy write lands as a new version with a
// fresh `createdAt`, so the newest version's timestamp is the last-updated time.
const POLICY_COLUMNS: readonly Column<Record<string, unknown>>[] = [
  { header: 'POLICY', get: (p) => String(p.id) },
  { header: 'SCOPE', get: (p) => scopeLabel(p.scope as Scope) },
  {
    header: 'STATE',
    get: (p) => policyState(p),
    color: (p) => POLICY_STATE_COLORS[policyState(p)],
  },
  {
    header: 'UPDATED',
    get: (p) => (typeof p.createdAt === 'string' ? relativeTime(p.createdAt) : '—'),
    align: 'right',
    color: () => DIM_GRAY,
  },
];

/** Render the `policy list` table (founder-approved design, 2026-07-06). Exported for tests. */
export function renderPoliciesTable(
  policies: readonly Record<string, unknown>[],
  opts: TableOptions,
): string {
  return renderTable(POLICY_COLUMNS, policies, opts);
}

async function show(
  serviceUrl: string,
  token: string,
  args: PolicyArgs,
  rawId: string | undefined,
): Promise<number> {
  const id = args.id ?? rawId;
  if (id === undefined) throw new Error('policy show requires an id');
  const url = policyUrl(serviceUrl, args, id, args.history ? 'history' : undefined);
  const body = await serviceJson<Record<string, unknown>>(url.toString(), token);
  if (args.json) printJsonOk({ ...body, service: serviceUrl });
  else printRawJsonForHumanDebug(body, 2);
  return 0;
}

async function effective(
  serviceUrl: string,
  token: string,
  args: PolicyArgs,
  simulate: boolean,
): Promise<number> {
  const url = policyUrl(serviceUrl, args, simulate ? 'simulate' : 'effective');
  const body = await serviceJson<Record<string, unknown>>(url.toString(), token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: context(args),
      ...(simulate && args.file !== undefined ? { assignment: await readJson(args.file) } : {}),
    }),
  });
  if (args.json) printJsonOk({ ...body, service: serviceUrl });
  else printRawJsonForHumanDebug(body, 2);
  return 0;
}

async function usageCommand(serviceUrl: string, token: string, args: PolicyArgs): Promise<number> {
  const body = await serviceJson<Record<string, unknown>>(
    policyUrl(serviceUrl, args, 'usage').toString(),
    token,
  );
  if (args.json) printJsonOk({ ...body, service: serviceUrl });
  else printRawJsonForHumanDebug(body, 2);
  return 0;
}

async function applyFile(serviceUrl: string, token: string, args: PolicyArgs): Promise<number> {
  if (args.file === undefined) throw new Error('policy apply requires --file');
  const assignment = await readJson(args.file);
  return guided(serviceUrl, token, args, assignment);
}

async function guided(
  serviceUrl: string,
  token: string,
  args: PolicyArgs,
  assignment: unknown,
): Promise<number> {
  const body = await serviceJson<Record<string, unknown>>(
    policyUrl(serviceUrl, args).toString(),
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(assignment as Record<string, unknown>),
        source: 'cli',
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      }),
    },
  );
  if (args.json) printJsonOk({ ...body, service: serviceUrl });
  else console.log(`applied ${String((body.policy as { id?: unknown })?.id ?? '')}`);
  return 0;
}

async function deletePolicy(
  serviceUrl: string,
  token: string,
  args: PolicyArgs,
  rawId: string | undefined,
): Promise<number> {
  const id = args.id ?? rawId;
  if (id === undefined) throw new Error('policy delete requires an id');
  const body = await serviceJson<Record<string, unknown>>(
    policyUrl(serviceUrl, args, id).toString(),
    token,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reason: args.reason ?? 'operator_delete',
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      }),
    },
  );
  if (args.json) printJsonOk({ ...body, service: serviceUrl });
  else console.log(`deleted ${id}`);
  return 0;
}

async function planShow(serviceUrl: string, token: string, args: PolicyArgs): Promise<number> {
  const body = await serviceJson<Record<string, unknown>>(
    planUrl(serviceUrl, args).toString(),
    token,
  );
  printPlan(body, serviceUrl, args);
  return 0;
}

async function planSet(serviceUrl: string, token: string, args: PolicyArgs): Promise<number> {
  const body = await serviceJson<Record<string, unknown>>(
    planUrl(serviceUrl, args).toString(),
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        plan: args.id,
        reason: args.reason,
        source: 'cli',
        ...(args.externalRef !== undefined ? { externalRef: args.externalRef } : {}),
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      }),
    },
  );
  printPlan(body, serviceUrl, args);
  return 0;
}

async function planSuspend(serviceUrl: string, token: string, args: PolicyArgs): Promise<number> {
  const body = await serviceJson<Record<string, unknown>>(
    planUrl(serviceUrl, args, 'suspend').toString(),
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reason: args.reason,
        source: 'cli',
        ...(args.externalRef !== undefined ? { externalRef: args.externalRef } : {}),
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      }),
    },
  );
  printPlan(body, serviceUrl, args);
  return 0;
}

function printPlan(body: Record<string, unknown>, serviceUrl: string, args: PolicyArgs): void {
  if (args.json) {
    printJsonOk({ ...body, service: serviceUrl });
    return;
  }
  const plan = body.plan as
    | {
        readonly org?: unknown;
        readonly plan?: unknown;
        readonly state?: unknown;
        readonly source?: unknown;
        readonly policyId?: unknown;
        readonly migrationRequired?: unknown;
        readonly commercial?: { readonly externalRef?: unknown };
      }
    | undefined;
  console.log(`org:    ${String(plan?.org ?? args.org ?? '')}`);
  console.log(`plan:   ${String(plan?.plan ?? 'unknown')}`);
  console.log(`state:  ${String(plan?.state ?? 'unknown')}`);
  if (plan?.commercial?.externalRef !== undefined) {
    console.log(`external: ${String(plan.commercial.externalRef)}`);
  }
  if (plan?.migrationRequired === true) console.log('migration: required');
  if (plan?.policyId !== undefined) console.log(`policy: ${String(plan.policyId)}`);
}

function suspend(args: PolicyArgs): Record<string, unknown> {
  const scope = scopeFromArgs(args);
  return {
    id: suspendId(args),
    reason: args.reason ?? 'suspended',
    scope,
    policy: { schemaVersion: 1, suspended: true, reason: args.reason ?? 'suspended' },
    ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
  };
}

function deny(args: PolicyArgs, category: Category): Record<string, unknown> {
  const scope = scopeFromArgs(args);
  return singleRule(args, scope, category, 'deny', {
    effect: 'deny',
    reason: args.reason ?? 'blocked_by_policy',
  });
}

function quota(args: PolicyArgs, category: Category): Record<string, unknown> {
  if (args.limit === undefined || args.windowSeconds === undefined) {
    throw new Error('policy quota requires --limit and --window');
  }
  return singleRule(args, scopeFromArgs(args), category, 'quota', {
    quota: { limit: args.limit, windowSeconds: args.windowSeconds },
  });
}

function rate(args: PolicyArgs, category: Category): Record<string, unknown> {
  if (args.limit === undefined || args.windowSeconds === undefined) {
    throw new Error('policy rate requires --limit and --window');
  }
  return singleRule(args, scopeFromArgs(args), category, 'rate', {
    rate: {
      algorithm: 'token-bucket',
      limit: args.limit,
      refillSeconds: args.windowSeconds,
      ...(args.burst !== undefined ? { burst: args.burst } : {}),
      ...(args.partition !== undefined ? { partitionBy: args.partition } : {}),
    },
  });
}

function singleRule(
  args: PolicyArgs,
  scope: Scope,
  category: Category,
  kind: 'deny' | 'quota' | 'rate',
  rule: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: `${scopeLabel(scope)}:${category}-${kind}`,
    reason: args.reason ?? kind,
    scope,
    policy: { schemaVersion: 1, categories: { [category]: rule } },
    ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
  };
}

function suspendId(args: PolicyArgs): string {
  return `${scopeLabel(scopeFromArgs(args))}:suspend`;
}

function scopeFromArgs(args: PolicyArgs): Scope {
  if (args.deploymentId !== undefined)
    return { level: 'deployment', deploymentId: args.deploymentId };
  if (args.org === undefined) return { level: 'platform' };
  if (args.operation !== undefined) {
    if (args.app === undefined || args.envName === undefined)
      throw new Error('--operation requires --app and --env');
    return {
      level: 'operation',
      org: args.org,
      app: args.app,
      env: args.envName,
      name: args.operation,
    };
  }
  if (args.app !== undefined && args.envName !== undefined) {
    return { level: 'env', org: args.org, app: args.app, env: args.envName };
  }
  if (args.app !== undefined) return { level: 'app', org: args.org, app: args.app };
  return { level: 'org', org: args.org };
}

function scopeLabel(scope: Scope): string {
  switch (scope.level) {
    case 'platform':
      return 'platform';
    case 'org':
      return `org:${scope.org}`;
    case 'app':
      return `app:${scope.org}:${scope.app}`;
    case 'env':
      return `env:${scope.org}:${scope.app}:${scope.env}`;
    case 'deployment':
      return `deployment:${scope.deploymentId}`;
    case 'operation':
      return `operation:${scope.org}:${scope.app}:${scope.env}:${scope.name}`;
  }
}

function context(args: PolicyArgs): Record<string, unknown> {
  return {
    ...(args.org !== undefined ? { org: args.org } : {}),
    ...(args.app !== undefined ? { app: args.app } : {}),
    ...(args.envName !== undefined ? { env: args.envName } : {}),
    ...(args.deploymentId !== undefined ? { deploymentId: args.deploymentId } : {}),
    category: 'execute',
    ...(args.operation !== undefined ? { name: args.operation } : {}),
  };
}

function policyUrl(
  serviceUrl: string,
  args: PolicyArgs,
  idOrAction?: string,
  suffix?: string,
): URL {
  const base =
    args.org !== undefined
      ? `${serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/policies`
      : `${serviceUrl}/v1/policies`;
  const url = new URL(base);
  if (idOrAction !== undefined) url.pathname += `/${encodeURIComponent(idOrAction)}`;
  if (suffix !== undefined) url.pathname += `/${suffix}`;
  return url;
}

function planUrl(serviceUrl: string, args: PolicyArgs, action?: 'suspend'): URL {
  if (args.org === undefined) throw new Error('policy plan requires --org');
  const url = new URL(`${serviceUrl}/v1/orgs/${encodeURIComponent(args.org)}/plan`);
  if (action !== undefined) url.pathname += `/${action}`;
  return url;
}

function parseArgs(rest: readonly string[]): PolicyArgs {
  let serviceFlag: string | undefined;
  let authFlag: string | undefined;
  let org: string | undefined;
  let app: string | undefined;
  let envName: string | undefined;
  let deploymentId: string | undefined;
  let operation: string | undefined;
  let reason: string | undefined;
  let file: string | undefined;
  let id: string | undefined;
  let externalRef: string | undefined;
  let idempotencyKey: string | undefined;
  let limit: number | undefined;
  let windowSeconds: number | undefined;
  let burst: number | undefined;
  let partition: 'subject' | 'route' | undefined;
  let expectedVersion: number | undefined;
  let json = false;
  let history = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--service') serviceFlag = optionValue(rest[++i], '--service');
    else if (arg === '--auth-token') authFlag = optionValue(rest[++i], '--auth-token');
    else if (arg === '--org') org = optionValue(rest[++i], '--org');
    else if (arg === '--app') app = optionValue(rest[++i], '--app');
    else if (arg === '--env') envName = optionValue(rest[++i], '--env');
    else if (arg === '--deployment') deploymentId = optionValue(rest[++i], '--deployment');
    else if (arg === '--operation') operation = optionValue(rest[++i], '--operation');
    else if (arg === '--reason') reason = optionValue(rest[++i], '--reason');
    else if (arg === '--file') file = optionValue(rest[++i], '--file');
    else if (arg === '--id') id = optionValue(rest[++i], '--id');
    else if (arg === '--external-ref')
      externalRef = optionValue(rest[++i], '--external-ref').trim();
    else if (arg === '--idempotency-key')
      idempotencyKey = optionValue(rest[++i], '--idempotency-key').trim();
    else if (arg === '--limit') limit = numberArg(rest[++i], '--limit');
    else if (arg === '--window') windowSeconds = durationArg(rest[++i]);
    else if (arg === '--burst') burst = numberArg(rest[++i], '--burst');
    else if (arg === '--partition') partition = partitionArg(rest[++i]);
    else if (arg === '--expected-version')
      expectedVersion = numberArg(rest[++i], '--expected-version');
    else if (arg === '--json') json = true;
    else if (arg === '--history') history = true;
    else if (arg?.startsWith('-')) throw new Error(`unknown policy option: ${arg}`);
    else if (id === undefined) id = arg;
    else throw new Error(`unexpected policy argument: ${arg}`);
  }
  return {
    ...(serviceFlag !== undefined ? { serviceFlag } : {}),
    ...(authFlag !== undefined ? { authFlag } : {}),
    ...(org !== undefined ? { org } : {}),
    ...(app !== undefined ? { app } : {}),
    ...(envName !== undefined ? { envName } : {}),
    ...(deploymentId !== undefined ? { deploymentId } : {}),
    ...(operation !== undefined ? { operation } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(externalRef !== undefined ? { externalRef } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(burst !== undefined ? { burst } : {}),
    ...(partition !== undefined ? { partition } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    json,
    history,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function isCategory(value: string | undefined): value is Category {
  return value === 'protocol' || value === 'discovery' || value === 'read' || value === 'execute';
}

function numberArg(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function optionValue(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0 || value.startsWith('-')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function durationArg(value: string | undefined): number {
  if (value === undefined) throw new Error('--window requires a value');
  const match = /^(\d+)([smhd])?$/.exec(value);
  if (!match) throw new Error('--window must be a duration like 60s, 1m, 1h, or 1d');
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  return amount * (unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
}

function partitionArg(value: string | undefined): 'subject' | 'route' {
  if (value === 'subject' || value === 'route') return value;
  throw new Error('--partition must be subject or route');
}

function usage(json = false, detail?: string): number {
  if (json) {
    return printJsonFailure(
      {
        code: 'invalid_arguments',
        message: detail ?? 'policy requires a valid action and arguments',
        fix: 'Choose a supported policy action and pass its required flags.',
        next: 'noodle policy --help',
      },
      EXIT.USAGE,
    );
  }
  if (detail !== undefined) console.error(detail);
  console.error(
    'usage: noodle policy status|list|show|effective|simulate|suspend|resume|deny|quota|rate|usage|apply|delete|plan',
  );
  return EXIT.USAGE;
}

function planUsage(json = false, detail?: string): number {
  if (json) {
    return printJsonFailure(
      {
        code: 'invalid_arguments',
        message: detail ?? 'policy plan requires a valid action and arguments',
        fix: 'Choose show, set, or suspend and pass the required plan flags.',
        next: 'noodle policy plan --help',
      },
      EXIT.USAGE,
    );
  }
  if (detail !== undefined) console.error(detail);
  console.error(
    'usage: noodle policy plan show|set|suspend --org <slug> [--reason <text>] [--external-ref <ref>] [--expected-version <n>] [--idempotency-key <key>]',
  );
  return EXIT.USAGE;
}

function validatePlanArgs(
  action: string,
  args: PolicyArgs,
  jsonMode = args.json,
): number | undefined {
  if (action !== 'show' && action !== 'set' && action !== 'suspend') return planUsage(jsonMode);
  if (args.org === undefined) return planUsage(jsonMode);
  if (action === 'set' && !isPlanName(args.id)) return planUsage(jsonMode);
  if ((action === 'set' || action === 'suspend') && args.reason === undefined)
    return planUsage(jsonMode);
  if (args.externalRef !== undefined && !isExternalRef(args.externalRef))
    return planUsage(jsonMode);
  if (args.idempotencyKey !== undefined && args.idempotencyKey.length === 0)
    return planUsage(jsonMode);
  return undefined;
}

function isPlanName(value: string | undefined): boolean {
  return value === 'free' || value === 'pro' || value === 'scale' || value === 'enterprise';
}

function isExternalRef(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
