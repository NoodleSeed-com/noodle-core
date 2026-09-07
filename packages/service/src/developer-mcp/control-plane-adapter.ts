import {
  mcpSubdomainEndpointOptions,
  rollbackDeploymentOperation,
} from '@noodle-borg/control-plane/portable';
import {
  type AppInspectionView,
  type DeploymentInspectionView,
  type DeveloperAppSummary,
  type DeveloperCapability,
  type DeveloperContextView,
  type DeveloperControlPlane,
  DeveloperControlPlaneError,
  type DeveloperDeploymentSummary,
  type DeveloperMcpContext,
  type EventsView,
  type GetLogsInput,
  type GetMetricsInput,
  type GetSessionInput,
  type InspectAppInput,
  type InspectDeploymentInput,
  type ListAppsInput,
  type ListAppsView,
  type ListEventsInput,
  type LogsView,
  type MetricsView,
  type RollbackDeploymentInput,
  type RollbackView,
  requestMetricsSchema,
  type SessionView,
} from '@noodle-borg/developer-mcp';
import type { EndpointUrlOptions, RequestEvent, RequestEventStore } from '@noodle-borg/module';
import { aggregateRequestEvents } from '@noodle-borg/observability';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { UserAppLogEvent, UserAppLogStore } from '../store/user-app-logs.js';
import type { AppSummary, ControlPlaneStore, DeploymentSummary, EnvSummary } from '../store.js';
import { inspectCompiledServiceDeployment, inspectServiceDeployment } from './inspection.js';

const METRICS_SCAN_LIMIT = 50_000;
const WINDOWS_MS = {
  '24h': 24 * 60 * 60 * 1_000,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
} as const;

export type DeveloperRegistry = Pick<
  ServerRegistry,
  | 'listApps'
  | 'getApp'
  | 'getEnvironment'
  | 'getDeployment'
  | 'get'
  | 'getStatus'
  | 'getActiveByTenant'
  | 'listDeployments'
  | 'getAppArchivedAt'
  | 'rollback'
>;

export interface ServiceDeveloperControlPlaneOptions {
  readonly registry: DeveloperRegistry;
  readonly logs: UserAppLogStore;
  readonly requestEvents: RequestEventStore;
  readonly controlPlane: Pick<
    ControlPlaneStore,
    'getActiveMcpSubdomain' | 'getOrgMember' | 'listOrgsForSubject'
  >;
  readonly audit: AuditSink;
  readonly publicBaseUrl: string;
  readonly publicBaseDomain?: string;
  readonly now?: () => Date;
}

export class ServiceDeveloperControlPlane implements DeveloperControlPlane {
  readonly #registry: DeveloperRegistry;
  readonly #logs: UserAppLogStore;
  readonly #requestEvents: RequestEventStore;
  readonly #controlPlane: Pick<
    ControlPlaneStore,
    'getActiveMcpSubdomain' | 'getOrgMember' | 'listOrgsForSubject'
  >;
  readonly #audit: AuditSink;
  readonly #publicBaseUrl: string;
  readonly #publicBaseDomain: string | undefined;
  readonly #now: () => Date;

  constructor(options: ServiceDeveloperControlPlaneOptions) {
    this.#registry = options.registry;
    this.#logs = options.logs;
    this.#requestEvents = options.requestEvents;
    this.#controlPlane = options.controlPlane;
    this.#audit = options.audit;
    this.#publicBaseUrl = options.publicBaseUrl;
    this.#publicBaseDomain = options.publicBaseDomain;
    this.#now = options.now ?? (() => new Date());
  }

  async getContext(ctx: DeveloperMcpContext): Promise<DeveloperContextView> {
    const orgs = await this.#controlPlane.listOrgsForSubject(ctx.subject);
    const organizations = await Promise.all(
      orgs.map(async (org) => {
        const member = await this.#controlPlane.getOrgMember({
          org: org.slug,
          subject: ctx.subject,
        });
        if (member === undefined) return undefined;
        return {
          org: org.slug,
          ...(org.displayName === undefined ? {} : { displayName: org.displayName }),
          role: member.role,
          capabilities: effectiveCapabilities(ctx.capabilities, member.role),
        };
      }),
    );
    return {
      accessModel: 'live_user',
      capabilities: [...ctx.capabilities],
      organizations: organizations.filter(
        (organization): organization is NonNullable<typeof organization> =>
          organization !== undefined,
      ),
    };
  }

  async listApps(ctx: DeveloperMcpContext, input: ListAppsInput): Promise<ListAppsView> {
    await this.#requireAccess(ctx, input.org, 'cloud:read');
    const result = await this.#registry.listApps(input.org, { limit: input.limit });
    return { apps: result.apps.map(mapApp) };
  }

  async inspectApp(ctx: DeveloperMcpContext, input: InspectAppInput): Promise<AppInspectionView> {
    await this.#requireAccess(ctx, input.org, 'cloud:read');
    if (input.env !== undefined) {
      const environment = await this.#registry.getEnvironment(input.org, input.app, input.env);
      if (environment === undefined) throw notFound('app environment');
      return inspectedEnvironment(environment);
    }
    const app = await this.#registry.getApp(input.org, input.app);
    if (app === undefined) throw notFound('app');
    return mapApp(app);
  }

  async inspectDeployment(
    ctx: DeveloperMcpContext,
    input: InspectDeploymentInput,
  ): Promise<DeploymentInspectionView> {
    await this.#requireAccess(ctx, input.org, 'cloud:read');
    const deployment = await this.#registry.getDeployment(input.org, input.deploymentId);
    if (deployment === undefined) throw notFound('deployment');
    const endpointOptions = await this.#endpointOptions(input.org);
    const inspected = deployment.active
      ? await inspectServiceDeployment(
          this.#registry,
          { org: input.org, app: deployment.appSlug, env: deployment.environment },
          this.#publicBaseUrl,
          endpointOptions,
        )
      : await this.#registry
          .get(deployment.deploymentId)
          .then((target) =>
            target === undefined
              ? undefined
              : inspectCompiledServiceDeployment(
                  deployment,
                  target.served.artifact,
                  this.#publicBaseUrl,
                  endpointOptions,
                ),
          )
          .catch(() => undefined);
    if (inspected === undefined || inspected.deployment.deploymentId !== input.deploymentId) {
      throw notFound('deployment');
    }
    const rollbackCandidate = (await this.#canAccess(ctx, input.org, 'deployments:rollback'))
      ? await this.#rollbackCandidate(input.org, deployment.appSlug, deployment.environment)
      : undefined;
    return {
      target: { app: inspected.target.app, env: inspected.target.env },
      deployment: inspected.deployment,
      health: {
        state: inspected.health.state,
        missingSecrets: [...inspected.health.missingSecrets],
      },
      surface: {
        tools: inspected.surface.tools.map((tool) => ({ ...tool })),
        resources: inspected.surface.resources.map((resource) => ({ ...resource })),
        prompts: inspected.surface.prompts.map((prompt) => ({ ...prompt })),
        widgets: inspected.surface.widgets.map((widget) => ({
          uri: widget.uri,
          name: widget.name,
          mimeType: 'text/html;profile=mcp-app',
        })),
        compatibility: inspected.surface.compatibility,
      },
      findings: inspected.findings.map((finding) => ({ ...finding })),
      ...(rollbackCandidate === undefined ? {} : { rollbackCandidate }),
    };
  }

  async #rollbackCandidate(
    org: string,
    app: string,
    env: string,
  ): Promise<
    | { readonly deploymentId: string; readonly serverName: string; readonly createdAt: string }
    | undefined
  > {
    const deployments = await this.#registry.listDeployments({ org, app, env });
    const candidate = deployments.find((deployment) => !deployment.active);
    return candidate === undefined
      ? undefined
      : {
          deploymentId: candidate.deploymentId,
          serverName: candidate.serverName,
          createdAt: candidate.createdAt,
        };
  }

  async getLogs(ctx: DeveloperMcpContext, input: GetLogsInput): Promise<LogsView> {
    await this.#requireAccess(ctx, input.org, 'cloud:read');
    const events = await this.#logs.list({
      org: input.org,
      app: input.app,
      env: input.env,
      limit: input.limit,
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.search !== undefined ? { contains: input.search } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
    });
    return { events: events.map(mapLogEvent) };
  }

  async getMetrics(ctx: DeveloperMcpContext, input: GetMetricsInput): Promise<MetricsView> {
    await this.#requireAccess(ctx, input.org, 'cloud:read');
    const since =
      input.since ?? new Date(this.#now().getTime() - WINDOWS_MS[input.window]).toISOString();
    const events = await this.#requestEvents.list({
      org: input.org,
      app: input.app,
      env: input.env,
      since,
      ...(input.until !== undefined ? { until: input.until } : {}),
      limit: METRICS_SCAN_LIMIT,
    });
    return {
      window: { since, ...(input.until !== undefined ? { until: input.until } : {}) },
      truncated: events.length >= METRICS_SCAN_LIMIT,
      metrics: requestMetricsSchema.parse(aggregateRequestEvents(events)),
    };
  }

  async listEvents(ctx: DeveloperMcpContext, input: ListEventsInput): Promise<EventsView> {
    await this.#requireAccess(ctx, input.org, 'cloud:read');
    const events = await this.#requestEvents.list({
      org: input.org,
      app: input.app,
      env: input.env,
      limit: input.limit,
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.tool !== undefined ? { toolName: input.tool } : {}),
      ...(input.client !== undefined ? { clientName: input.client } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
    });
    return { events: events.map(mapRequestEvent) };
  }

  async getSession(ctx: DeveloperMcpContext, input: GetSessionInput): Promise<SessionView> {
    await this.#requireAccess(ctx, input.org, 'cloud:read');
    const events = await this.#requestEvents.list({
      org: input.org,
      app: input.app,
      env: input.env,
      sessionId: input.sessionId,
      limit: 1_000,
    });
    return { sessionId: input.sessionId, events: [...events].reverse().map(mapRequestEvent) };
  }

  async rollbackDeployment(
    ctx: DeveloperMcpContext,
    input: RollbackDeploymentInput,
  ): Promise<RollbackView> {
    await this.#requireAccess(ctx, input.org, 'deployments:rollback');
    const result = await rollbackDeploymentOperation(
      {
        registry: this.#registry,
        controlPlane: this.#controlPlane,
        audit: this.#audit,
      },
      {
        actor: { subject: ctx.subject, superAdmin: false },
        target: { org: input.org, app: input.app, env: input.env },
        deploymentId: input.deploymentId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        publicBaseUrl: this.#publicBaseUrl,
        endpointOptions: await this.#endpointOptions(input.org),
      },
    );
    if (!result.ok) throw rollbackError(result);
    return {
      target: { app: result.view.target.app, env: result.view.target.env },
      rollback: result.view.rollback,
    };
  }

  async #endpointOptions(org: string): Promise<EndpointUrlOptions> {
    return mcpSubdomainEndpointOptions(this.#controlPlane, org, this.#publicBaseDomain);
  }

  async #canAccess(
    ctx: DeveloperMcpContext,
    org: string,
    capability: DeveloperCapability,
  ): Promise<boolean> {
    if (!ctx.capabilities.includes(capability)) return false;
    const member = await this.#controlPlane.getOrgMember({ org, subject: ctx.subject });
    if (member === undefined) return false;
    return capability !== 'deployments:rollback' || member.role === 'owner';
  }

  async #requireAccess(
    ctx: DeveloperMcpContext,
    org: string,
    capability: DeveloperCapability,
  ): Promise<void> {
    if (await this.#canAccess(ctx, org, capability)) return;
    throw new DeveloperControlPlaneError(
      'forbidden_scope',
      `Live user access does not authorize ${capability} in organization "${org}".`,
    );
  }
}

function rollbackError(
  result: Extract<Awaited<ReturnType<typeof rollbackDeploymentOperation>>, { readonly ok: false }>,
): DeveloperControlPlaneError {
  const code =
    result.status === 403
      ? 'forbidden_scope'
      : result.status === 404
        ? 'not_found'
        : result.status === 503
          ? 'dependency_unavailable'
          : result.code === 'production_app_limit_exceeded'
            ? 'rate_limited'
            : 'validation_failed';
  return new DeveloperControlPlaneError(code, result.message);
}

function mapApp(app: AppSummary): DeveloperAppSummary {
  const latest = app.latest === undefined ? undefined : mapDeployment(app.latest);
  return {
    app: app.appSlug,
    environments: [...app.environments],
    active: latest?.active ?? false,
    createdAt: app.createdAt,
    ...(app.lastActivityAt !== undefined ? { lastActivityAt: app.lastActivityAt } : {}),
    ...(latest !== undefined ? { latest } : {}),
  };
}

function inspectedEnvironment(environment: EnvSummary): AppInspectionView {
  const latest = environment.latest !== undefined ? mapDeployment(environment.latest) : undefined;
  return {
    app: environment.appSlug,
    environments: [environment.envName],
    active: latest?.active ?? false,
    createdAt: environment.createdAt,
    ...(environment.lastActivityAt !== undefined
      ? { lastActivityAt: environment.lastActivityAt }
      : {}),
    ...(latest !== undefined ? { latest } : {}),
    selectedEnvironment: environment.envName,
  };
}

function mapDeployment(deployment: DeploymentSummary): DeveloperDeploymentSummary {
  return {
    deploymentId: deployment.deploymentId,
    environment: deployment.environment,
    active: deployment.active,
    serverName: deployment.serverName,
    createdAt: deployment.createdAt,
    accessMode: deployment.accessMode,
    ...(deployment.ownerSubject !== undefined ? { ownerSubject: deployment.ownerSubject } : {}),
    ...(deployment.endpointUrl !== undefined ? { endpointUrl: deployment.endpointUrl } : {}),
  };
}

function mapLogEvent(event: UserAppLogEvent): LogsView['events'][number] {
  return {
    id: event.id,
    createdAt: event.createdAt,
    level: event.level,
    message: event.message,
    ...(event.deploymentId !== undefined ? { deploymentId: event.deploymentId } : {}),
    ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
    ...(event.executionId !== undefined ? { executionId: event.executionId } : {}),
    ...(event.toolCallId !== undefined ? { toolCallId: event.toolCallId } : {}),
    ...(event.traceId !== undefined ? { traceId: event.traceId } : {}),
    ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
    ...(event.details !== undefined ? { details: event.details } : {}),
    ...(event.truncated !== undefined ? { truncated: event.truncated } : {}),
  };
}

function mapRequestEvent(event: RequestEvent): EventsView['events'][number] {
  return {
    id: event.id,
    ...(event.seq !== undefined ? { seq: event.seq } : {}),
    schemaVersion: event.schemaVersion,
    createdAt: event.createdAt,
    ...(event.deploymentId !== undefined ? { deploymentId: event.deploymentId } : {}),
    ...(event.serverVersion !== undefined ? { serverVersion: event.serverVersion } : {}),
    ...(event.sdkProtocolVersion !== undefined
      ? { sdkProtocolVersion: event.sdkProtocolVersion }
      : {}),
    requestId: event.requestId,
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    sessionSource: event.sessionSource,
    ...(event.clientName !== undefined ? { clientName: event.clientName } : {}),
    ...(event.clientVersion !== undefined ? { clientVersion: event.clientVersion } : {}),
    ...(event.accessMode !== undefined ? { accessMode: event.accessMode } : {}),
    subjectKind: event.subjectKind,
    method: event.method,
    kind: event.kind,
    ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
    ...(event.resourceName !== undefined ? { resourceName: event.resourceName } : {}),
    ...(event.promptName !== undefined ? { promptName: event.promptName } : {}),
    outcome: event.outcome,
    ...(event.errorKind !== undefined ? { errorKind: event.errorKind } : {}),
    durationMs: event.durationMs,
    ...(event.outputTokensEst !== undefined ? { outputTokensEst: event.outputTokensEst } : {}),
    ...(event.country !== undefined ? { country: event.country } : {}),
    ...(event.details !== undefined ? { details: event.details } : {}),
  };
}

function effectiveCapabilities(
  capabilities: readonly DeveloperCapability[],
  role: 'owner' | 'developer',
): DeveloperCapability[] {
  return capabilities.filter(
    (capability) => capability !== 'deployments:rollback' || role === 'owner',
  );
}

function notFound(kind: string): DeveloperControlPlaneError {
  return new DeveloperControlPlaneError('not_found', `${kind} not found in the selected scope.`);
}
