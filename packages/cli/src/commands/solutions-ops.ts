import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  parseCommandFlags,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';

export interface SolutionsCommandOptions {
  readonly fetchImpl?: typeof fetch;
}

const VALUES = {
  '--service': 'service',
  '--auth-token': 'authToken',
  '--org': 'org',
  '--app': 'app',
  '--env': 'env',
  '--retention-days': 'retentionDays',
  '--role': 'role',
  '--subject': 'subject',
  '--email': 'email',
  '--expected-revision': 'expectedRevision',
  '--status': 'status',
  '--assignee': 'assignee',
  '--data': 'data',
  '--note': 'note',
  '--idempotency-key': 'idempotencyKey',
  '--cursor': 'cursor',
  '--limit': 'limit',
} as const;

const BOOLEANS = {
  '--json': 'json',
  '--include-deleted': 'includeDeleted',
} as const;

type Args = ReturnType<typeof parseArgs>;

function parseArgs(rest: readonly string[]) {
  return parseCommandFlags(rest, { values: VALUES, booleans: BOOLEANS });
}

function commandUsage(message: string, json: boolean): number {
  return printCliFailure(
    'solutions',
    usageError(message, 'noodle solutions catalog | list | install | inspect | grants | records'),
    json,
  );
}

function required(value: string | undefined, name: string, json: boolean): string | number {
  return value ?? commandUsage(`${name} is required`, json);
}

function positiveInteger(
  value: string | undefined,
  name: string,
  json: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    commandUsage(`${name} must be a positive integer`, json);
    return undefined;
  }
  return parsed;
}

function nonnegativeInteger(
  value: string | undefined,
  name: string,
  json: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    commandUsage(`${name} must be a non-negative integer`, json);
    return undefined;
  }
  return parsed;
}

function parseData(value: string | undefined, json: boolean): Record<string, unknown> | undefined {
  if (value === undefined) {
    commandUsage('--data is required and must be a JSON object', json);
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    commandUsage('--data must be a JSON object', json);
    return undefined;
  }
}

function orgBase(service: string, org: string): string {
  return `${service}/v1/orgs/${encodeURIComponent(org)}/solution-installations`;
}

function installationBase(service: string, org: string, installationId: string): string {
  return `${orgBase(service, org)}/${encodeURIComponent(installationId)}`;
}

function recordsBase(
  service: string,
  org: string,
  installationId: string,
  collection: string,
): string {
  return (
    `${installationBase(service, org, installationId)}/collections/` +
    `${encodeURIComponent(collection)}/records`
  );
}

function jsonInit(method: string, body?: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function printResult(result: { readonly data?: unknown }, json: boolean, message: string): void {
  if (json) printJsonOk(result.data ?? result);
  else console.log(message);
}

/** Complete automation/support projection of the managed-record service API. */
export async function runSolutions(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: SolutionsCommandOptions = {},
): Promise<number> {
  const args = parseArgs(rest);
  if (args.parseError !== undefined) return commandUsage(args.parseError, args.json);
  const [family, actionOrId, ...positionals] = args.positional;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (family !== 'catalog' && resolved.token === undefined) {
    return printCliFailure('solutions', authRequired(), args.json);
  }
  const request = options.fetchImpl ?? fetch;
  try {
    if (family === 'catalog') {
      const result = await serviceJson<{ data: { profiles: readonly { title: string }[] } }>(
        `${resolved.serviceUrl}/v1/solutions/catalog`,
        resolved.token,
        {},
        request,
      );
      printResult(
        result,
        args.json,
        result.data.profiles.map((profile) => profile.title).join('\n'),
      );
      return EXIT.OK;
    }
    const org = required(args.org, '--org', args.json);
    if (typeof org !== 'string') return org;
    if (family === 'list') {
      const result = await serviceJson<{ data: { installations: readonly unknown[] } }>(
        orgBase(resolved.serviceUrl, org),
        resolved.token,
        {},
        request,
      );
      printResult(
        result,
        args.json,
        `found ${result.data.installations.length} solution installation(s)`,
      );
      return EXIT.OK;
    }
    if (family === 'install') {
      const profileId = required(actionOrId, 'profile', args.json);
      const appSlug = required(args.app, '--app', args.json);
      const environment = required(args.env, '--env', args.json);
      if (typeof profileId !== 'string') return profileId;
      if (typeof appSlug !== 'string') return appSlug;
      if (typeof environment !== 'string') return environment;
      const retentionDays = positiveInteger(
        args.retentionDays ?? '30',
        '--retention-days',
        args.json,
      );
      if (retentionDays === undefined) return EXIT.USAGE;
      if (![7, 30, 90].includes(retentionDays)) {
        return commandUsage('--retention-days must be 7, 30, or 90', args.json);
      }
      const result = await serviceJson<{ data: { installation: { id: string } } }>(
        orgBase(resolved.serviceUrl, org),
        resolved.token,
        jsonInit('POST', { profileId, appSlug, environment, retentionDays }),
        request,
      );
      printResult(result, args.json, `installed ${profileId} as ${result.data.installation.id}`);
      return EXIT.OK;
    }
    if (family === 'inspect') {
      const installationId = required(actionOrId, 'installation id', args.json);
      if (typeof installationId !== 'string') return installationId;
      const result = await serviceJson<{ data: { installation: { id: string } } }>(
        installationBase(resolved.serviceUrl, org, installationId),
        resolved.token,
        {},
        request,
      );
      printResult(result, args.json, `solution installation ${result.data.installation.id}`);
      return EXIT.OK;
    }
    if (family === 'grants') {
      return runGrantCommand(
        actionOrId,
        positionals,
        args,
        resolved.serviceUrl,
        resolved.token,
        org,
        request,
      );
    }
    if (family === 'records') {
      return runRecordCommand(
        actionOrId,
        positionals,
        args,
        resolved.serviceUrl,
        resolved.token,
        org,
        request,
      );
    }
    return commandUsage(`unknown solutions action "${family ?? ''}"`, args.json);
  } catch (error) {
    return printCliFailure(
      'solutions',
      serviceFailure('solutions', error, 'noodle solutions list --org <org>'),
      args.json,
    );
  }
}

async function runGrantCommand(
  action: string | undefined,
  positionals: readonly string[],
  args: Args,
  service: string,
  token: string | undefined,
  org: string,
  request: typeof fetch,
): Promise<number> {
  const installationId = required(positionals[0], 'installation id', args.json);
  if (typeof installationId !== 'string') return installationId;
  const base = `${installationBase(service, org, installationId)}/grants`;
  if (action === 'list') {
    const result = await serviceJson<{ data: { grants: readonly unknown[] } }>(
      base,
      token,
      {},
      request,
    );
    printResult(result, args.json, `found ${result.data.grants.length} business grant(s)`);
    return EXIT.OK;
  }
  const subject = required(args.subject, '--subject', args.json);
  if (typeof subject !== 'string') return subject;
  if (action === 'set') {
    const email = required(args.email, '--email', args.json);
    const role = required(args.role, '--role', args.json);
    if (typeof email !== 'string') return email;
    if (typeof role !== 'string') return role;
    const expectedRevision = nonnegativeInteger(
      args.expectedRevision ?? '0',
      '--expected-revision',
      args.json,
    );
    if (expectedRevision === undefined) return EXIT.USAGE;
    const result = await serviceJson<{ data: { grant: { role: string } } }>(
      base,
      token,
      jsonInit('POST', { subject, email, role, expectedRevision }),
      request,
    );
    printResult(result, args.json, `set ${subject} to ${result.data.grant.role}`);
    return EXIT.OK;
  }
  if (action === 'revoke') {
    const expectedRevision = positiveInteger(
      args.expectedRevision,
      '--expected-revision',
      args.json,
    );
    if (expectedRevision === undefined) return EXIT.USAGE;
    const result = await serviceJson<{ data?: unknown }>(
      `${base}/${encodeURIComponent(subject)}`,
      token,
      jsonInit('DELETE', { expectedRevision }),
      request,
    );
    printResult(result, args.json, `revoked business grant for ${subject}`);
    return EXIT.OK;
  }
  return commandUsage(`unknown solutions grants action "${action ?? ''}"`, args.json);
}

async function runRecordCommand(
  action: string | undefined,
  positionals: readonly string[],
  args: Args,
  service: string,
  token: string | undefined,
  org: string,
  request: typeof fetch,
): Promise<number> {
  const installationId = required(positionals[0], 'installation id', args.json);
  const collection = required(positionals[1], 'collection', args.json);
  if (typeof installationId !== 'string') return installationId;
  if (typeof collection !== 'string') return collection;
  const base = recordsBase(service, org, installationId, collection);
  if (action === 'list' || action === 'export') {
    const url = new URL(action === 'export' ? `${base}/export` : base);
    if (args.status !== undefined) url.searchParams.set('status', args.status);
    if (args.assignee !== undefined) url.searchParams.set('assigneeSubject', args.assignee);
    if (args.cursor !== undefined) url.searchParams.set('cursor', args.cursor);
    if (args.limit !== undefined) url.searchParams.set('limit', args.limit);
    if (args.includeDeleted) url.searchParams.set('includeDeleted', 'true');
    const result = await serviceJson<{ data: { records: readonly unknown[] } }>(
      url.toString(),
      token,
      {},
      request,
    );
    printResult(result, args.json, `${result.data.records.length} record(s)`);
    return EXIT.OK;
  }
  if (action === 'create') {
    const payload = parseData(args.data, args.json);
    if (payload === undefined) return EXIT.USAGE;
    const idempotencyKey = required(args.idempotencyKey, '--idempotency-key', args.json);
    if (typeof idempotencyKey !== 'string') return idempotencyKey;
    const result = await serviceJson<{ data: { record: { id: string } } }>(
      base,
      token,
      jsonInit('POST', { payload }, { 'idempotency-key': idempotencyKey }),
      request,
    );
    printResult(result, args.json, `created record ${result.data.record.id}`);
    return EXIT.OK;
  }
  const recordId = required(positionals[2], 'record id', args.json);
  if (typeof recordId !== 'string') return recordId;
  const recordUrl = `${base}/${encodeURIComponent(recordId)}`;
  if (action === 'get' || action === 'activity') {
    const result = await serviceJson<{ data: unknown }>(
      action === 'activity' ? `${recordUrl}/activity` : recordUrl,
      token,
      {},
      request,
    );
    printResult(result, args.json, `${action} ${recordId}`);
    return EXIT.OK;
  }
  const expectedRevision = positiveInteger(args.expectedRevision, '--expected-revision', args.json);
  if (expectedRevision === undefined) return EXIT.USAGE;
  if (action === 'delete') {
    const result = await serviceJson<{ data?: unknown }>(
      recordUrl,
      token,
      jsonInit('DELETE', { expectedRevision }),
      request,
    );
    printResult(result, args.json, `deleted record ${recordId}`);
    return EXIT.OK;
  }
  let mutation: Record<string, unknown>;
  if (action === 'update') {
    const patch = parseData(args.data, args.json);
    if (patch === undefined) return EXIT.USAGE;
    mutation = { operation: 'update', expectedRevision, patch };
  } else if (action === 'assign') {
    mutation = { operation: 'assign', expectedRevision, assigneeSubject: args.assignee ?? null };
  } else if (action === 'status') {
    const status = required(args.status, '--status', args.json);
    if (typeof status !== 'string') return status;
    mutation = { operation: 'set-status', expectedRevision, status };
  } else if (action === 'note') {
    const note = required(args.note, '--note', args.json);
    if (typeof note !== 'string') return note;
    mutation = { operation: 'add-note', expectedRevision, note };
  } else {
    return commandUsage(`unknown solutions records action "${action ?? ''}"`, args.json);
  }
  const result = await serviceJson<{ data: { record: { revision: number } } }>(
    recordUrl,
    token,
    jsonInit('PATCH', mutation),
    request,
  );
  printResult(
    result,
    args.json,
    `updated record ${recordId} to revision ${result.data.record.revision}`,
  );
  return EXIT.OK;
}
