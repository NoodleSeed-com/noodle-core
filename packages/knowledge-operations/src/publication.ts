/**
 * The deploy-coupled knowledge publication transaction (ADR 0202): lease → resolve bytes or
 * reuse → stage (bundled index + revision + durable sealed text) → verify a positive filtered
 * query → activate + pin, paired with the caller's artifact persistence. Any failure retains
 * the previous artifact + revision pair; retry is idempotent by content hash.
 */
import {
  Bm25KnowledgeIndex,
  type CompiledKnowledgeComponent,
  identityDocumentTextCodec,
  KnowledgeError,
  type KnowledgeIndex,
  type KnowledgeRevision,
  type KnowledgeScope,
  revisionContentHash,
  type SearchHit,
  type SearchRequest,
  type StagedDocument,
} from '@noodle-borg/knowledge/portable';
import { type KnowledgeTenantRef, knowledgeEnableCommand, knowledgeTenantKey } from './routes.js';
import type { KnowledgeServiceStores } from './service-wiring.js';

export interface KnowledgeDeployFailure {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Structured publication failure the registry maps onto its deploy error shape. */
export class KnowledgePublicationError extends Error {
  readonly errors: readonly KnowledgeDeployFailure[];

  constructor(errors: readonly KnowledgeDeployFailure[]) {
    super(errors[0]?.message ?? 'knowledge publication failed');
    this.name = 'KnowledgePublicationError';
    this.errors = errors;
  }
}

interface PlannedComponent {
  readonly component: CompiledKnowledgeComponent;
  readonly scope: KnowledgeScope;
  readonly revisionId: string;
  readonly previousRevisionId?: string;
  readonly lease: { readonly scopeKey: string; readonly leaseId: string };
}

export interface KnowledgePublicationPlan {
  readonly components: readonly PlannedComponent[];
}

export interface KnowledgeDeployHooks {
  publish(
    tenant: KnowledgeTenantRef,
    deploymentId: string,
    components: readonly CompiledKnowledgeComponent[],
  ): Promise<KnowledgePublicationPlan>;
  activate(plan: KnowledgePublicationPlan, deploymentId: string): Promise<void>;
  /** Re-activate the previous revisions after a persistence failure. */
  compensate(plan: KnowledgePublicationPlan, deploymentId: string): Promise<void>;
  /** Release leases; always runs, success or failure. */
  finish(plan: KnowledgePublicationPlan): Promise<void>;
  /** Reselect every revision the deployment pinned; the bundled index rebuilds lazily. */
  rollback(deploymentId: string): Promise<void>;
  /** Search the active document revision, rebuilding the bundled index when stale. */
  searchDocuments(
    scope: KnowledgeScope,
    componentName: string,
    request: SearchRequest,
  ): Promise<readonly SearchHit[]>;
  /**
   * Publish a refresh-lifecycle corpus (the crawled `<name>#site` namespace): stage + durable
   * text + activate, latest-wins, never deployment-pinned — the displaced revision is unpinned
   * so GC can reclaim it. Serialized per corpus by the publication lease.
   */
  publishSiteCorpus(
    scope: KnowledgeScope,
    corpusName: string,
    documents: readonly StagedDocument[],
  ): Promise<void>;
  /** Throttled GC: expired staging entries and unreferenced revisions. */
  sweep(): Promise<void>;
}

/** How long a cached active-revision check may serve before re-reading the durable store. */
const ACTIVE_REVISION_TTL_MS = 5_000;
/** Deploy-piggybacked GC cadence (the archive-sweeper pattern). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export function createKnowledgeDeployHooks(
  stores: KnowledgeServiceStores,
  options: {
    readonly knowledgeEnabled: (tenant: KnowledgeTenantRef) => Promise<boolean>;
    /** Managed site datastore existence; when bound, a site() deploy fails before activation. */
    readonly siteProvisioned?: (tenant: KnowledgeTenantRef) => Promise<boolean>;
    /**
     * BYO index selection (ADR 0202 amendment): resolve a component (or its `<name>#site`
     * corpus) to its declared provider index. The declaration is passed where the caller holds
     * the compiled component (publish/activate); lookup paths pass only the name. Returning
     * undefined selects the managed bundled index.
     */
    readonly indexFor?: (
      scope: KnowledgeScope,
      componentName: string,
      declaration: CompiledKnowledgeComponent['index'] | undefined,
    ) => Promise<KnowledgeIndex | undefined>;
    readonly now?: () => Date;
  },
): KnowledgeDeployHooks {
  const bundled = new Bm25KnowledgeIndex();
  const selectIndex = async (
    scope: KnowledgeScope,
    componentName: string,
    declaration?: CompiledKnowledgeComponent['index'],
  ): Promise<KnowledgeIndex> =>
    (await options.indexFor?.(scope, componentName, declaration)) ?? bundled;
  const codec = stores.codec ?? identityDocumentTextCodec;
  const now = options.now ?? (() => new Date());
  const activeChecks = new Map<string, { revisionId: string | undefined; checkedAt: number }>();
  let lastSweep = 0;

  /** Staged text for a component, from durable revision text or transient staging. */
  async function resolveDocuments(
    tenant: KnowledgeTenantRef,
    component: CompiledKnowledgeComponent,
    existingRevisionId?: string,
  ): Promise<StagedDocument[]> {
    if (existingRevisionId !== undefined) {
      try {
        return [...(await stores.revisionStore.documents(existingRevisionId))];
      } catch {
        // Reused revision without durable text (staged pre-migration or interrupted) — fall
        // back to transient staging below.
      }
    }
    const tenantKey = knowledgeTenantKey(tenant);
    const documents: StagedDocument[] = [];
    for (const descriptor of component.documents) {
      const sealed = await stores.staging.get(tenantKey, descriptor.sha256);
      if (sealed === undefined) {
        throw new KnowledgePublicationError([
          {
            code: 'knowledge_documents_missing',
            path: `knowledge.${component.name}.${descriptor.path}`,
            message:
              `knowledge document ${descriptor.path} has no staged bytes; ` +
              `run noodle deploy again to re-upload (retry is idempotent)`,
          },
        ]);
      }
      documents.push({
        descriptor: {
          path: descriptor.path,
          title: descriptor.title,
          ...(descriptor.sourceUrl !== undefined ? { sourceUrl: descriptor.sourceUrl } : {}),
          sha256: descriptor.sha256,
          bytes: descriptor.bytes,
        },
        text: (await codec.open(sealed)).toString('utf8'),
      });
    }
    return documents;
  }

  /**
   * Make sure the selected index holds and activates the given revision. For the bundled
   * per-instance BM25 this is the restart/peer-activation rebuild; for a BYO remote index the
   * active check usually matches and this is a no-op (stage is content-hash idempotent, so a
   * mismatch self-heals from durable text).
   */
  async function rebuildIndex(
    index: KnowledgeIndex,
    scope: KnowledgeScope,
    componentName: string,
    revisionId: string,
  ): Promise<void> {
    const current = await index.activeRevision(scope, componentName);
    if (current?.revisionId === revisionId) return;
    const documents = await stores.revisionStore.documents(revisionId);
    const staged = await index.stage(scope, componentName, documents);
    if (staged.revisionId !== revisionId) {
      throw new KnowledgeError(
        'store',
        `rebuilt index revision ${staged.revisionId} does not match stored ${revisionId}`,
      );
    }
    await index.activate(revisionId);
  }

  const hooks: KnowledgeDeployHooks = {
    async publish(tenant, deploymentId, components) {
      const withDocuments = components.filter((component) => component.documents.length > 0);
      if (components.length > 0 && !(await options.knowledgeEnabled(tenant))) {
        throw new KnowledgePublicationError([
          {
            code: 'knowledge_not_enabled',
            path: 'knowledge',
            message: `knowledge is not enabled for this org/app/env; run: ${knowledgeEnableCommand(tenant)}`,
          },
        ]);
      }
      const withSites = components.filter((component) => component.sites.length > 0);
      if (withSites.length > 0 && options.siteProvisioned !== undefined) {
        if (!(await options.siteProvisioned(tenant))) {
          throw new KnowledgePublicationError(
            withSites.map((component) => ({
              code: 'knowledge_site_not_provisioned',
              path: `knowledge.${component.name}`,
              message:
                `the site tier is not ready for this tenant; check ` +
                `noodle knowledge status ${component.name} for the crawler configuration state`,
            })),
          );
        }
      }
      const planned: PlannedComponent[] = [];
      try {
        for (const component of withDocuments) {
          const scope: KnowledgeScope = { org: tenant.org, app: tenant.app, env: tenant.env };
          const lease = await stores.revisionStore.acquireLease(
            scope,
            component.name,
            deploymentId,
          );
          // From acquisition to planned.push the lease is held but not yet visible to
          // finish(); release it on any failure or a retry deploy blocks on the leaked lease.
          try {
            // Metadata-inclusive identity: a retitled/moved document is a new revision even
            // with identical bytes — reuse keys on everything a citation shows.
            const contentHash = revisionContentHash(component.documents);
            const previous = await stores.revisionStore.active(scope, component.name);
            const reused = await stores.revisionStore.findByContentHash(
              scope,
              component.name,
              contentHash,
            );
            const documents = await resolveDocuments(tenant, component, reused?.revisionId);
            const index = await selectIndex(scope, component.name, component.index);
            const staged = await index.stage(scope, component.name, documents);
            const revision: KnowledgeRevision = reused ?? staged;
            await stores.revisionStore.stage({
              scope,
              componentName: component.name,
              contentHash,
              revision,
            });
            const verified = await index.verify(staged.revisionId, {
              audience: 'public',
              revision: staged.revisionId,
            });
            if (!verified) {
              throw new KnowledgePublicationError([
                {
                  code: 'knowledge_verification_failed',
                  path: `knowledge.${component.name}`,
                  message: `knowledge component ${component.name} failed its positive filtered verification query`,
                },
              ]);
            }
            await stores.revisionStore.stageDocuments(revision.revisionId, documents);
            planned.push({
              component,
              scope,
              revisionId: revision.revisionId,
              ...(previous !== undefined ? { previousRevisionId: previous.revisionId } : {}),
              lease,
            });
          } catch (error) {
            await stores.revisionStore.releaseLease(lease).catch(() => undefined);
            throw error;
          }
        }
      } catch (error) {
        await hooks.finish({ components: planned });
        throw error;
      }
      return { components: planned };
    },

    async activate(plan, deploymentId) {
      for (const planned of plan.components) {
        await stores.revisionStore.activate(
          planned.scope,
          planned.component.name,
          planned.revisionId,
          deploymentId,
        );
        await rebuildIndex(
          await selectIndex(planned.scope, planned.component.name, planned.component.index),
          planned.scope,
          planned.component.name,
          planned.revisionId,
        );
        activeChecks.delete(knowledgeScopeCacheKey(planned.scope, planned.component.name));
      }
    },

    async compensate(plan, deploymentId) {
      for (const planned of plan.components) {
        if (planned.previousRevisionId === undefined) continue;
        // Pinning the previous revision to the failed deployment id is harmless: the record
        // never persisted, and the pin only widens GC protection of the retained revision.
        await stores.revisionStore.activate(
          planned.scope,
          planned.component.name,
          planned.previousRevisionId,
          deploymentId,
        );
        activeChecks.delete(knowledgeScopeCacheKey(planned.scope, planned.component.name));
      }
    },

    async finish(plan) {
      for (const planned of plan.components) {
        await stores.revisionStore.releaseLease(planned.lease);
      }
    },

    async rollback(deploymentId) {
      const restored = await stores.revisionStore.rollback(deploymentId);
      for (const revision of restored) {
        activeChecks.delete(knowledgeScopeCacheKey(revision.scope, revision.componentName));
      }
    },

    async publishSiteCorpus(scope, corpusName, documents) {
      const lease = await stores.revisionStore.acquireLease(
        scope,
        corpusName,
        `crawl-${now().getTime()}`,
      );
      try {
        const previous = await stores.revisionStore.active(scope, corpusName);
        const index = await selectIndex(scope, corpusName);
        const staged = await index.stage(scope, corpusName, documents);
        await stores.revisionStore.stage({
          scope,
          componentName: corpusName,
          contentHash: revisionContentHash(documents.map((document) => document.descriptor)),
          revision: staged,
        });
        await stores.revisionStore.stageDocuments(staged.revisionId, documents);
        // One synthetic pin id per corpus: activate pins the new revision to it, and the
        // displaced revision is unpinned so a retired crawl can reach GC.
        const pinId = `site-crawl:${knowledgeScopeCacheKey(scope, corpusName)}`;
        await stores.revisionStore.activate(scope, corpusName, staged.revisionId, pinId);
        if (previous !== undefined && previous.revisionId !== staged.revisionId) {
          await stores.revisionStore.unpin(previous.revisionId, pinId);
        }
        await rebuildIndex(index, scope, corpusName, staged.revisionId);
        activeChecks.delete(knowledgeScopeCacheKey(scope, corpusName));
      } finally {
        await stores.revisionStore.releaseLease(lease);
      }
    },

    async searchDocuments(scope, componentName, request) {
      const cacheKey = knowledgeScopeCacheKey(scope, componentName);
      const cached = activeChecks.get(cacheKey);
      let revisionId: string | undefined;
      if (cached !== undefined && now().getTime() - cached.checkedAt <= ACTIVE_REVISION_TTL_MS) {
        revisionId = cached.revisionId;
      } else {
        revisionId = (await stores.revisionStore.active(scope, componentName))?.revisionId;
        activeChecks.set(cacheKey, { revisionId, checkedAt: now().getTime() });
      }
      if (revisionId === undefined) return [];
      const index = await selectIndex(scope, componentName);
      await rebuildIndex(index, scope, componentName, revisionId);
      return index.search(scope, componentName, request);
    },

    async sweep() {
      const at = now().getTime();
      if (at - lastSweep < SWEEP_INTERVAL_MS) return;
      lastSweep = at;
      await stores.staging.sweepExpired();
      await stores.revisionStore.collectGarbage();
    },
  };
  return hooks;
}

function knowledgeScopeCacheKey(scope: KnowledgeScope, componentName: string): string {
  return `${scope.org}/${scope.app}/${scope.env}#${componentName}`;
}

/**
 * Wrap the caller's persistence step in the full publication transaction. The order is the
 * ADR 0202 pairing: stage + verify + activate the revision, persist the artifact, and on a
 * persistence failure re-activate the previous revision so the retained pair stays coherent.
 */
export async function withKnowledgePublication<T>(
  hooks: KnowledgeDeployHooks | undefined,
  tenant: KnowledgeTenantRef,
  deploymentId: string,
  components: readonly CompiledKnowledgeComponent[] | undefined,
  persist: () => Promise<T>,
): Promise<T> {
  if (hooks === undefined || components === undefined || components.length === 0) {
    return persist();
  }
  const plan = await hooks.publish(tenant, deploymentId, components);
  try {
    await hooks.activate(plan, deploymentId);
    const result = await persist();
    void hooks.sweep().catch(() => undefined);
    return result;
  } catch (error) {
    await hooks.compensate(plan, deploymentId).catch(() => undefined);
    throw error;
  } finally {
    await hooks.finish(plan);
  }
}
