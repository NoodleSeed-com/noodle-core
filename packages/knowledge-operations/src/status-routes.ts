/**
 * Operator surface (ADR 0202 as amended): `knowledge list`, `knowledge status <name>`, and the
 * on-demand `knowledge refresh <name>` crawl. Responses say "versioned documents" versus "live site"
 * lifecycle truth — active revision, declaring deployment, provisioning state — and never
 * contents, credentials, or raw provider payloads.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CompiledKnowledgeComponent,
  KnowledgeRevisionStore,
} from '@noodle-borg/knowledge/portable';
import type {
  KnowledgeBudgetState,
  KnowledgeComponentSummary,
  KnowledgeCrawlState,
  KnowledgeListResponse,
  KnowledgeStatusResponse,
} from '@noodle-borg/wire-contracts';
import { sendJson } from './http.js';
import { type KnowledgeTenantRef, knowledgeEnableCommand } from './routes.js';

export interface KnowledgeStatusDeps {
  readonly revisionStore: KnowledgeRevisionStore;
  readonly knowledgeEnabled: (tenant: KnowledgeTenantRef) => Promise<boolean>;
  /** The active deployment's compiled knowledge components, or undefined when none is active. */
  readonly activeKnowledge: (tenant: KnowledgeTenantRef) => Promise<
    | {
        readonly components: readonly CompiledKnowledgeComponent[];
        readonly deploymentId: string;
      }
    | undefined
  >;
  /** Managed site datastore readiness; absent until the Google slice binds a checker. */
  readonly siteProvisioningState?: (tenant: KnowledgeTenantRef) => Promise<'ready' | 'missing'>;
  /** Current month's crawl-budget state (the amendment's honest operator-visible counters). */
  readonly budget?: (tenant: KnowledgeTenantRef) => Promise<KnowledgeBudgetState | undefined>;
  /** Per-component crawl state for the crawl-and-index site tier. */
  readonly crawlState?: (
    tenant: KnowledgeTenantRef,
    componentName: string,
  ) => Promise<KnowledgeCrawlState | undefined>;
  /** On-demand crawl (the `noodle knowledge refresh` verb). */
  readonly refresh?: (
    tenant: KnowledgeTenantRef,
    component: CompiledKnowledgeComponent,
  ) => Promise<KnowledgeCrawlState>;
}

function gateClosed(res: ServerResponse, tenant: KnowledgeTenantRef): void {
  sendJson(res, 403, {
    code: 'knowledge_not_enabled',
    error: 'knowledge is not enabled for this org/app/env',
    fix: knowledgeEnableCommand(tenant),
  });
}

async function componentSummary(
  tenant: KnowledgeTenantRef,
  component: CompiledKnowledgeComponent,
  deploymentId: string,
  revisionStore: KnowledgeRevisionStore,
): Promise<KnowledgeComponentSummary> {
  const scope = { org: tenant.org, app: tenant.app, env: tenant.env };
  const active =
    component.documents.length > 0 ? await revisionStore.active(scope, component.name) : undefined;
  const state = component.documents.length > 0 && active === undefined ? 'pending' : 'active';
  return {
    name: component.name,
    sources: { documents: component.documents.length, sites: component.sites.length },
    declaringScope: 'env',
    ...(active !== undefined ? { activeRevisionId: active.revisionId } : {}),
    activeDeploymentId: deploymentId,
    state,
  };
}

/** `GET /v1/orgs/{o}/apps/{a}/envs/{e}/knowledge` */
export async function handleKnowledgeList(
  _req: IncomingMessage,
  res: ServerResponse,
  tenant: KnowledgeTenantRef,
  deps: KnowledgeStatusDeps,
): Promise<void> {
  if (!(await deps.knowledgeEnabled(tenant))) return gateClosed(res, tenant);
  const active = await deps.activeKnowledge(tenant);
  const components: KnowledgeComponentSummary[] = [];
  for (const component of active?.components ?? []) {
    components.push(
      await componentSummary(tenant, component, active?.deploymentId ?? '', deps.revisionStore),
    );
  }
  const response: KnowledgeListResponse = {
    ok: true,
    scope: { org: tenant.org, app: tenant.app, env: tenant.env },
    components,
  };
  return sendJson(res, 200, response);
}

/** `GET /v1/orgs/{o}/apps/{a}/envs/{e}/knowledge/{name}/status` */
export async function handleKnowledgeStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  tenant: KnowledgeTenantRef,
  componentName: string,
  deps: KnowledgeStatusDeps,
): Promise<void> {
  if (!(await deps.knowledgeEnabled(tenant))) return gateClosed(res, tenant);
  const active = await deps.activeKnowledge(tenant);
  const component = active?.components.find((candidate) => candidate.name === componentName);
  if (active === undefined || component === undefined) {
    return sendJson(res, 404, {
      code: 'knowledge_component_not_found',
      error: `no active deployment declares knowledge component "${componentName}"`,
      fix: 'noodle knowledge list',
    });
  }
  const siteProvisioning =
    component.sites.length === 0
      ? ('not-required' as const)
      : ((await deps.siteProvisioningState?.(tenant)) ?? ('missing' as const));
  const budget = await deps.budget?.(tenant);
  const crawl =
    component.sites.length === 0 ? undefined : await deps.crawlState?.(tenant, componentName);
  const response: KnowledgeStatusResponse = {
    ok: true,
    scope: { org: tenant.org, app: tenant.app, env: tenant.env },
    component: await componentSummary(tenant, component, active.deploymentId, deps.revisionStore),
    siteProvisioning,
    ...(budget === undefined ? {} : { budget }),
    ...(crawl === undefined ? {} : { crawl }),
    errors: [],
  };
  return sendJson(res, 200, response);
}

/**
 * `POST /v1/orgs/{o}/apps/{a}/envs/{e}/knowledge/{name}/refresh` — crawl the component now.
 * The outcome (including failures) is the returned crawl state, never a thrown error.
 */
export async function handleKnowledgeRefresh(
  _req: IncomingMessage,
  res: ServerResponse,
  tenant: KnowledgeTenantRef,
  componentName: string,
  deps: KnowledgeStatusDeps,
): Promise<void> {
  if (!(await deps.knowledgeEnabled(tenant))) return gateClosed(res, tenant);
  const active = await deps.activeKnowledge(tenant);
  const component = active?.components.find((candidate) => candidate.name === componentName);
  if (component === undefined || deps.refresh === undefined) {
    return sendJson(res, 404, {
      code: 'knowledge_component_not_found',
      error: `no active deployment declares knowledge component "${componentName}"`,
      fix: 'noodle knowledge list',
    });
  }
  if (component.sites.length === 0) {
    return sendJson(res, 400, {
      code: 'knowledge_no_sites',
      error: `component "${componentName}" declares no site() sources to crawl`,
      fix: `noodle knowledge status ${componentName}`,
    });
  }
  const crawl = await deps.refresh(tenant, component);
  return sendJson(res, 200, { ok: true, crawl });
}
