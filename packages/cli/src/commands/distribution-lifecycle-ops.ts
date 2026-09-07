import {
  DistributionDownloadGrantRequestSchema,
  DistributionDownloadGrantResponseSchema,
  DistributionHumanReviewRequestSchema,
  type DistributionLifecycle,
  DistributionLifecycleResponseSchema,
  DistributionReadinessRequestSchema,
  DistributionReleaseRequestSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { serviceJson } from '../control-plane.js';
import {
  commonDistributionArgs,
  distributionUsageFailure,
  distributionVersionUrl,
  resolveDistributionHostedContext,
} from './distribution-ops-support.js';
import { EXIT, printJsonOk } from './output.js';
import { parseCommandFlags, printCliFailure, serviceFailure } from './shared.js';

const USAGE = {
  readiness:
    'noodle distributions readiness <distribution-id> --status <draft|ready|blocked> [--note <text>]',
  review: 'noodle distributions review <distribution-id> --status <status> [--feedback <text>]',
  release: 'noodle distributions release <distribution-id> --visibility <private|public>',
  rollback: 'noodle distributions rollback <distribution-id>',
  deprecate: 'noodle distributions deprecate <distribution-id>',
  revoke: 'noodle distributions revoke <distribution-id>',
  grant: 'noodle distributions grant <distribution-id> [--expires-in <seconds>]',
} as const;

type LifecycleCommand = keyof typeof USAGE;

export async function runDistributionLifecycle(
  subcommand: string | undefined,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number | undefined> {
  if (!isLifecycleCommand(subcommand)) return undefined;
  if (subcommand === 'readiness') return readiness(rest, env, home);
  if (subcommand === 'review') return review(rest, env, home);
  if (subcommand === 'release') return release(rest, env, home);
  if (subcommand === 'grant') return grant(rest, env, home);
  return noBodyMutation(subcommand, rest, env, home);
}

async function readiness(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--status': 'status',
      '--note': 'note',
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  const body = DistributionReadinessRequestSchema.safeParse({
    status: parsed.status,
    ...(parsed.note === undefined ? {} : { note: parsed.note }),
  });
  return parsedMutation(parsed, body, 'readiness', 'PUT', env, home);
}

async function review(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--status': 'status',
      '--feedback': 'feedback',
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  const body = DistributionHumanReviewRequestSchema.safeParse({
    reportedStatus: parsed.status,
    ...(parsed.feedback === undefined ? {} : { feedback: parsed.feedback }),
  });
  return parsedMutation(parsed, body, 'review', 'POST', env, home);
}

async function release(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--visibility': 'visibility',
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  const body = DistributionReleaseRequestSchema.safeParse({ visibility: parsed.visibility });
  return parsedMutation(parsed, body, 'release', 'POST', env, home);
}

async function grant(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--expires-in': 'expiresIn',
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  const body = DistributionDownloadGrantRequestSchema.safeParse({
    ...(parsed.expiresIn === undefined ? {} : { expiresInSeconds: Number(parsed.expiresIn) }),
  });
  const command = 'distributions grant';
  const common = commonDistributionArgs(parsed);
  const id = exactId(parsed.positional);
  if (parsed.parseError !== undefined || id === undefined || !body.success) {
    return lifecycleUsageFailure(
      parsed.parseError ?? bodyError(body) ?? 'grant requires one id',
      'grant',
      common.json,
    );
  }
  const hosted = await resolveDistributionHostedContext(common, env, home, command);
  if (typeof hosted === 'number') return hosted;
  try {
    const response = DistributionDownloadGrantResponseSchema.parse(
      await serviceJson<unknown>(
        `${distributionVersionUrl(hosted, id)}/download-grants`,
        hosted.token,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body.data),
        },
      ),
    );
    const { downloadPath, ...grant } = response.data;
    const data = {
      ...grant,
      downloadUrl: new URL(downloadPath, hosted.serviceUrl).toString(),
    };
    if (common.json) printJsonOk(data);
    else {
      console.log(`grant:   ${data.grantId}`);
      console.log(`expires: ${data.expiresAt}`);
      console.log(`url:     ${data.downloadUrl}`);
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(command, serviceFailure(command, error, USAGE.grant), common.json);
  }
}

async function noBodyMutation(
  action: 'rollback' | 'deprecate' | 'revoke',
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: { '--org': 'org', '--service': 'service', '--auth-token': 'authToken' },
    booleans: { '--json': 'json' },
  });
  const common = commonDistributionArgs(parsed);
  const id = exactId(parsed.positional);
  if (parsed.parseError !== undefined || id === undefined) {
    return lifecycleUsageFailure(
      parsed.parseError ?? `${action} requires exactly one distribution id`,
      action,
      common.json,
    );
  }
  return mutate(id, action, 'POST', undefined, common, env, home);
}

async function parsedMutation(
  parsed: {
    readonly positional: readonly string[];
    readonly parseError?: string;
    readonly org?: string;
    readonly service?: string;
    readonly authToken?: string;
    readonly json: boolean;
  },
  body:
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly { readonly message: string }[] };
      },
  action: 'readiness' | 'review' | 'release',
  method: 'PUT' | 'POST',
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const common = commonDistributionArgs(parsed);
  const id = exactId(parsed.positional);
  if (parsed.parseError !== undefined || id === undefined || !body.success) {
    return lifecycleUsageFailure(
      parsed.parseError ?? bodyError(body) ?? `${action} requires exactly one distribution id`,
      action,
      common.json,
    );
  }
  return mutate(id, action, method, body.data, common, env, home);
}

async function mutate(
  id: string,
  action: Exclude<LifecycleCommand, 'grant'>,
  method: 'PUT' | 'POST',
  body: unknown,
  common: ReturnType<typeof commonDistributionArgs>,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const command = `distributions ${action}`;
  const hosted = await resolveDistributionHostedContext(common, env, home, command);
  if (typeof hosted === 'number') return hosted;
  try {
    const response = DistributionLifecycleResponseSchema.parse(
      await serviceJson<unknown>(`${distributionVersionUrl(hosted, id)}/${action}`, hosted.token, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    );
    const release = response.data.lifecycle.release;
    const channelUrl =
      (action === 'release' || action === 'rollback') && release !== undefined
        ? new URL(
            `/v1/distribution-releases/${encodeURIComponent(release.id)}`,
            hosted.serviceUrl,
          ).toString()
        : undefined;
    const data = {
      ...response.data,
      ...(channelUrl === undefined ? {} : { channelUrl }),
    };
    if (common.json) printJsonOk(data);
    else printLifecycle(action, response.data.lifecycle, channelUrl);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(command, serviceFailure(command, error, USAGE[action]), common.json);
  }
}

function printLifecycle(
  action: string,
  lifecycle: DistributionLifecycle,
  channelUrl?: string,
): void {
  console.log(`updated:      ${action}`);
  console.log(`distribution: ${lifecycle.distributionId}`);
  console.log(`readiness:    ${lifecycle.readiness.status}`);
  console.log(`disposition:  ${lifecycle.disposition.status}`);
  if (lifecycle.review !== undefined)
    console.log(`review:       ${lifecycle.review.reportedStatus}`);
  if (lifecycle.release !== undefined) {
    console.log(`release:      ${lifecycle.release.id}`);
    console.log(`visibility:   ${lifecycle.release.visibility}`);
    if (channelUrl !== undefined) console.log(`channel:      ${channelUrl}`);
  }
}

function lifecycleUsageFailure(message: string, action: LifecycleCommand, json: boolean): number {
  return distributionUsageFailure(message, USAGE[action], json);
}

function exactId(positional: readonly string[]): string | undefined {
  return positional.length === 1 ? positional[0] : undefined;
}

function bodyError(value: {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly { readonly message: string }[] };
}): string | undefined {
  return value.success ? undefined : value.error?.issues[0]?.message;
}

function isLifecycleCommand(value: string | undefined): value is LifecycleCommand {
  return value !== undefined && Object.hasOwn(USAGE, value);
}
