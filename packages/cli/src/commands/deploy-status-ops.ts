import {
  accessUpdateClientResponseSchema,
  deploymentOwnerSubjectSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
/**
 * Hosted deployment state operations, split out of `deploy-ops.ts` to keep both under the size
 * gate: `status` (read a deployment's status/health), `rollback` (reactivate a historical
 * deployment), and `access` (change a deployment's identity access mode). All three share the
 * same tenant-target resolution + control-plane request path and are independent of the
 * `deploy`/`open` flow that stays in `deploy-ops.ts`.
 */
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import type { AccessMode } from '../deploy.js';
import { type DetailCardOptions, type DetailRow, renderDetailCard } from '../detail-card.js';
import type { PluginMode } from '../plugin-mode/profile.js';
import { pluginServiceCompatibilityFailure } from '../plugin-mode/service-compatibility.js';
import { relativeTime } from '../relative-time.js';
import { parseWatchFlags, runWatch, type WatchFrame, watchJsonConflictFailure } from '../watch.js';
import { normalizeCommandServerVersion } from './deploy-version-resolution.js';
import { EXIT, printJsonOk } from './output.js';
import { stdoutTableOptions } from './resource-shared.js';
import {
  type CliFailure,
  isAccessMode,
  parseTenantCommandArgs,
  printCliFailure,
  resolveTenantTarget,
  serviceFailure,
} from './shared.js';

export interface StatusResponse {
  readonly ok: true;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
  readonly deployment: {
    readonly deploymentId: string;
    readonly endpointUrl: string;
    readonly serverVersion?: string;
    readonly active: boolean;
    readonly serverName: string;
    readonly createdAt: string;
    readonly createdByEmail?: string;
    readonly accessMode: AccessMode;
    readonly ownerSubject?: string;
    readonly deploymentLock?: {
      readonly lockedAt: string;
      readonly lockedByEmail?: string;
    };
  };
  readonly health: { readonly state: string };
  readonly config: { readonly ok: boolean; readonly missingSecrets: readonly string[] };
}

/** Short dim explainer for each access mode, shared with `inspect`'s access row. */
export function accessModeNote(mode: string): string {
  if (mode === 'owner-only') return '— only the bound owner can connect';
  if (mode === 'org-members') return '— org members sign in';
  if (mode === 'authenticated') return '— any signed-in user';
  if (mode === 'customers') return '— your customers sign in';
  if (mode === 'public') return '— anyone can connect (anonymous)';
  if (mode === 'mixed') return '— anonymous, with optional sign-in';
  return '— identity-based access';
}

/**
 * Render the `status` detail card (approved design 2026-07-06): orange org/app/env title,
 * gradient-spine rows with semantic tones, dim provenance notes, and the NEXT footer. Pure and
 * clock-injectable; shared verbatim by the one-shot print and every `--watch` frame.
 */
export function renderStatusCard(
  body: StatusResponse,
  serviceUrl: string,
  opts: DetailCardOptions,
  now: number = Date.now(),
): string {
  const deployment = body.deployment;
  const rows: DetailRow[] = [
    {
      key: 'deployment',
      value: deployment.deploymentId,
      ...(deployment.serverVersion !== undefined ? { note: `(v${deployment.serverVersion})` } : {}),
    },
    deployment.active
      ? { key: 'state', value: 'active', tone: 'good', dot: true }
      : { key: 'state', value: 'inactive', tone: 'dim' },
    deployment.deploymentLock === undefined
      ? { key: 'lock', value: 'unlocked', tone: 'dim' }
      : {
          key: 'lock',
          value: 'locked',
          tone: 'attention',
          ...(deployment.deploymentLock.lockedByEmail !== undefined
            ? { note: `by ${deployment.deploymentLock.lockedByEmail}` }
            : {}),
        },
    { key: 'endpoint', value: deployment.endpointUrl },
    {
      key: 'access',
      value: deployment.accessMode,
      tone: 'attention',
      note: accessModeNote(deployment.accessMode),
    },
    ...(deployment.ownerSubject !== undefined
      ? [{ key: 'owner', value: deployment.ownerSubject, tone: 'dim' } satisfies DetailRow]
      : []),
    {
      key: 'deployed',
      value: relativeTime(deployment.createdAt, now),
      ...(deployment.createdByEmail !== undefined
        ? { note: `by ${deployment.createdByEmail}` }
        : {}),
    },
    {
      key: 'health',
      value: body.health.state,
      tone: body.health.state === 'ready' ? 'good' : 'bad',
    },
    ...(!body.config.ok
      ? [
          {
            key: 'secrets',
            value: `missing ${body.config.missingSecrets.join(', ')}`,
            tone: 'bad',
          } satisfies DetailRow,
        ]
      : []),
    { key: 'service', value: serviceUrl, tone: 'dim' },
  ];
  return renderDetailCard(`${body.target.org}/${body.target.app}/${body.target.env}`, rows, opts, [
    'noodle logs --tail',
    'noodle metrics',
    'noodle github runs',
  ]);
}

/**
 * Fetch + render the `status` view — shared by the one-shot print and `--watch`. Exported so
 * tests can exercise the exact function `--watch` polls without driving the live loop itself.
 */
export async function statusFrame(
  statusUrl: string,
  resolved: { serviceUrl: string; token?: string },
): Promise<WatchFrame> {
  try {
    const body = await serviceJson<StatusResponse>(statusUrl, resolved.token);
    return { ok: true, frame: renderStatusCard(body, resolved.serviceUrl, stdoutTableOptions()) };
  } catch (error) {
    return { ok: false, error: serviceFailure('status', error, 'noodle doctor') };
  }
}

export async function runStatus(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseTenantCommandArgs(rest);
  const { watch, intervalMs } = parseWatchFlags(rest);
  if (watch && args.json) {
    return printCliFailure('status', watchJsonConflictFailure('noodle status --json'), true);
  }
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('status', target.error, args.json);
  const serverVersion = normalizeCommandServerVersion('status', args.serverVersion, args.json);
  if (!serverVersion.ok) return serverVersion.exitCode;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(
      'status',
      {
        code: 'auth_required',
        message: 'No control-plane login token is available.',
        cause: 'Hosted status requires an authenticated Noodle Seed Cloud identity.',
        fix: 'Sign in to the target service.',
        next: 'noodle login',
        exitCode: 3,
      },
      args.json,
    );
  }
  const statusUrl =
    `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
    `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/status` +
    (serverVersion.value !== undefined
      ? `?version=${encodeURIComponent(serverVersion.value)}`
      : '');

  if (args.json) {
    try {
      const body = await serviceJson<StatusResponse>(statusUrl, resolved.token);
      printJsonOk({ ...body, service: resolved.serviceUrl });
      return 0;
    } catch (error) {
      return printCliFailure('status', serviceFailure('status', error, 'noodle doctor'), true);
    }
  }

  if (watch) {
    return runWatch({
      command: 'status',
      intervalMs,
      render: () => statusFrame(statusUrl, resolved),
    });
  }

  const result = await statusFrame(statusUrl, resolved);
  if (!result.ok) return printCliFailure('status', result.error, false);
  console.log(result.frame);
  return 0;
}

export async function runRollback(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  pluginMode?: PluginMode,
): Promise<number> {
  let deploymentId: string | undefined;
  let reason: string | undefined;
  const tenantArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--reason') reason = rest[++i];
    else if (
      arg === '--org' ||
      arg === '--app' ||
      arg === '--env' ||
      arg === '--service' ||
      arg === '--auth-token'
    ) {
      tenantArgs.push(arg);
      const value = rest[++i];
      if (value !== undefined) tenantArgs.push(value);
    } else if (arg === '--json') {
      tenantArgs.push(arg);
    } else if (arg?.startsWith('--')) {
      const args = parseTenantCommandArgs(rest);
      return printCliFailure(
        'rollback',
        {
          code: 'usage_error',
          message: `unknown rollback option ${arg}`,
          cause: `${arg} is not a supported rollback option.`,
          fix: 'Remove the unknown option or use a supported rollback flag.',
          next: 'noodle rollback <deploymentId> --org <org> --app <app> --env <env>',
          exitCode: 2,
        },
        args.json,
      );
    } else if (arg !== undefined && !arg.startsWith('--') && deploymentId === undefined) {
      deploymentId = arg;
    }
  }
  const args = parseTenantCommandArgs(tenantArgs);
  if (deploymentId === undefined || deploymentId.startsWith('--')) {
    return printCliFailure(
      'rollback',
      {
        code: 'usage_error',
        message: 'rollback requires a deployment id',
        cause: 'No deployment id was provided.',
        fix: 'Pass the historical deployment id to reactivate.',
        next: 'noodle deployments list --org <org> --app <app> --env <env>',
        exitCode: 2,
      },
      args.json,
    );
  }
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('rollback', target.error, args.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(
      'rollback',
      {
        code: 'auth_required',
        message: 'No control-plane login token is available.',
        cause: 'Hosted rollback requires an authenticated Noodle Seed Cloud identity.',
        fix: 'Sign in to the target service.',
        next: 'noodle login',
        exitCode: 3,
      },
      args.json,
    );
  }
  const compatibilityFailure = await pluginServiceCompatibilityFailure({
    ...(pluginMode !== undefined ? { pluginMode } : {}),
    serviceUrl: resolved.serviceUrl,
  });
  if (compatibilityFailure !== undefined) {
    return printCliFailure('rollback', compatibilityFailure, args.json);
  }
  try {
    const body = await serviceJson<{
      ok: true;
      target: { org: string; app: string; env: string };
      rollback: {
        deploymentId: string;
        previousDeploymentId?: string;
        alreadyActive: boolean;
        endpointUrl: string;
        serverVersion?: string;
        accessMode: AccessMode;
        ownerSubject?: string;
        previousAccessMode?: AccessMode;
        serverName: string;
        createdAt: string;
      };
    }>(
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
        `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/rollback`,
      resolved.token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deploymentId,
          ...(reason !== undefined ? { reason } : {}),
        }),
      },
    );
    if (args.json) {
      printJsonOk({ ...body, service: resolved.serviceUrl });
      return 0;
    }
    console.log(`service: ${resolved.serviceUrl}`);
    console.log(`target:  ${body.target.org}/${body.target.app}/${body.target.env}`);
    console.log(`active:  ${body.rollback.deploymentId}`);
    if (body.rollback.serverVersion !== undefined)
      console.log(`version: ${body.rollback.serverVersion}`);
    if (body.rollback.previousDeploymentId !== undefined) {
      console.log(`from:    ${body.rollback.previousDeploymentId}`);
    }
    console.log(`url:     ${body.rollback.endpointUrl}`);
    console.log(`access:  ${body.rollback.accessMode}`);
    if (body.rollback.ownerSubject !== undefined)
      console.log(`owner:   ${body.rollback.ownerSubject}`);
    if (body.rollback.alreadyActive) console.log('status:  already active');
    return 0;
  } catch (error) {
    return printCliFailure(
      'rollback',
      serviceFailure('rollback', error, `noodle billing org inspect ${target.org}`),
      args.json,
    );
  }
}

function accessServiceFailure(error: unknown): CliFailure {
  if (
    error instanceof ServiceRequestError &&
    error.status === 409 &&
    error.code === 'owner_identity_required'
  ) {
    return {
      code: error.code,
      message: error.message,
      cause: 'Owner-only access requires an exact OAuth subject for this deployment.',
      fix: 'Bind the subject that should be admitted at the data plane.',
      next: 'noodle access set owner-only --owner-subject <subject>',
      retryable: false,
      exitCode: EXIT.FAILURE,
    };
  }
  if (
    error instanceof ServiceRequestError &&
    error.status === 403 &&
    error.code === 'organization_owner_required'
  ) {
    return {
      code: error.code,
      message: error.message,
      cause: 'Only an organization owner can change environment access.',
      fix: 'Ask an organization owner to make this change or sign in with an owner account.',
      next: 'noodle whoami',
      retryable: false,
      exitCode: EXIT.AUTH,
    };
  }
  return serviceFailure('access', error, 'noodle status');
}

export async function runAccess(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const action = rest[0]?.startsWith('--') === true ? undefined : rest[0];
  const afterAction = action === undefined ? rest : rest.slice(1);
  const mode = afterAction[0]?.startsWith('--') === true ? undefined : afterAction[0];
  const tail = mode === undefined ? afterAction : afterAction.slice(1);
  let ownerSubject: string | undefined;
  let ownerSubjectFlagSeen = false;
  const tenantTail: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const argument = tail[index];
    if (argument === '--owner-subject') {
      ownerSubjectFlagSeen = true;
      ownerSubject = tail[++index];
    } else if (argument !== undefined) {
      tenantTail.push(argument);
    }
  }
  const args = parseTenantCommandArgs(tenantTail);
  if (ownerSubjectFlagSeen && !deploymentOwnerSubjectSchema.safeParse(ownerSubject).success) {
    return printCliFailure(
      'access',
      {
        code: 'invalid_owner_subject',
        message: '--owner-subject requires one valid OAuth subject.',
        cause: 'The subject was missing or did not satisfy the deployment owner contract.',
        fix: 'Pass the exact OAuth subject without outer whitespace or control characters.',
        next: 'noodle access set owner-only --owner-subject <subject>',
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }
  if (action !== 'set' || !isAccessMode(mode)) {
    return printCliFailure(
      'access',
      {
        code: 'usage_error',
        message:
          'usage: noodle access set owner-only|org-members|authenticated|public|mixed|customers',
        cause: 'The access command needs a supported access mode.',
        fix: 'Choose owner-only, org-members, authenticated, public, mixed, or customers.',
        next: 'noodle access set owner-only',
        exitCode: 2,
      },
      args.json,
    );
  }
  if (ownerSubject !== undefined && mode !== 'owner-only') {
    return printCliFailure(
      'access',
      {
        code: 'invalid_owner_subject_mode',
        message: '--owner-subject is valid only with owner-only access.',
        cause: `The requested ${mode} mode has no bound deployment owner.`,
        fix: 'Remove --owner-subject or choose owner-only access.',
        next: 'noodle access set owner-only --owner-subject <subject>',
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }
  const target = resolveTenantTarget(args, home);
  if (!target.ok) return printCliFailure('access', target.error, args.json);
  const serverVersion = normalizeCommandServerVersion('access', args.serverVersion, args.json);
  if (!serverVersion.ok) return serverVersion.exitCode;
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service ?? target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(
      'access',
      {
        code: 'auth_required',
        message: 'No control-plane login token is available.',
        cause: 'Hosted access updates require an authenticated Noodle Seed Cloud identity.',
        fix: 'Sign in to the target service.',
        next: 'noodle login',
        exitCode: 3,
      },
      args.json,
    );
  }
  try {
    const body = accessUpdateClientResponseSchema.parse(
      await serviceJson<unknown>(
        `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
          `/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/access`,
        resolved.token,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            accessMode: mode,
            ...(ownerSubject !== undefined ? { ownerSubject } : {}),
            ...(serverVersion.value !== undefined ? { serverVersion: serverVersion.value } : {}),
          }),
        },
      ),
    );
    if (args.json) {
      printJsonOk({ ...body, service: resolved.serviceUrl });
      return 0;
    }
    console.log(`service: ${resolved.serviceUrl}`);
    console.log(`target:  ${body.target.org}/${body.target.app}/${body.target.env}`);
    console.log(`deploy:  ${body.deployment.deploymentId}`);
    if (body.deployment.serverVersion !== undefined)
      console.log(`version: ${body.deployment.serverVersion}`);
    console.log(`access:  ${body.deployment.accessMode}`);
    if (body.deployment.ownerSubject !== undefined)
      console.log(`owner:   ${body.deployment.ownerSubject}`);
    return 0;
  } catch (error) {
    return printCliFailure('access', accessServiceFailure(error), args.json);
  }
}
