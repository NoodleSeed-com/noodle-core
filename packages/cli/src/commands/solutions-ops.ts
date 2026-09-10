import { randomBytes, randomUUID } from 'node:crypto';
import {
  BusinessNoticeSchema,
  type CollectionSourceRefreshResponse,
  ManagedRecordMutationRequestSchema,
  ManagedRecordQuerySchema,
  type SolutionInstallationResponse,
} from '@noodle-borg/wire-contracts';
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
import { runSolutionActivity } from './solutions-activity.js';
import { runSolutionConnections } from './solutions-connections.js';
import { runSolutionOperations } from './solutions-coordination.js';
import { runSolutionInstallationOptions } from './solutions-installation-options.js';
import { runSolutionOnboarding } from './solutions-onboarding.js';

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
  '--display-name': 'displayName',
  '--privacy-url': 'privacyUrl',
  '--support-url': 'supportUrl',
  '--role': 'role',
  '--subject': 'subject',
  '--email': 'email',
  '--expected-revision': 'expectedRevision',
  '--status': 'status',
  '--filters': 'filters',
  '--sort-field': 'sortField',
  '--sort-direction': 'sortDirection',
  '--created-at-from': 'createdAtFrom',
  '--created-at-to': 'createdAtTo',
  '--assignee': 'assignee',
  '--data': 'data',
  '--unset': 'unset',
  '--note': 'note',
  '--idempotency-key': 'idempotencyKey',
  '--cursor': 'cursor',
  '--limit': 'limit',
  '--publisher-org': 'publisherOrg',
  '--definition-app': 'definitionApp',
  '--definition-env': 'definitionEnv',
  '--deployment': 'deploymentId',
  '--binding-reference': 'bindingReference',
  '--binding-generation': 'bindingGeneration',
  '--configuration-reference': 'configurationReference',
} as const;

const BOOLEANS = {
  '--json': 'json',
  '--include-deleted': 'includeDeleted',
  '--enable': 'enable',
  '--replace': 'replace',
} as const;

type Args = ReturnType<typeof parseArgs>;

function parseArgs(rest: readonly string[]) {
  return parseCommandFlags(rest, { values: VALUES, booleans: BOOLEANS });
}

function commandUsage(message: string, json: boolean): number {
  return printCliFailure(
    'solutions',
    usageError(
      message,
      'noodle solutions catalog | installation-options | agreement | notice | list | install | inspect | activate | pause | resume | grants | invitations | records | sources | connections | activity | operations',
    ),
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

function sourceBase(
  service: string,
  org: string,
  installationId: string,
  collection: string,
): string {
  return (
    `${installationBase(service, org, installationId)}/collections/` +
    `${encodeURIComponent(collection)}/source`
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
  if (rest[0] === 'agreement' || rest[0] === 'notice')
    return runSolutionOnboarding(rest[0], rest.slice(1), env, home, options);
  if (rest[0] === 'operations') return runSolutionOperations(rest.slice(1), env, home, options);
  if (rest[0] === 'activity') return runSolutionActivity(rest.slice(1), env, home, options);
  if (rest[0] === 'connections') return runSolutionConnections(rest.slice(1), env, home, options);
  if (rest[0] === 'installation-options')
    return runSolutionInstallationOptions(rest.slice(1), env, home, options);
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
    if (family === 'list') {
      if (args.org !== undefined && (args.cursor !== undefined || args.limit !== undefined)) {
        return commandUsage(
          '--cursor and --limit require grant-based list without --org',
          args.json,
        );
      }
      const limit = positiveInteger(args.limit, '--limit', args.json);
      if (args.limit !== undefined && limit === undefined) return EXIT.USAGE;
      if (limit !== undefined && limit > 100) {
        return commandUsage('--limit must not exceed 100', args.json);
      }
      const query = new URLSearchParams();
      if (args.cursor) query.set('cursor', args.cursor);
      if (limit !== undefined) query.set('limit', String(limit));
      const discoveryPath = `${resolved.serviceUrl}/v1/me/solution-installations${query.size ? `?${query}` : ''}`;
      const result = await serviceJson<{
        data: { installations: readonly unknown[]; nextCursor?: string };
      }>(
        args.org === undefined ? discoveryPath : orgBase(resolved.serviceUrl, args.org),
        resolved.token,
        {},
        request,
      );
      printResult(
        result,
        args.json,
        `found ${result.data.installations.length} solution installation(s)${result.data.nextCursor ? `\nnext cursor: ${result.data.nextCursor}` : ''}`,
      );
      return EXIT.OK;
    }
    if (family === 'invitations' && actionOrId === 'accept') {
      const rawToken = required(positionals[0], 'invitation token', args.json);
      if (typeof rawToken !== 'string') return rawToken;
      const result = await serviceJson<{ data: { installation: { id: string } } }>(
        `${resolved.serviceUrl}/v1/solution-invitations/${encodeURIComponent(rawToken)}/accept`,
        resolved.token,
        jsonInit('POST'),
        request,
      );
      printResult(result, args.json, `joined solution installation ${result.data.installation.id}`);
      return EXIT.OK;
    }
    const org = required(args.org, '--org', args.json);
    if (typeof org !== 'string') return org;
    if (family === 'install') {
      const appSlug = required(args.app, '--app', args.json);
      const environment = required(args.env, '--env', args.json);
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
      const noticeInput = {
        displayName: args.displayName,
        privacyUrl: args.privacyUrl,
        supportUrl: args.supportUrl,
      };
      const notice = Object.values(noticeInput).some((value) => value !== undefined)
        ? BusinessNoticeSchema.safeParse(noticeInput)
        : undefined;
      if (notice && !notice.success)
        return commandUsage(
          'Provide --display-name, HTTPS --privacy-url and HTTPS or mailto --support-url together.',
          args.json,
        );
      const definition = installDefinition(actionOrId, args, args.json);
      if (typeof definition === 'number') return definition;
      const result = await serviceJson<{ data: { installation: { id: string } } }>(
        orgBase(resolved.serviceUrl, org),
        resolved.token,
        jsonInit('POST', {
          definition,
          appSlug,
          environment,
          retentionDays,
          ...(notice?.success ? { businessNotice: notice.data } : {}),
        }),
        request,
      );
      const label = definition.kind === 'managed' ? definition.profileId : definition.deploymentId;
      printResult(result, args.json, `installed ${label} as ${result.data.installation.id}`);
      return EXIT.OK;
    }
    if (family === 'inspect' || family === 'activate') {
      const installationId = required(actionOrId, 'installation id', args.json);
      if (typeof installationId !== 'string') return installationId;
      const result = await serviceJson<SolutionInstallationResponse>(
        installationBase(resolved.serviceUrl, org, installationId) +
          (family === 'activate' ? '/activate' : ''),
        resolved.token,
        family === 'activate' ? jsonInit('POST', {}) : {},
        request,
      );
      printResult(
        result,
        args.json,
        `solution installation ${result.data.installation.id}: ${result.data.installation.activation?.state ?? 'unavailable'}`,
      );
      return EXIT.OK;
    }
    if (family === 'pause' || family === 'resume') {
      const installationId = required(actionOrId, 'installation id', args.json);
      if (typeof installationId !== 'string') return installationId;
      const revision = positiveInteger(args.expectedRevision, '--expected-revision', args.json);
      if (revision === undefined) return EXIT.USAGE;
      const result = await serviceJson<{ data: { installation: { id: string; active: boolean } } }>(
        installationBase(resolved.serviceUrl, org, installationId),
        resolved.token,
        jsonInit('PATCH', { active: family === 'resume', expectedRevision: revision }),
        request,
      );
      printResult(
        result,
        args.json,
        `${family === 'resume' ? 'resumed' : 'paused'} public intake for ${result.data.installation.id}`,
      );
      return EXIT.OK;
    }
    if (family === 'grants') {
      const exitCode = await runGrantCommand(
        actionOrId,
        positionals,
        args,
        resolved.serviceUrl,
        resolved.token,
        org,
        request,
      );
      return exitCode;
    }
    if (family === 'invitations') {
      return runInvitationCommand(
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
      const exitCode = await runRecordCommand(
        actionOrId,
        positionals,
        args,
        resolved.serviceUrl,
        resolved.token,
        org,
        request,
      );
      return exitCode;
    }
    if (family === 'sources') {
      const exitCode = await runSourceCommand(
        actionOrId,
        positionals,
        args,
        resolved.serviceUrl,
        resolved.token,
        org,
        request,
      );
      return exitCode;
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

async function runInvitationCommand(
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
  const base = `${installationBase(service, org, installationId)}/invitations`;
  if (action === 'list') {
    const result = await serviceJson<{ data: { invitations: readonly unknown[] } }>(
      base,
      token,
      {},
      request,
    );
    printResult(result, args.json, `found ${result.data.invitations.length} invitation(s)`);
    return EXIT.OK;
  }
  if (action === 'create') {
    const email = required(args.email, '--email', args.json);
    const role = required(args.role, '--role', args.json);
    if (typeof email !== 'string') return email;
    if (typeof role !== 'string') return role;
    const rawToken = randomBytes(32).toString('base64url');
    const result = await serviceJson<{ data: { acceptPath: string } }>(
      base,
      token,
      jsonInit('POST', {
        email,
        role,
        token: rawToken,
        idempotencyKey: args.idempotencyKey ?? randomUUID(),
        expiresInHours: 168,
      }),
      request,
    );
    printResult(result, args.json, `invitation link: ${result.data.acceptPath}`);
    return EXIT.OK;
  }
  if (action === 'revoke') {
    const invitationId = required(positionals[1], 'invitation id', args.json);
    if (typeof invitationId !== 'string') return invitationId;
    const expectedRevision = positiveInteger(
      args.expectedRevision,
      '--expected-revision',
      args.json,
    );
    if (expectedRevision === undefined) return EXIT.USAGE;
    const result = await serviceJson<{ data?: unknown }>(
      `${base}/${encodeURIComponent(invitationId)}`,
      token,
      jsonInit('DELETE', { expectedRevision }),
      request,
    );
    printResult(result, args.json, `revoked invitation ${invitationId}`);
    return EXIT.OK;
  }
  return commandUsage(`unknown solutions invitations action "${action ?? ''}"`, args.json);
}

function installDefinition(
  profileId: string | undefined,
  args: Args,
  json: boolean,
):
  | { readonly kind: 'managed'; readonly profileId: string }
  | {
      readonly kind: 'private';
      readonly publisherOrg: string;
      readonly app: string;
      readonly environment: string;
      readonly deploymentId: string;
    }
  | number {
  const hasPrivateInput =
    args.publisherOrg !== undefined ||
    args.definitionApp !== undefined ||
    args.definitionEnv !== undefined ||
    args.deploymentId !== undefined;
  if (profileId !== undefined && hasPrivateInput) {
    return commandUsage('profile and private definition flags cannot be combined', json);
  }
  if (profileId !== undefined) {
    if (!['travel', 'ecommerce', 'restaurant'].includes(profileId)) {
      return commandUsage(
        'profile must be travel, ecommerce, or restaurant; use a private definition for B2B SaaS',
        json,
      );
    }
    return { kind: 'managed', profileId };
  }
  const publisherOrg = required(args.publisherOrg, '--publisher-org', json);
  const app = required(args.definitionApp, '--definition-app', json);
  const environment = required(args.definitionEnv, '--definition-env', json);
  const deploymentId = required(args.deploymentId, '--deployment', json);
  if (typeof publisherOrg !== 'string') return publisherOrg;
  if (typeof app !== 'string') return app;
  if (typeof environment !== 'string') return environment;
  if (typeof deploymentId !== 'string') return deploymentId;
  return { kind: 'private', publisherOrg, app, environment, deploymentId };
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

async function runSourceCommand(
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
  const base = sourceBase(service, org, installationId, collection);
  if (action === 'show') {
    const result = await serviceJson<{ data: unknown }>(base, token, {}, request);
    printResult(result, args.json, `source for ${collection}`);
    return EXIT.OK;
  }
  const expectedRevision = positiveInteger(args.expectedRevision, '--expected-revision', args.json);
  if (expectedRevision === undefined) return EXIT.USAGE;
  if (action === 'configure') {
    const bindingReference = required(args.bindingReference, '--binding-reference', args.json);
    const configurationReference = required(
      args.configurationReference,
      '--configuration-reference',
      args.json,
    );
    const bindingGeneration = positiveInteger(
      args.bindingGeneration,
      '--binding-generation',
      args.json,
    );
    if (typeof bindingReference !== 'string') return bindingReference;
    if (typeof configurationReference !== 'string') return configurationReference;
    if (bindingGeneration === undefined) return EXIT.USAGE;
    if (!args.enable)
      return commandUsage('--enable is required to consent to source activation', args.json);
    const result = await serviceJson<{ data: unknown }>(
      base,
      token,
      jsonInit('PATCH', {
        expectedRevision,
        binding: { reference: bindingReference, generation: bindingGeneration },
        configurationReference,
        enable: true,
        ...(args.replace ? { replace: true } : {}),
      }),
      request,
    );
    printResult(result, args.json, `configured source for ${collection}`);
    return EXIT.OK;
  }
  if (action === 'pause' || action === 'resume') {
    const result = await serviceJson<{ data: unknown }>(
      `${base}/${action}`,
      token,
      jsonInit('POST', { expectedRevision }),
      request,
    );
    printResult(result, args.json, `${action}d source for ${collection}`);
    return EXIT.OK;
  }
  if (action === 'refresh') {
    const idempotencyKey = required(args.idempotencyKey, '--idempotency-key', args.json);
    if (typeof idempotencyKey !== 'string') return idempotencyKey;
    const result = await serviceJson<CollectionSourceRefreshResponse>(
      `${base}/refresh`,
      token,
      jsonInit('POST', { expectedRevision, idempotencyKey }),
      request,
    );
    printResult(result, args.json, `source refresh ${result.data.job.state} for ${collection}`);
    return EXIT.OK;
  }
  return commandUsage(`unknown solutions sources action "${action ?? ''}"`, args.json);
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
  const queryKeys = [
    'filters',
    'sortField',
    'sortDirection',
    'createdAtFrom',
    'createdAtTo',
  ] as const;
  const queryValues = Object.fromEntries(
    queryKeys.flatMap((key) => (args[key] === undefined ? [] : [[key, args[key]]])),
  );
  if (action !== 'list' && Object.keys(queryValues).length > 0)
    return commandUsage('Field and creation date queries apply only to records list.', args.json);
  try {
    if (typeof queryValues.filters === 'string') {
      if (queryValues.filters.length > 32768) throw new Error();
      queryValues.filters = JSON.parse(queryValues.filters);
    }
    if (!ManagedRecordQuerySchema.safeParse(queryValues).success) throw new Error();
  } catch {
    return commandUsage(
      'Invalid collection query. Use a JSON array of scalar equality filters and valid sort/date options.',
      args.json,
    );
  }

  if (action === 'list' || action === 'export') {
    const url = new URL(action === 'export' ? `${base}/export` : base);
    for (const [key, value] of Object.entries(queryValues))
      url.searchParams.set(key, key === 'filters' ? JSON.stringify(value) : String(value));
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
    const url = new URL(action === 'activity' ? `${recordUrl}/activity` : recordUrl);
    if (action === 'activity' && args.cursor !== undefined)
      url.searchParams.set('cursor', args.cursor);
    if (action === 'activity' && args.limit !== undefined)
      url.searchParams.set('limit', args.limit);
    const result = await serviceJson<{ data: unknown }>(url.toString(), token, {}, request);
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
    const patch =
      args.data === undefined && args.unset !== undefined ? {} : parseData(args.data, args.json);
    if (patch === undefined) return EXIT.USAGE;
    const unset = args.unset?.split(',').map((key) => key.trim());
    mutation = {
      operation: 'update',
      expectedRevision,
      patch,
      ...(unset === undefined ? {} : { unset }),
    };
    if (
      !ManagedRecordMutationRequestSchema.safeParse(mutation).success ||
      unset?.some((key) => Object.hasOwn(patch, key))
    )
      return commandUsage('--unset must name unique optional fields outside --data.', args.json);
  } else if (action === 'migrate-schema') {
    mutation = { operation: 'migrate-schema', expectedRevision };
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
    action === 'migrate-schema'
      ? { data: { record: { id: recordId, revision: result.data.record.revision } } }
      : result,
    args.json,
    `updated record ${recordId} to revision ${result.data.record.revision}`,
  );
  return EXIT.OK;
}
