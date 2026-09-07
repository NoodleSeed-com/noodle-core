import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import {
  InMemoryAssistantAppearanceSettingsStore,
  InMemoryAssistantStore,
} from '@noodle-borg/assistant-gateway/portable';
import { allowAllGate, InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { dispatchKnowledgeRequest } from '@noodle-borg/knowledge-operations/portable';
import { OPENAI_APPS_CHALLENGE_PATH } from '@noodle-borg/module';
import {
  applySecurityHeaders,
  createMcpRouter,
  enforceHttps,
  noopLogger,
  sendJson,
  type TenantRouteRef,
} from '@noodle-borg/transport-http';
import { AnonymousConsumerLimiter, createAdmissionGate } from './admission.js';
import { createArchivePreflight } from './archive-preflight.js';
import { ArchiveSweeper, resolveArchiveRetentionDays } from './archive-sweeper.js';
import { serveLocalAsset } from './assets.js';
import { resolveBuildInfo, serviceInfoPayload } from './build-info.js';
import { InMemoryBusinessInformationStore } from './business-information/portable.js';
import { serviceCapabilityReport } from './capabilities.js';
import { rejectIncompatibleCli } from './client-compatibility.js';
import { createDataPlaneMembershipAuthorizer } from './data-plane-membership.js';
import { DEVELOPER_MCP_PATH, handleDeveloperMcpRequest } from './developer-mcp/mount.js';
import { createDeveloperMcpMountOptions } from './developer-mcp/service-options.js';
import { baseFromRequest, respondRouteError } from './http-util.js';
import { createMcpInvocationContextResolver } from './invocation-context.js';
import { wireServiceKnowledge } from './knowledge-wiring.js';
import * as mcp from './mcp-public-routing.js';
import { createServiceModuleProviders } from './modules/host.js';
import { dispatchModuleRoutes } from './modules/route-dispatch.js';
import { isAuthServerPath } from './oauth/paths.js';
import {
  createIntentTargetResolver,
  createObservabilityDispatcher,
  createObservabilityStores,
} from './observability-runtime.js';
import type { ServiceOptions } from './options.js';
import type { ServerRegistry } from './registry.js';
import { handleAccessUpdate } from './routes/access.js';
import { dispatchAlertRoutes } from './routes/alerts-dispatch.js';
import {
  type AppPurgeReconciliationAction,
  handleAppPurgeReconciliationRoute,
} from './routes/app-purge-reconciliation.js';
import { handleAppArchive, handleAppRestore } from './routes/archive.js';
import { handleAssetPreflight } from './routes/asset-control-plane.js';
import { dispatchAssistantRoutes } from './routes/assistant-dispatch.js';
import { dispatchAuthDiscoveryRoute } from './routes/auth-discovery.js';
import { dispatchBusinessInformationRoutes } from './routes/business-information-dispatch.js';
import { dispatchConfigValueRequest } from './routes/config-values-dispatch.js';
import {
  authorizeTenantControl,
  handleDeploymentStatus,
  handleWhoami,
} from './routes/control-plane.js';
import { dispatchCredentialAuthRoutes } from './routes/credential-auth-dispatch.js';
import { dispatchDeployRoutes } from './routes/deploy-dispatch.js';
import { handleAuditEvents, handleDeployments } from './routes/deployments.js';
import { handleHostedSmoke, handleInspect } from './routes/diagnostics.js';
import { dispatchEnvironmentMutations } from './routes/environment-mutation-dispatch.js';
import { handleUserAppLogs } from './routes/logs.js';
import { handlePublicOpenAIAppsChallenge } from './routes/openai-apps-challenge.js';
import { dispatchOrgAdminRoutes } from './routes/org-admin-dispatch.js';
import {
  parseAppArchivePath,
  parseAppRestorePath,
  parseAuditEventsPath,
  parseDeploymentsPath,
  parseTenantAccessPath,
  parseTenantAssetPreflightPath,
  parseTenantInspectPath,
  parseTenantLogsPath,
  parseTenantRollbackPath,
  parseTenantSmokePath,
  parseTenantStatusPath,
} from './routes/paths.js';
import { dispatchProtectedResourceMetadata } from './routes/protected-resource-metadata.js';
import { dispatchResourceReads } from './routes/resource-read-dispatch.js';
import { handleRollback } from './routes/rollback.js';
import { createServicePrincipalDispatcher } from './routes/service-principals-dispatch.js';
import { servicePrincipalDataPlaneHooks } from './service-principal-data-plane.js';
import { BUILTIN_STATE_CATALOG_CONNECTOR } from './state-catalog.js';
import { InMemoryAlertRuleStore } from './store/alert-rules.js';
import { type AuditSink, StdoutAuditSink } from './store/audit.js';

const DEFAULT_MAX_BODY = 1 << 20;
const DEFAULT_MAX_DEPLOY_BODY = 32 * 1024 * 1024;

/** The combined service listener: tenant-scoped deploy management plus the multi-tenant MCP router. */
export function createServiceHandler(
  registry: ServerRegistry,
  options: ServiceOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const logger = options.logger ?? noopLogger;
  const tls = options.tls ?? {};
  const buildInfo = options.buildInfo ?? resolveBuildInfo();
  const controlPlane = options.controlPlaneStore ?? new InMemoryControlPlaneStore();
  let activeAudit: AuditSink;
  const configStore = options.configStore ?? registry.configStore;
  const alertRuleStore = options.alertRuleStore ?? new InMemoryAlertRuleStore();
  const [intentSettings, intentEvents, requestEvents, intentPreviewOrgs] =
    createObservabilityStores(options);
  const assistantStore = options.assistantStore ?? new InMemoryAssistantStore();
  const assistantAppearance =
    options.assistantAppearance ?? new InMemoryAssistantAppearanceSettingsStore();
  const anonymousLimiter = new AnonymousConsumerLimiter();
  const publicCounters = options.admissionCounters ?? new InMemoryDailyCounterStore();
  const businessInformationStore =
    options.businessInformationStore ??
    (options.businessInformationEnabled === false
      ? undefined
      : new InMemoryBusinessInformationStore());
  registry.setPlatformConnectors({ catalog: [BUILTIN_STATE_CATALOG_CONNECTOR], connectors: [] });
  const moduleProviders = createServiceModuleProviders({
    options,
    auditMirror: new StdoutAuditSink(logger),
    admissionGate: createAdmissionGate(
      anonymousLimiter,
      { emit: (event) => activeAudit.emit(event) },
      options.admissionGate,
    ),
  });
  const moduleHost = moduleProviders.host;
  const providerOptions = moduleProviders.options;
  const verifyOwnerToken = moduleProviders.verifyOwnerToken;
  const capabilityReport = serviceCapabilityReport(moduleHost);
  registry.setServiceCapabilities(capabilityReport.capabilities);
  const audit = moduleHost.audit;
  activeAudit = audit;
  const { publicTenantRouting } = mcp.mcpRoutingOptions(options, controlPlane);
  const resolveEndpointOptions = (org: string) =>
    mcp.endpointUrlOptionsForOrg(options, controlPlane, org);
  const withIntentMode = createIntentTargetResolver(intentSettings, intentPreviewOrgs);
  const router = createMcpRouter(async (id) => withIntentMode(await registry.getServing(id)), {
    logger,
    tls,
    protocolMode: options.mcpProtocolMode ?? 'dual',
    ...(options.mcpRequestState === undefined ? {} : { requestState: options.mcpRequestState }),
    ...(options.mcpConfirmationNonceLedger === undefined
      ? {}
      : { confirmationNonceLedger: options.mcpConfirmationNonceLedger }),
    resolveInvocationContext: createMcpInvocationContextResolver(options.clock),
    ...servicePrincipalDataPlaneHooks(moduleHost.toolDispatch, activeAudit, logger),
    ...(options.oauthClientCredentialsReady ? { oauthClientCredentialsReady: true } : {}),
    ...(options.captureRequestEvent !== undefined
      ? { captureRequestEvent: options.captureRequestEvent }
      : {}),
    ...(options.captureIntentEvent !== undefined
      ? { captureIntentEvent: options.captureIntentEvent }
      : {}),
    ...(verifyOwnerToken !== undefined ? { verifyOwnerToken } : {}),
    // Without a hosted identity contribution, self-host keeps the pre-existing claim-based domain check.
    authorizeDataPlaneIdentity:
      moduleHost.dataPlaneAuthorizer ??
      createDataPlaneMembershipAuthorizer({
        controlPlane,
        audit,
        logger,
        ...(moduleHost.platformHumanIdentity?.principalResolver !== undefined
          ? { verifiedEmails: moduleHost.platformHumanIdentity.principalResolver }
          : {}),
      }),
    admissionGate: moduleHost.admissionGate,
    ...(publicTenantRouting !== undefined ? { publicTenantRouting } : {}),
    tenantLookup: async (ref: TenantRouteRef) =>
      withIntentMode(
        ref.serverVersion === undefined
          ? await registry.getActiveByTenant(ref)
          : await registry.getActiveByTenantVersion(ref, ref.serverVersion),
        ref,
      ),
    tenantPreflight: createArchivePreflight(registry),
  });
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const knowledgeRouteDeps = wireServiceKnowledge(
    registry,
    options.knowledge,
    configStore,
    maxBody,
  );
  const maxDeployBody = options.maxDeployBodyBytes ?? DEFAULT_MAX_DEPLOY_BODY;
  const gate = options.deployGate ?? allowAllGate();
  const dispatchObservability = createObservabilityDispatcher({
    gate,
    controlPlane,
    requestEvents,
    intentEvents,
    intentSettings,
    previewOrgs: intentPreviewOrgs,
    audit,
    maxBody,
    tls,
    options,
  });
  const servicePrincipalDispatcher = createServicePrincipalDispatcher(
    registry,
    options.servicePrincipalRuntime,
    { gate, controlPlane, audit: activeAudit, maxBody, logger, tls },
  );
  // App archive retention sweeper (ADR 0117 §3): one boot-time sweep at handler construction plus
  // a throttled piggyback on the deploy/deployments control-plane paths. Never a scheduler.
  const archiveRetentionDays =
    options.archiveRetentionDays ?? resolveArchiveRetentionDays(process.env);
  const archiveSweeper = new ArchiveSweeper({
    registry,
    configStore,
    audit,
    retentionDays: archiveRetentionDays,
    logger,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  archiveSweeper.maybeSweep();
  const moduleRouteDeps = {
    routes: moduleHost.routes,
    logger,
    gate,
    controlPlane,
    registry,
    audit,
    options,
    tls,
    ...(options.developerGrantStore === undefined
      ? {}
      : { developerGrants: options.developerGrantStore }),
  };
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Liveness/readiness probes: un-gated and **not** HTTPS-enforced — Cloud Run's internal probe is plain
    // HTTP, so enforcing HTTPS here would `426` the probe and the revision would never go healthy (ADR 0034).
    // `/healthz` is a pure liveness 200 (no store touch); `/readyz` reflects the injected readiness probe.
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
      applySecurityHeaders(res, tls);
      if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
      void Promise.resolve(moduleHost.ready())
        .then((ready) => sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'unready' }))
        .catch(() => sendJson(res, 503, { status: 'unready' }));
      return;
    }
    if (options.developerMcp === true && url.pathname === DEVELOPER_MCP_PATH) {
      const mount = createDeveloperMcpMountOptions({
        registry,
        controlPlane,
        audit,
        logger,
        tls,
        maxBody,
        options,
      });
      void handleDeveloperMcpRequest(req, res, mount).catch((error: unknown) =>
        respondRouteError(logger, res, 'developer.mcp.failed', error),
      );
      return;
    }

    // Deployed-version visibility (ADR 0080): un-gated, non-HTTPS-enforced like the probes so the
    // post-deploy smoke can confirm exactly which commit is live. Non-sensitive fields only.
    if (req.method === 'GET' && url.pathname === '/v1/service/info') {
      applySecurityHeaders(res, tls);
      return sendJson(res, 200, serviceInfoPayload(buildInfo, options.developerMcp === true));
    }

    if (url.pathname.startsWith('/v1/') && rejectIncompatibleCli(req, res, buildInfo, tls)) return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = registry.getLocalAsset(url.pathname);
      if (asset !== undefined) {
        applySecurityHeaders(res, tls);
        serveLocalAsset(req, res, asset);
        return;
      }
    }
    if (providerOptions.assetStore?.handleRequest !== undefined) {
      const handled = providerOptions.assetStore.handleRequest(req, res, url.pathname);
      if (handled) return;
    }
    if (req.method === 'GET' && url.pathname === OPENAI_APPS_CHALLENGE_PATH) {
      handlePublicOpenAIAppsChallenge(req, res, options, tls, controlPlane);
      return;
    }
    // Protected-resource metadata (RFC 9728 / MCP authorization) for tenant MCP resources.
    if (dispatchProtectedResourceMetadata(req, res, url, registry, controlPlane, options, tls)) {
      return;
    }
    // Authorization server (OA-2): delegate the AS paths to the Express sub-app. Same HTTPS posture +
    // security headers as the rest of the control plane; the sub-app owns content negotiation and its own
    // CORS/rate-limit/body parsing. Delegated before the body is read so the SDK handlers can stream it.
    if (options.authServerApp !== undefined && isAuthServerPath(url.pathname)) {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      options.authServerApp(req, res);
      return;
    }
    if (dispatchAuthDiscoveryRoute(req, res, url, options, tls)) return;
    if (url.pathname === '/v1/service/capabilities' && req.method === 'GET') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      const advanced = url.searchParams.get('advanced') === '1';
      return sendJson(res, 200, {
        ok: true,
        capabilities: capabilityReport.capabilities,
        ...(advanced ? { modules: capabilityReport.modules } : {}),
      });
    }
    const appPurgeReconciliationAction: AppPurgeReconciliationAction | undefined =
      url.pathname === '/v1/service/app-purge-reconciliation/preview'
        ? 'preview'
        : url.pathname === '/v1/service/app-purge-reconciliation/apply'
          ? 'apply'
          : undefined;
    if (req.method === 'POST' && appPurgeReconciliationAction !== undefined) {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      void handleAppPurgeReconciliationRoute(
        req,
        res,
        {
          gate,
          ...(options.appPurgeReconciliationOperator === undefined
            ? {}
            : { operator: options.appPurgeReconciliationOperator }),
          releaseSha: buildInfo.gitSha,
          maxBody,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        },
        appPurgeReconciliationAction,
      );
      return;
    }
    if (servicePrincipalDispatcher?.(req, res, url)) return;
    if (
      businessInformationStore !== undefined &&
      options.businessInformationEnabled !== false &&
      dispatchBusinessInformationRoutes(req, res, url, {
        store: businessInformationStore,
        gate,
        controlPlane,
        maxBody,
        publicCounters,
        trustProxy: tls.trustProxy === true,
        ...(options.clock === undefined ? {} : { now: options.clock }),
        logger,
        tls,
        applySecurityHeaders,
        enforceHttps,
      })
    ) {
      return;
    }
    if (
      dispatchAssistantRoutes(req, res, url, {
        registry,
        store: assistantStore,
        appearance: assistantAppearance,
        ...(options.publicEmbeds !== undefined ? { publicEmbeds: options.publicEmbeds } : {}),
        ...(options.elevations !== undefined ? { elevations: options.elevations } : {}),
        ...(options.elevationCoordinator !== undefined
          ? { elevationCoordinator: options.elevationCoordinator }
          : {}),
        ...(options.admissionCounters !== undefined
          ? { admissionCounters: options.admissionCounters }
          : {}),
        ...(options.admissionEnvelope !== undefined
          ? { admissionEnvelope: options.admissionEnvelope }
          : {}),
        gate,
        controlPlane,
        audit: activeAudit,
        maxBody,
        serviceBase: (request) => options.publicBaseUrl ?? baseFromRequest(request, tls),
        ...(options.assistantModelFetch !== undefined
          ? { modelFetch: options.assistantModelFetch }
          : {}),
        ...(options.managedAssistantModelResolver !== undefined
          ? { managedModelResolver: options.managedAssistantModelResolver }
          : {}),
        ...(options.captureRequestEvent !== undefined
          ? { captureRequestEvent: options.captureRequestEvent }
          : {}),
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
        logger,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls,
      })
    ) {
      return;
    }
    if (
      dispatchDeployRoutes(req, res, url, {
        registry,
        options: providerOptions,
        maxBody: { deploy: maxDeployBody, control: maxBody },
        gate,
        controlPlane,
        audit,
        archiveSweeper,
        logger,
        tls,
      })
    ) {
      return;
    }
    if (
      dispatchCredentialAuthRoutes(req, res, url, {
        registry,
        serviceBase: options.publicBaseUrl ?? baseFromRequest(req, tls),
        resolveEndpointOptions,
        googleWorkloadIdentity: options.googleWorkloadIdentity,
        gate,
        controlPlane,
        audit: activeAudit,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls,
      })
    ) {
      return;
    }
    const assetPreflightRef = parseTenantAssetPreflightPath(url.pathname);
    if (req.method === 'POST' && assetPreflightRef !== undefined) {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleAssetPreflight(
        req,
        res,
        providerOptions,
        maxBody,
        assetPreflightRef,
        gate,
        controlPlane,
        audit,
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    if (url.pathname === '/v1/whoami' && req.method === 'GET') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      const scopes = url.searchParams.getAll('scope');
      if (scopes.length > 1 || (scopes.length === 1 && scopes[0] !== 'identity')) {
        sendJson(res, 400, { error: 'invalid whoami scope' });
        return;
      }
      handleWhoami(
        req,
        res,
        gate,
        controlPlane,
        options,
        scopes[0] === 'identity' ? 'identity' : undefined,
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    // Org-admin route families are disjoint from the resource reads below.
    if (
      dispatchOrgAdminRoutes(req, res, url, {
        gate,
        controlPlane,
        audit,
        maxBody,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls,
        publicMcpBaseDomain: options.mcpPublicRouting?.publicBaseDomain,
        invitationEmailSender: options.invitationEmailSender,
        invitationConsoleBaseUrl: options.invitationConsoleBaseUrl,
      })
    ) {
      return;
    }
    // ADR 0128 read surface (apps/envs/deployment-item GETs) lives in routes/resource-read-dispatch.ts;
    // env paths there can never shadow the action-suffixed `/envs/{env}/<action>` tenant routes below.
    if (
      dispatchResourceReads(req, res, url, {
        registry,
        gate,
        controlPlane,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls,
        resolveEndpointBase: (request) => options.publicBaseUrl ?? baseFromRequest(request, tls),
        resolveEndpointOptions,
        developerGrantStore: options.developerGrantStore,
        logger,
      })
    ) {
      return;
    }
    if (
      dispatchEnvironmentMutations(req, res, url, {
        registry,
        gate,
        controlPlane,
        audit,
        maxBody,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls,
      })
    )
      return;
    if (
      dispatchConfigValueRequest(req, res, url, {
        gate,
        controlPlane,
        configStore,
        registry,
        maxBody,
        audit,
        ...(options.developerGrantStore !== undefined
          ? { developerGrants: options.developerGrantStore }
          : {}),
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls,
      })
    )
      return;
    if (
      dispatchKnowledgeRequest(req, res, url, {
        authorize: (request, response, org) =>
          authorizeTenantControl(request, response, gate, controlPlane, org),
        routeDeps: knowledgeRouteDeps,
        applySecurityHeaders: (response) => applySecurityHeaders(response, tls),
        enforceHttps: (request, response) => enforceHttps(request, response, tls),
      })
    )
      return;
    const statusRef = parseTenantStatusPath(url.pathname);
    if (statusRef !== undefined && req.method === 'GET') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleDeploymentStatus(req, res, registry, gate, controlPlane, statusRef, options, url).catch(
        () => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        },
      );
      return;
    }
    const inspectRef = parseTenantInspectPath(url.pathname);
    if (inspectRef !== undefined && req.method === 'GET') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleInspect(req, res, registry, gate, controlPlane, inspectRef, options).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    const smokeRef = parseTenantSmokePath(url.pathname);
    if (smokeRef !== undefined && req.method === 'POST') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleHostedSmoke(req, res, registry, gate, controlPlane, smokeRef, options).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    const accessRef = parseTenantAccessPath(url.pathname);
    if (accessRef !== undefined && req.method === 'PATCH') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleAccessUpdate(req, res, registry, gate, controlPlane, audit, maxBody, accessRef).catch(
        () => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        },
      );
      return;
    }
    const rollbackRef = parseTenantRollbackPath(url.pathname);
    if (rollbackRef !== undefined && req.method === 'POST') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleRollback(
        req,
        res,
        registry,
        gate,
        controlPlane,
        audit,
        maxBody,
        rollbackRef,
        options,
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    const deploymentsRef = parseDeploymentsPath(url.pathname);
    if (deploymentsRef !== undefined && req.method === 'GET') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      archiveSweeper.maybeSweep();
      handleDeployments(
        req,
        res,
        registry,
        gate,
        controlPlane,
        deploymentsRef,
        url,
        options.publicBaseUrl ?? baseFromRequest(req, tls),
        resolveEndpointOptions,
        options.developerGrantStore,
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    const archiveRef = parseAppArchivePath(url.pathname);
    if (archiveRef !== undefined && req.method === 'POST') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleAppArchive(req, res, registry, gate, controlPlane, audit, archiveRef, options).catch(
        () => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        },
      );
      return;
    }
    const restoreRef = parseAppRestorePath(url.pathname);
    if (restoreRef !== undefined && req.method === 'POST') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      handleAppRestore(
        req,
        res,
        registry,
        gate,
        controlPlane,
        audit,
        restoreRef,
        options,
        archiveRetentionDays,
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    const auditEventsRef = parseAuditEventsPath(url.pathname);
    if (auditEventsRef !== undefined && req.method === 'GET') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      if (!capabilityReport.capabilities.includes('audit')) {
        return sendJson(res, 409, {
          ok: false,
          error: 'audit events require the audit capability',
        });
      }
      handleAuditEvents(
        req,
        res,
        gate,
        controlPlane,
        audit,
        auditEventsRef,
        url,
        options.developerGrantStore,
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    const logsRef = parseTenantLogsPath(url.pathname);
    if (logsRef !== undefined && req.method === 'GET') {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      if (options.userAppLogStore === undefined) {
        return sendJson(res, 409, { ok: false, error: 'logs require a configured log store' });
      }
      handleUserAppLogs(
        req,
        res,
        gate,
        controlPlane,
        options.userAppLogStore,
        logsRef,
        url,
        options.developerGrantStore,
      ).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    if (dispatchObservability(req, res, url)) return;
    // Analytics alerting (E2, ADR 0130): alert-rule CRUD + manual test-fire. The evaluator loop
    // lives in serve.ts; routes live in routes/alerts-dispatch.ts.
    if (
      dispatchAlertRoutes(req, res, url, {
        gate,
        controlPlane,
        alertRuleStore,
        audit,
        maxBody,
        allowLoopbackWebhooks: options.alertWebhookAllowLoopback === true,
        applySecurityHeaders,
        enforceHttps,
        sendJson,
        tls,
        ...(options.clock !== undefined ? { clock: options.clock } : {}),
      })
    ) {
      return;
    }
    if (dispatchModuleRoutes(req, res, url, moduleRouteDeps)) return;
    if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      applySecurityHeaders(res, tls);
      if (enforceHttps(req, res, tls)) return;
      if (options.consoleHandler !== undefined) {
        options.consoleHandler(req, res);
        return;
      }
      return sendJson(res, 404, { error: 'console not configured' });
    }
    router(req, res);
  };
}
