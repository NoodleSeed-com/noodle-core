import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostedPackagedAsset } from '@noodle-borg/compiler';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { ensurePersonalWorkspace } from '@noodle-borg/control-plane/portable';
import {
  DEVELOPER_ASSISTANT_PATH,
  DEVELOPER_CLI_PATH,
  type DeveloperCapability,
} from '@noodle-borg/developer-mcp';
import { normalizeServerVersion, type OrgMembershipSource } from '@noodle-borg/module';
import { type AccessMode, readDeployBody, sendJson } from '@noodle-borg/transport-http';
import {
  type DeploymentSource,
  deployRequestSchema,
  formatWireError,
  WhoamiIdentityResponseSchema,
} from '@noodle-borg/wire-contracts';
import {
  authorizeDeveloperGrant,
  type DeveloperGrantAuthorizationContext,
} from '../auth/developer-grant-guard.js';
import { executeAuthorizedDeployment } from '../deployment-execution.js';
import { baseFromRequest, sendForbidden, sendUnauthorized } from '../http-util.js';
import { endpointUrlOptionsForOrg } from '../mcp-public-routing.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { validateDeployIdempotency } from './deploy-idempotency.js';
import { tenantMcpUrl } from './endpoint-enrichment.js';
import { canManageMembers } from './org-admin.js';

export async function handleDeploy(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  options: ServiceOptions,
  maxBody: number,
  tenant: TenantRef,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
): Promise<void> {
  // GHD-3: a GitHub run deploys with a run-scoped token on x-noodle-run-token — NOT a control-plane
  // identity. When that header is present the human control-plane auth (bearer + org membership) is
  // skipped entirely; `resolveRunDeployAuthorization` (after the body parse, since it needs the
  // declared access mode) is the whole authorization for that path.
  const isRunDeploy = req.headers['x-noodle-run-token'] !== undefined;
  let identity: ControlPlaneIdentity | undefined;
  if (!isRunDeploy) {
    const human = await authorizeHumanDeploy(req, res, options, gate, controlPlane, tenant.org);
    if (human === false) return;
    identity = human;
  }
  // Archived apps are soft-deleted (ADR 0117): refuse new deploys so the all-records-archived
  // invariant can't be broken sideways. Restore first, then deploy.
  const appArchivedAt = await registry.getAppArchivedAt(tenant.org, tenant.app);
  if (appArchivedAt !== undefined) {
    await audit.emit({
      eventType: 'deploy.rejected',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      decision: 'deny',
      status: 409,
      reasonCode: 'app_archived',
      ...(identity?.subject !== undefined ? { actorSubject: identity.subject } : {}),
      ...(identity?.email !== undefined ? { actorEmail: identity.email } : {}),
      details: { archivedAt: appArchivedAt },
    });
    return sendJson(res, 409, { error: 'app is archived; restore it before deploying' });
  }
  const body = await readDeployBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const idempotency = validateDeployIdempotency(req);
  if (!idempotency.ok) {
    return sendJson(res, idempotency.status, {
      error: idempotency.error,
      code: idempotency.code,
    });
  }

  let manifest: string;
  let connectors: string | undefined;
  let hostedAssets: readonly HostedPackagedAsset[] | undefined;
  let accessMode: AccessMode = 'owner-only';
  let automationId: string | undefined;
  // The declared mode from the body, kept raw for run deploys: a GitHub run resolves inherit →
  // declared → fail (never the owner-only default), so it must distinguish "nothing declared" from
  // an explicit choice (ADR 0132 Decision 4).
  let declaredAccessMode: string | undefined;
  let orgMembershipSources: readonly OrgMembershipSource[] | undefined;
  let deploymentSource: DeploymentSource | undefined;
  let requestedOwnerSubject: string | undefined, ownerSubject: string | undefined;
  let serverVersion: string;
  try {
    const raw = JSON.parse(body.text) as Record<string, unknown> | null;
    // Actionable guards for known-legacy fields before the wire schema strips/rejects them.
    if (raw !== null && typeof raw === 'object' && raw.secrets !== undefined) {
      throw new Error('"secrets" is no longer accepted; use noodle secrets set before deploy');
    }
    if (raw !== null && typeof raw === 'object' && raw.accessMode === 'caller-key') {
      throw new Error('caller-key access has been removed; use owner-only or org-members');
    }
    const parsed = deployRequestSchema.safeParse(raw);
    if (!parsed.success) throw new Error(formatWireError(parsed.error));
    manifest = parsed.data.manifest;
    connectors = parsed.data.connectors;
    if (parsed.data.accessMode !== undefined) {
      accessMode = parsed.data.accessMode;
      declaredAccessMode = parsed.data.accessMode;
    }
    orgMembershipSources = parsed.data.orgMembershipSources;
    hostedAssets = parsed.data.hostedAssets;
    deploymentSource = parsed.data.deploymentSource;
    requestedOwnerSubject = parsed.data.ownerSubject;
    serverVersion =
      parsed.data.serverVersion === undefined
        ? '1'
        : normalizeParsedServerVersion(parsed.data.serverVersion);
  } catch (error) {
    return sendJson(res, 400, { error: `invalid deploy request: ${(error as Error).message}` });
  }

  if (isRunDeploy && requestedOwnerSubject !== undefined) {
    return sendJson(res, 400, {
      error: 'automated deploys cannot select an explicit deployment owner',
      code: 'owner_subject_not_allowed_for_automation',
    });
  }
  if (!isRunDeploy) {
    const selection = await authorizeDeploymentOwnerSelection(
      res,
      controlPlane,
      tenant.org,
      accessMode,
      identity,
      requestedOwnerSubject,
    );
    if (!selection.ok) return;
    ownerSubject = selection.ownerSubject;
  }

  // GHD-3 trusted-phase auth (ADR 0132 Decision 3/4): a run deploy is authorized entirely by its
  // run token plus the access mode resolved here — the control-plane identity was skipped above.
  // Every rejection carries a machine-readable `code` so `noodle github runs <id>` can name the
  // stage, reason, and fix, and the resolved run actor becomes `identity` for audit + ownership.
  if (isRunDeploy) {
    if (options.deploymentAutomation === undefined) {
      return sendJson(res, 503, {
        error: 'automated deploys are not configured for this service',
        code: 'run_deploy_unavailable',
      });
    }
    const provenance = await registry.activeDeployProvenance(tenant);
    const automation = await options.deploymentAutomation.authorize({
      action: 'deploy',
      request: req,
      target: tenant,
      ...(provenance?.accessMode === undefined
        ? {}
        : { previousAccessMode: provenance.accessMode }),
      ...(declaredAccessMode === undefined ? {} : { declaredAccessMode }),
      ...(provenance?.ownerSubject === undefined
        ? {}
        : { previousOwnerSubject: provenance.ownerSubject }),
    });
    if (automation.kind === 'denied') {
      return sendJson(res, automation.status, {
        error: automation.message,
        code: automation.code,
      });
    }
    if (automation.kind === 'authorized') {
      if (!registry.supportsTransactionalModuleDeploymentActivation()) {
        return sendJson(res, 503, {
          error: 'module automation requires transactional deployment activation',
          code: 'automation_activation_unavailable',
        });
      }
      if (automation.accessMode === undefined) {
        return sendJson(res, 400, {
          error: 'automation did not resolve an access mode for this deploy',
          code: 'access_mode_required',
        });
      }
      accessMode = automation.accessMode;
      orgMembershipSources ??= provenance?.orgMembershipSources;
      identity = automation.actor;
      ownerSubject = automation.ownerSubject;
      automationId = automation.automationId;
    } else {
      return sendJson(res, 401, {
        error: 'run token is not authorized for this deployment',
        code: 'run_token_unauthorized',
      });
    }
  }
  if (isRunDeploy && accessMode === 'owner-only' && ownerSubject === undefined) {
    return sendJson(res, 400, {
      error: 'owner-only automation requires an existing human owner to preserve',
      code: 'owner_only_unsupported_for_automation',
    });
  }

  const executed = await executeAuthorizedDeployment(
    {
      tenant,
      manifest,
      connectors,
      hostedAssets,
      accessMode,
      identity,
      ownerSubject,
      orgMembershipSources,
      deploymentSource,
      serverVersion,
      idempotencyKey: idempotency.key,
      automationId,
    },
    { registry, options, controlPlane, audit },
  );
  if (!executed.ok) return sendJson(res, executed.status, executed.body);
  const { result, embedId } = executed;

  const base = options.publicBaseUrl ?? baseFromRequest(req, options.tls ?? {});
  const endpointOptions = await endpointUrlOptionsForOrg(options, controlPlane, tenant.org);
  return sendJson(res, 201, {
    ok: true,
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    deploymentId: result.deploymentId,
    serverVersion: result.serverVersion,
    accessMode: result.accessMode,
    ...(result.ownerSubject !== undefined ? { ownerSubject: result.ownerSubject } : {}),
    url: tenantMcpUrl(base, tenant, result.serverVersion, endpointOptions),
    defaultUrl: tenantMcpUrl(base, tenant, undefined, endpointOptions),
    ...(embedId !== undefined ? { embedId } : {}),
  });
}

function normalizeParsedServerVersion(value: unknown): string {
  if (typeof value !== 'string') throw new Error('"serverVersion" must be a version string');
  return normalizeServerVersion(value);
}

export async function authorizeDeploymentOwnerSelection(
  res: ServerResponse,
  controlPlane: ControlPlaneStore,
  org: string,
  accessMode: AccessMode,
  identity: ControlPlaneIdentity | undefined,
  requestedOwnerSubject: string | undefined,
): Promise<{ readonly ok: true; readonly ownerSubject?: string } | { readonly ok: false }> {
  if (accessMode !== 'owner-only') return { ok: true };
  if (identity === undefined) {
    sendJson(res, 401, {
      error: 'owner-only deployments require an authenticated deployer',
      code: 'deployer_identity_required',
    });
    return { ok: false };
  }
  if (requestedOwnerSubject === undefined || requestedOwnerSubject === identity.subject) {
    return { ok: true, ownerSubject: identity.subject };
  }
  if (
    identity.developerGrantId !== undefined ||
    !(await canManageMembers(controlPlane, org, identity))
  ) {
    sendJson(res, 403, {
      error: 'Selecting a different deployment owner requires organization owner access.',
      code: 'deployment_owner_authorization_required',
    });
    return { ok: false };
  }
  return { ok: true, ownerSubject: requestedOwnerSubject };
}

export async function handleWhoami(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  options: ServiceOptions = {},
  scope?: 'identity',
): Promise<void> {
  // Identity introspection names no org or environment, so no grant context can describe it.
  const identity = await authorizeControlPlane(req, res, gate, {
    requireIdentity: true,
    developerAccess: 'grant-independent',
  });
  if (identity === false) return;
  if (scope === 'identity') {
    const response = WhoamiIdentityResponseSchema.parse({
      ok: true,
      data: {
        identity: {
          subject: identity.subject,
          email: identity.email,
          superAdmin: identity.superAdmin,
        },
      },
    });
    return sendJson(res, 200, response);
  }
  if (!identity.superAdmin && options.controlPlaneSignupMode === 'public') {
    await ensurePersonalWorkspace(controlPlane, identity);
  }
  const orgs = identity.superAdmin
    ? await controlPlane.listOrgs()
    : await controlPlane.listOrgsForSubject(identity.subject);
  return sendJson(res, 200, { ok: true, identity, orgs });
}

export async function authorizeTenantControl(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  org: string,
  developerAccess?: DeveloperGrantRouteAccess,
): Promise<ControlPlaneIdentity | false> {
  const identity = await authorizeControlPlane(req, res, gate, {
    requireIdentity: true,
    ...(developerAccess === undefined
      ? {}
      : {
          developerAccess: {
            ...developerAccess,
            controlPlane,
            org,
          },
        }),
  });
  if (identity === false) return false;
  if (!identity.superAdmin) {
    const member = await controlPlane.isOrgMember({ org, subject: identity.subject });
    if (!member) {
      sendForbidden(res, 'forbidden');
      return false;
    }
  }
  return identity;
}

export async function handleDeploymentStatus(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  tenant: TenantRef,
  options: ServiceOptions,
  url?: URL,
): Promise<void> {
  const identity = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    tenant.org,
    developerGrantRouteAccess(options.developerGrantStore, 'cloud:read'),
  );
  if (identity === false) return;
  try {
    const base = options.publicBaseUrl ?? baseFromRequest(req, options.tls ?? {});
    const rawVersion = url?.searchParams.get('version') ?? undefined;
    const serverVersion =
      rawVersion !== undefined && rawVersion !== ''
        ? normalizeServerVersion(rawVersion)
        : undefined;
    const endpointOptions = await endpointUrlOptionsForOrg(options, controlPlane, tenant.org);
    const status = await registry.getStatus(tenant, base, serverVersion, endpointOptions);
    if (status === undefined) return sendJson(res, 404, { error: 'no active deployment' });
    return sendJson(res, 200, { ok: true, ...status });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
}

export interface DeveloperGrantRouteAccess {
  readonly grants: DeveloperGrantStore;
  readonly capability: DeveloperCapability;
  readonly resourcePaths: ReadonlySet<string>;
}

export function developerGrantRouteAccess(
  grants: DeveloperGrantStore | undefined,
  capability: DeveloperCapability,
): DeveloperGrantRouteAccess | undefined {
  // Control-plane routes serve the CLI resource and the assistant resource (ADR 0218); the grant's
  // own capability ceiling — never this set — decides what each may actually do.
  return grants === undefined
    ? undefined
    : {
        grants,
        capability,
        resourcePaths: new Set([DEVELOPER_CLI_PATH, DEVELOPER_ASSISTANT_PATH]),
      };
}

async function authorizeHumanDeploy(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServiceOptions,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  org: string,
): Promise<ControlPlaneIdentity | undefined | false> {
  const developerAccess = developerGrantAccess(
    options.developerGrantStore,
    controlPlane,
    org,
    'deployments:write',
  );
  const identity = await authorizeControlPlane(req, res, gate, {
    requireIdentity: false,
    ...(developerAccess === undefined ? {} : { developerAccess }),
  });
  if (identity === false) return false;
  if (identity && !identity.superAdmin && options.controlPlaneSignupMode === 'public') {
    await ensurePersonalWorkspace(controlPlane, identity);
  }
  if (identity && !identity.superAdmin) {
    const member = await controlPlane.isOrgMember({ org, subject: identity.subject });
    if (!member) {
      sendForbidden(res, 'forbidden');
      return false;
    }
  }
  return identity;
}

function developerGrantAccess(
  grants: DeveloperGrantStore | undefined,
  controlPlane: ControlPlaneStore,
  org: string,
  capability: DeveloperCapability,
): DeveloperGrantAuthorizationContext | undefined {
  const access = developerGrantRouteAccess(grants, capability);
  return access === undefined ? undefined : { ...access, controlPlane, org };
}

/**
 * How a control-plane route admits a grant-bound credential (ADR 0208). Omitting this fails
 * closed, so **every new route must decide explicitly** or it is silently unreachable from the
 * plugin-managed CLI and the Developer MCP connection.
 *
 * - a `DeveloperGrantAuthorizationContext` — the route names its exact org/capability target and
 *   authorizes it against the user's live membership and role.
 * - `'grant-independent'` — the route carries no org or environment at all (identity introspection,
 *   feedback), so a resource grant does not govern it. It stays behind ordinary identity
 *   authentication; it never widens what the grant can reach.
 */
export type DeveloperRouteAuthorization = DeveloperGrantAuthorizationContext | 'grant-independent';

export function authorizeControlPlane(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  options: { requireIdentity: true; developerAccess?: DeveloperRouteAuthorization },
): Promise<ControlPlaneIdentity | false>;
export function authorizeControlPlane(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  options: { requireIdentity: false; developerAccess?: DeveloperRouteAuthorization },
): Promise<ControlPlaneIdentity | undefined | false>;
export async function authorizeControlPlane(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  options: { requireIdentity: boolean; developerAccess?: DeveloperRouteAuthorization },
): Promise<ControlPlaneIdentity | undefined | false> {
  const auth = await gate.authorize(req);
  if (!auth.ok) {
    if (auth.status === 401) sendUnauthorized(res, auth.message);
    else sendForbidden(res, auth.message);
    return false;
  }
  if (options.requireIdentity && !auth.identity) {
    sendUnauthorized(res, 'identity required');
    return false;
  }
  if (
    auth.identity?.developerGrantId !== undefined &&
    options.developerAccess !== 'grant-independent'
  ) {
    if (
      options.developerAccess === undefined ||
      !(await authorizeDeveloperGrant(auth.identity, options.developerAccess))
    ) {
      sendForbidden(res, 'developer grant does not authorize this operation');
      return false;
    }
  }
  return auth.identity;
}
