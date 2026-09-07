import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { DEVELOPER_CLI_PATH } from '@noodle-borg/developer-mcp';
import type {
  AuditSink,
  ControlPlaneIdentity as ModuleIdentity,
  ModuleLogger,
  ModuleRoute,
  ModuleRouteContext,
} from '@noodle-borg/module';
import {
  applySecurityHeaders,
  enforceHttps,
  type Logger,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import { authorizeDeveloperGrant } from '../auth/developer-grant-guard.js';
import { baseFromRequest, respondRouteError } from '../http-util.js';
import { endpointUrlOptionsForOrg } from '../mcp-public-routing.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import { withEndpointUrl } from '../routes/endpoint-enrichment.js';
import type { ControlPlaneStore } from '../store.js';

export interface ModuleRouteContextDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly registry: Pick<
    ServerRegistry,
    | 'getDeployment'
    | 'getDeploymentPackage'
    | 'reconcilePlatformAccountReset'
    | 'customerAuthRestoreProjections'
  >;
  readonly developerGrants?: DeveloperGrantStore;
  readonly audit: AuditSink;
  readonly logger?: ModuleLogger;
  readonly options: ServiceOptions;
}

/**
 * Builds request-bound module capabilities. Deployment reads stay inert until this exact request has
 * passed tenant authorization for the same organization, even if a module calls the view out of order.
 */
export function createModuleRouteContext(
  hostRequest: IncomingMessage,
  deps: ModuleRouteContextDeps,
): ModuleRouteContext {
  const authorizedOrgs = new Set<string>();
  return {
    logger: deps.logger ?? noopModuleLogger,
    controlPlane: deps.gate,
    audit: deps.audit,
    platformIdentityRecovery: {
      reconcile: (plan) => deps.registry.reconcilePlatformAccountReset(plan),
      customerAuthRestoreProjections: async (deploymentIds) =>
        (await deps.registry.customerAuthRestoreProjections(deploymentIds)).map((projection) => ({
          deploymentId: projection.deploymentId,
          manifest: projection.manifest,
          serverAuth: projection.serverAuth,
        })),
    },
    tenantControl: {
      authorize: async (request, input) => {
        if (request !== hostRequest) return forbidden('forbidden');
        const auth = await deps.gate.authorize(request);
        if (!auth.ok) return auth;
        const identity = auth.identity;
        if (identity === undefined) return { ok: false, status: 401, message: 'identity required' };
        if (identity.developerGrantId !== undefined) {
          if (input.permission === 'org:manage' || input.permission === 'org:member') {
            return forbidden('developer grants cannot access member-only organization controls');
          }
          const allowed =
            deps.developerGrants !== undefined &&
            (await authorizeDeveloperGrant(identity, {
              grants: deps.developerGrants,
              controlPlane: deps.controlPlane,
              org: input.org,
              capability: input.permission,
              resourcePaths: new Set([DEVELOPER_CLI_PATH]),
            }));
          if (!allowed) {
            return forbidden('developer grant does not authorize this operation');
          }
        }
        if (!identity.superAdmin) {
          if (input.permission === 'org:manage') {
            const member = await deps.controlPlane.getOrgMember({
              org: input.org,
              subject: identity.subject,
            });
            if (member?.role !== 'owner') return forbidden('forbidden');
          } else if (
            !(await deps.controlPlane.isOrgMember({ org: input.org, subject: identity.subject }))
          ) {
            return forbidden('forbidden');
          }
        }
        authorizedOrgs.add(input.org);
        return { ok: true, identity: moduleIdentity(identity) };
      },
    },
    deploymentPackages: {
      get: async (request, input) => {
        if (request !== hostRequest || !authorizedOrgs.has(input.org)) return undefined;
        const resolved = await resolveCurrentDeploymentPackage(deps.registry, input);
        if (resolved === undefined) return undefined;
        const { deployment, storedPackage } = resolved;
        const skill = storedPackage.snapshot.files.find(
          (file) => file.target === 'codex' && file.path.endsWith('/SKILL.md'),
        );
        const reference = storedPackage.snapshot.files.find(
          (file) => file.target === 'codex' && file.path.endsWith('/references/mcp-surface.md'),
        );
        if (skill === undefined || reference === undefined) return undefined;
        const endpointOptions = await endpointUrlOptionsForOrg(
          deps.options,
          deps.controlPlane,
          input.org,
        );
        const endpointUrl = withEndpointUrl(
          deployment,
          deps.options.publicBaseUrl ?? baseFromRequest(hostRequest, deps.options.tls ?? {}),
          endpointOptions,
        ).endpointUrl;
        if (endpointUrl === undefined) return undefined;
        const artifact = storedPackage.snapshot.artifact;
        return {
          deploymentId: deployment.deploymentId,
          appSlug: deployment.appSlug,
          environment: deployment.environment,
          ...(deployment.serverVersion === undefined
            ? {}
            : { serverVersion: deployment.serverVersion }),
          active: deployment.active,
          ...(deployment.archivedAt === undefined ? {} : { archivedAt: deployment.archivedAt }),
          accessMode: deployment.accessMode,
          endpointUrl,
          snapshotSha256: storedPackage.snapshot.snapshotSha256,
          appPackage: {
            name: artifact.app.name,
            version: artifact.app.version,
            sourceManifestSha256: artifact.provenance.sourceManifestSha256,
            mcpSurfaceSha256: artifact.provenance.mcpSurfaceSha256,
            skillMarkdown: skill.content,
            referenceMarkdown: reference.content,
          },
        };
      },
    },
    distributionDelivery: {
      get: async (request, input) => {
        if (request !== hostRequest) return undefined;
        const resolved = await resolveCurrentDeploymentPackage(deps.registry, input);
        if (resolved === undefined) return undefined;
        const { deployment, storedPackage } = resolved;
        return {
          deploymentId: deployment.deploymentId,
          appSlug: deployment.appSlug,
          environment: deployment.environment,
          ...(deployment.serverVersion === undefined
            ? {}
            : { serverVersion: deployment.serverVersion }),
          active: deployment.active,
          ...(deployment.archivedAt === undefined ? {} : { archivedAt: deployment.archivedAt }),
          accessMode: deployment.accessMode,
          snapshotSha256: storedPackage.snapshot.snapshotSha256,
        };
      },
    },
  };
}

async function resolveCurrentDeploymentPackage(
  registry: ModuleRouteContextDeps['registry'],
  input: { readonly org: string; readonly deploymentId: string },
) {
  const deployment = await registry.getDeployment(input.org, input.deploymentId);
  if (deployment === undefined) return undefined;
  const storedPackage = await registry.getDeploymentPackage(input.org, input.deploymentId);
  if (
    storedPackage === undefined ||
    storedPackage.deploymentId !== deployment.deploymentId ||
    storedPackage.appSlug !== deployment.appSlug ||
    storedPackage.environment !== deployment.environment ||
    storedPackage.serverVersion !== deployment.serverVersion ||
    storedPackage.active !== deployment.active ||
    storedPackage.archivedAt !== deployment.archivedAt
  ) {
    return undefined;
  }
  return { deployment, storedPackage };
}

export interface ModuleRouteDispatchDeps extends ModuleRouteContextDeps {
  readonly routes: readonly ModuleRoute[];
  readonly logger: Logger;
  readonly tls: TlsPosture;
}

/** Match and dispatch one service module route after the core route families. */
export function dispatchModuleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ModuleRouteDispatchDeps,
): boolean {
  const route = deps.routes.find((candidate) => candidate.match(req.method, url));
  if (route === undefined) return false;
  applySecurityHeaders(res, deps.tls);
  if (enforceHttps(req, res, deps.tls)) return true;
  Promise.resolve(route.handle(req, res, createModuleRouteContext(req, deps))).catch((error) =>
    respondRouteError(deps.logger, res, 'module.route.failed', error),
  );
  return true;
}

function moduleIdentity(identity: {
  readonly subject: string;
  readonly email: string;
  readonly superAdmin: boolean;
}): ModuleIdentity {
  return {
    subject: identity.subject,
    email: identity.email,
    superAdmin: identity.superAdmin,
  };
}

function forbidden(message: string): {
  readonly ok: false;
  readonly status: 403;
  readonly message: string;
} {
  return { ok: false, status: 403, message };
}

const noopModuleLogger: ModuleLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
