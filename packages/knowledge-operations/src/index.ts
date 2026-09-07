/**
 * Knowledge control-plane orchestration (ADR 0202 as amended). The service composes these
 * behind its thin dispatch; the CLI never imports this package.
 */
export { type StringSecretBox, secretBoxDocumentCodec } from './codec.js';
export {
  type CrawlableComponent,
  type CrawlStateStore,
  type CrawlStatus,
  InMemoryCrawlStateStore,
  runComponentCrawl,
  runDueCrawls,
  type SiteCrawlState,
  siteCorpusName,
} from './crawl-lifecycle.js';
export { dispatchKnowledgeRequest, type KnowledgeDispatchDeps } from './dispatch.js';
export {
  createKnowledgeSearchExecutor,
  type KnowledgeSearchComponent,
  type KnowledgeSearchExecutor,
  type KnowledgeSearchExecutorDeps,
  type KnowledgeSearchRequest,
} from './executor.js';
export { readBody, sendJson } from './http.js';
export { type KnowledgeRouteRef, parseKnowledgePath } from './paths.js';
export { PostgresCrawlStateStore } from './postgres-crawl-state.js';
export { createPostgresKnowledgeStores } from './postgres-service-wiring.js';
export { PostgresKnowledgeStagingStore } from './postgres-staging-store.js';
export {
  createKnowledgeDeployHooks,
  type KnowledgeDeployFailure,
  type KnowledgeDeployHooks,
  KnowledgePublicationError,
  type KnowledgePublicationPlan,
  withKnowledgePublication,
} from './publication.js';
export {
  handleKnowledgeDocumentUpload,
  handleKnowledgePreflight,
  type KnowledgeRouteDeps,
  type KnowledgeTenantRef,
  knowledgeEnableCommand,
  knowledgeTenantKey,
} from './routes.js';
export {
  type BoundKnowledgeSearchPort,
  bindKnowledgeSearchPort,
  type KnowledgeSearchPortFactory,
  knowledgeSearchPortFactory,
} from './search-port.js';
export {
  budgetCeilingsResolver,
  buildKnowledgeRouteDeps,
  defaultKnowledgeStores,
  type KnowledgeServiceStores,
  wireKnowledge,
} from './service-wiring.js';
export {
  InMemoryKnowledgeStagingStore,
  type KnowledgeStagingStore,
  STAGING_TTL_MS,
} from './staging-store.js';
export {
  handleKnowledgeList,
  handleKnowledgeStatus,
  type KnowledgeStatusDeps,
} from './status-routes.js';
