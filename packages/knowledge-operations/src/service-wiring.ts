/**
 * Composition helpers the service calls from its (size-pinned) bootstrap files, so the thin
 * dispatch stays thin: store construction, schema setup, and route-deps assembly live here.
 */
import {
  AlgoliaKnowledgeIndex,
  type CompiledKnowledgeComponent,
  type DocumentTextCodec,
  InMemoryKnowledgeRevisionStore,
  InMemorySearchBudgetStore,
  KnowledgeError,
  type KnowledgeIndex,
  type KnowledgeRevisionStore,
  type KnowledgeScope,
  MeilisearchKnowledgeIndex,
  type SearchBudgetCeilings,
  type SearchBudgetStore,
} from '@noodle-borg/knowledge/portable';
import type { SiteFetcher } from '@noodle-borg/knowledge-crawl';
import {
  FirecrawlSiteFetcher,
  FirstPartySiteFetcher,
  TavilySiteFetcher,
} from '@noodle-borg/knowledge-crawl';
import {
  type CrawlableComponent,
  type CrawlDeps,
  type CrawlStateStore,
  InMemoryCrawlStateStore,
  runComponentCrawl,
  runDueCrawls,
} from './crawl-lifecycle.js';
import { createKnowledgeSearchExecutor, type KnowledgeSearchExecutor } from './executor.js';
import {
  createKnowledgeDeployHooks,
  type KnowledgeDeployHooks,
  KnowledgePublicationError,
} from './publication.js';
import type { KnowledgeRouteDeps, KnowledgeTenantRef } from './routes.js';
import { type KnowledgeSearchPortFactory, knowledgeSearchPortFactory } from './search-port.js';
import { InMemoryKnowledgeStagingStore, type KnowledgeStagingStore } from './staging-store.js';
import type { KnowledgeStatusDeps } from './status-routes.js';

export interface KnowledgeServiceStores {
  readonly staging: KnowledgeStagingStore;
  readonly revisionStore: KnowledgeRevisionStore;
  readonly codec?: DocumentTextCodec;
  /** Org-pooled monthly crawl-page spend control (per-app sub-caps). */
  readonly budgetStore?: SearchBudgetStore;
  /** Per-component crawl state (status, last completed, next refresh); in-memory by default. */
  readonly crawlState?: CrawlStateStore;
  /**
   * Composition seams for tests and BYO providers: fetcher selection defaults to the managed
   * first-party crawler; the deploy gate defaults to always-provisioned (the managed crawler
   * needs no provisioning — BYO configuration checks bind here).
   */
  readonly fetcherFor?: (tenant: KnowledgeTenantRef, component: CrawlableComponent) => SiteFetcher;
  /** BYO index selection override; defaults to declaration-driven provider adapters. */
  readonly indexFor?: (
    scope: KnowledgeScope,
    componentName: string,
    declaration: CompiledKnowledgeComponent['index'] | undefined,
  ) => Promise<KnowledgeIndex | undefined>;
  readonly siteProvisioned?: (tenant: KnowledgeTenantRef) => Promise<boolean>;
}

/** In-memory stores with the identity codec — the no-persistence service default. */
export function defaultKnowledgeStores(): KnowledgeServiceStores {
  return {
    staging: new InMemoryKnowledgeStagingStore(),
    revisionStore: new InMemoryKnowledgeRevisionStore(),
    budgetStore: new InMemorySearchBudgetStore(),
    crawlState: new InMemoryCrawlStateStore(),
  };
}

/** Budget ceilings from managed config with the ratified v0 defaults (2000 org / 1000 app). */
export function budgetCeilingsResolver(
  resolveVariables: (tenant: KnowledgeTenantRef) => Promise<Record<string, string>>,
): (tenant: KnowledgeTenantRef) => Promise<SearchBudgetCeilings> {
  return async (tenant) => {
    const variables = await resolveVariables(tenant);
    // Crawl-page budget (ADR 0202 amendment 2026-08-18): search on the owned index is free;
    // crawled pages per month are the metered line. `0` blocks (kill-switch semantic).
    const org = Number(variables.NOODLE_KNOWLEDGE_CRAWL_BUDGET_ORG_MONTHLY ?? '20000');
    const app = Number(variables.NOODLE_KNOWLEDGE_CRAWL_BUDGET_APP_MONTHLY ?? '10000');
    return {
      org: Number.isFinite(org) ? Math.max(0, Math.floor(org)) : 20000,
      app: Number.isFinite(app) ? Math.max(0, Math.floor(app)) : 10000,
    };
  };
}

/** Assemble route deps over the service's managed-config resolver (`NOODLE_KNOWLEDGE_ENABLED`). */
export function buildKnowledgeRouteDeps(
  stores: KnowledgeServiceStores,
  resolveVariables: (tenant: KnowledgeTenantRef) => Promise<Record<string, string>>,
  maxBodyBytes: number,
): KnowledgeRouteDeps {
  return {
    staging: stores.staging,
    knowledgeEnabled: async (tenant) =>
      (await resolveVariables(tenant)).NOODLE_KNOWLEDGE_ENABLED === 'true',
    maxBodyBytes,
    ...(stores.codec === undefined ? {} : { codec: stores.codec }),
  };
}

/** Map a compiled index declaration plus resolved config values onto its provider adapter. */
export function knowledgeIndexFromDeclaration(
  declaration: NonNullable<CompiledKnowledgeComponent['index']>,
  config: Readonly<Record<string, string>>,
  scope: KnowledgeScope,
): KnowledgeIndex {
  return declaration.provider === 'algolia'
    ? new AlgoliaKnowledgeIndex({
        appId: config.appId ?? '',
        apiKey: config.apiKey ?? '',
        scope,
      })
    : new MeilisearchKnowledgeIndex({
        host: config.host ?? '',
        apiKey: config.apiKey ?? '',
        scope,
      });
}

/**
 * One-call composition for the service: resolve stores, build route deps, and register the
 * deploy-coupled publication hooks on the registry (structurally typed; no service import).
 */
export function wireKnowledge(
  registry: {
    setKnowledgeDeployHooks(hooks: KnowledgeDeployHooks, search?: KnowledgeSearchPortFactory): void;
    getActiveByTenant(ref: {
      org: string;
      app: string;
      env: string;
    }): Promise<
      | { readonly served: { readonly artifact: { readonly server: ActiveServerKnowledge } } }
      | undefined
    >;
  },
  stores: KnowledgeServiceStores | undefined,
  resolveVariables: (tenant: KnowledgeTenantRef) => Promise<Record<string, string>>,
  maxBodyBytes: number,
  resolveSecrets: (
    tenant: KnowledgeTenantRef,
  ) => Promise<Record<string, string>> = async () => ({}),
): KnowledgeRouteDeps & {
  readonly executor: KnowledgeSearchExecutor;
  readonly refreshComponent: (
    tenant: KnowledgeTenantRef,
    component: CrawlableComponent,
  ) => Promise<import('./crawl-lifecycle.js').SiteCrawlState>;
  readonly crawlState: CrawlStateStore;
} {
  const resolved = stores ?? defaultKnowledgeStores();
  const deps = buildKnowledgeRouteDeps(resolved, resolveVariables, maxBodyBytes);
  const ceilings = budgetCeilingsResolver(resolveVariables);
  // The managed first-party crawler needs no provisioning, so the deploy gate defaults open;
  // BYO provider configuration checks replace this seam when a component declares a provider.
  const siteProvisioned = resolved.siteProvisioned ?? (async () => true);
  // BYO crawler binding: a declared provider resolves its config NAMES to managed values at
  // crawl time; an unset reference fails the crawl closed with the exact fix command visible in
  // the crawl state. Omitted declaration means the managed first-party crawler.
  const resolveRef = async (
    tenant: KnowledgeTenantRef,
    ref: { readonly kind: 'variable' | 'secret'; readonly name: string },
  ): Promise<string> => {
    const values =
      ref.kind === 'secret' ? await resolveSecrets(tenant) : await resolveVariables(tenant);
    const value = values[ref.name];
    if (value === undefined || value === '') {
      const command = ref.kind === 'secret' ? 'secrets' : 'variables';
      throw new KnowledgeError(
        'request',
        `knowledge provider config ${ref.name} is not set; run: noodle ${command} set ${ref.name} --runtime cloud --scope env --org ${tenant.org} --app ${tenant.app} --env ${tenant.env}`,
      );
    }
    return value;
  };
  // BYO index binding: a declared index resolves its config NAMES the same way. On the deploy
  // path (declaration in hand) an unset reference becomes a structured publication failure; on
  // the serving/lookup path the active artifact supplies the declaration for the component (or
  // the owner of a `<name>#site` corpus). Omitted declaration means the managed bundled index.
  const defaultIndexFor = async (
    scope: KnowledgeScope,
    componentName: string,
    declaration: CompiledKnowledgeComponent['index'] | undefined,
  ): Promise<KnowledgeIndex | undefined> => {
    const tenant = { org: scope.org, app: scope.app, env: scope.env };
    let resolvedDeclaration = declaration;
    if (resolvedDeclaration === undefined) {
      const base = componentName.endsWith('#site')
        ? componentName.slice(0, -'#site'.length)
        : componentName;
      const target = await registry.getActiveByTenant(tenant);
      resolvedDeclaration = target?.served.artifact.server.knowledge?.find(
        (candidate) => candidate.name === base,
      )?.index;
    }
    if (resolvedDeclaration === undefined) return undefined;
    const config: Record<string, string> = {};
    for (const [key, ref] of Object.entries(resolvedDeclaration.config)) {
      try {
        config[key] = await resolveRef(tenant, ref);
      } catch (error) {
        if (
          declaration !== undefined &&
          error instanceof KnowledgeError &&
          error.layer === 'request'
        ) {
          throw new KnowledgePublicationError([
            {
              code: 'knowledge_index_config_missing',
              path: `knowledge.${componentName}`,
              message: error.message,
            },
          ]);
        }
        throw error;
      }
    }
    return knowledgeIndexFromDeclaration(resolvedDeclaration, config, scope);
  };
  const hooks = createKnowledgeDeployHooks(resolved, {
    knowledgeEnabled: deps.knowledgeEnabled,
    siteProvisioned,
    indexFor: resolved.indexFor ?? defaultIndexFor,
  });
  const crawlState = resolved.crawlState ?? new InMemoryCrawlStateStore();
  const defaultFetcherFor = (
    tenant: KnowledgeTenantRef,
    component: CrawlableComponent,
  ): SiteFetcher => {
    const crawler = component.crawler;
    if (crawler === undefined) return new FirstPartySiteFetcher();
    return {
      fetchSite: async (request) => {
        const apiKey = await resolveRef(tenant, crawler.config.apiKey);
        const fetcher =
          crawler.provider === 'firecrawl'
            ? new FirecrawlSiteFetcher({ apiKey })
            : new TavilySiteFetcher({ apiKey });
        return fetcher.fetchSite(request);
      },
    };
  };
  const crawlDeps: CrawlDeps = {
    hooks,
    crawlState,
    fetcherFor: resolved.fetcherFor ?? defaultFetcherFor,
    ...(resolved.budgetStore === undefined
      ? {}
      : { budget: { store: resolved.budgetStore, ceilings } }),
  };
  const bareExecutor = createKnowledgeSearchExecutor({
    hooks,
    knowledgeEnabled: deps.knowledgeEnabled,
  });
  // Refresh-on-traffic: serving a sites component also checks whether its refresh is due and
  // kicks the crawl in the background — the visitor's answer never waits on it.
  const executor: KnowledgeSearchExecutor = {
    enabled: bareExecutor.enabled,
    search: async (tenant, component, request) => {
      const hits = await bareExecutor.search(tenant, component, request);
      if (component.sites.length > 0) {
        void runDueCrawls(crawlDeps, async () => [{ tenant, component }], Date.now()).catch(
          () => undefined,
        );
      }
      return hits;
    },
  };
  // Crawl-on-deploy: after a publication activates, kick the first (or refreshed) crawl for
  // every sites-declaring component — freshness needs no traffic. Fire-and-forget: the deploy
  // must not wait on a crawl, and the outcome lands in the crawl state.
  const crawlingHooks: KnowledgeDeployHooks = {
    ...hooks,
    activate: async (plan, deploymentId) => {
      await hooks.activate(plan, deploymentId);
      for (const planned of plan.components) {
        if (planned.component.sites.length === 0) continue;
        const tenant = {
          org: planned.scope.org,
          app: planned.scope.app,
          env: planned.scope.env,
        };
        void runComponentCrawl(crawlDeps, tenant, planned.component).catch(() => undefined);
      }
    },
  };
  registry.setKnowledgeDeployHooks(crawlingHooks, knowledgeSearchPortFactory(executor));
  const status: KnowledgeStatusDeps = {
    revisionStore: resolved.revisionStore,
    knowledgeEnabled: deps.knowledgeEnabled,
    crawlState: (tenant, componentName) => crawlState.get(tenant, componentName),
    refresh: (tenant, component) => runComponentCrawl(crawlDeps, tenant, component),
    // Mirrors the fail-closed deploy gate above: without the managed project every site() is
    // 'missing', so the operator sees why a site deploy refuses instead of a silent absence.
    siteProvisioningState: async (tenant) =>
      (await siteProvisioned(tenant)) ? ('ready' as const) : ('missing' as const),
    ...(resolved.budgetStore === undefined
      ? {}
      : {
          budget: async (tenant) => {
            const bounds = await ceilings(tenant);
            const state = await resolved.budgetStore?.peek(
              { org: tenant.org, app: tenant.app },
              bounds,
            );
            if (state === undefined) return undefined;
            return {
              year: state.year,
              month: state.month,
              orgConsumed: state.orgConsumed,
              appConsumed: state.appConsumed,
              orgCeiling: state.orgCeiling,
              appCeiling: state.appCeiling,
              blocked:
                state.orgCeiling <= 0 ||
                state.appCeiling <= 0 ||
                state.orgConsumed >= state.orgCeiling ||
                state.appConsumed >= state.appCeiling,
            };
          },
        }),
    activeKnowledge: async (tenant) => {
      const target = await registry.getActiveByTenant(tenant);
      const server = target?.served.artifact.server;
      const components = server?.knowledge;
      if (components === undefined || components.length === 0) return undefined;
      return { components, deploymentId: server?.deploymentId ?? '' };
    },
  };
  return {
    ...deps,
    status,
    executor,
    // On-demand crawl for the operator surface (`noodle knowledge refresh`, PR 6 route).
    refreshComponent: (tenant: KnowledgeTenantRef, component: CrawlableComponent) =>
      runComponentCrawl(crawlDeps, tenant, component),
    crawlState,
  };
}

interface ActiveServerKnowledge {
  readonly knowledge?: readonly CompiledKnowledgeComponent[] | undefined;
  readonly deploymentId?: string | undefined;
}
