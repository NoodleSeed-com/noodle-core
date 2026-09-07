/**
 * Customer-owned knowledge retrieval (ADR 0202, amended for the managed-bundled v0): the
 * structural limits, the compiled Core v2 component shapes, the provider-neutral
 * `KnowledgeIndex`/`SiteSearch` ports, deterministic RRF fusion, the bundled BM25 adapter,
 * deploy-coupled revision coordination, and the tenant search budget that bounds metered
 * retrieval spend.
 *
 * The shared port conformance suites are deliberately absent here. This entrypoint is loaded
 * by the published CLI through `@noodle-borg/compiler`, so it stays limited to what a tarball
 * installs; adapter authors import the suites from `@noodle-borg/knowledge/conformance`.
 */

export * from './algolia-index.js';
export * from './bm25.js';
export * from './budget.js';
export * from './compile.js';
export * from './fakes.js';
export * from './fusion.js';
export * from './google-agent-search.js';
export * from './hits.js';
export * from './ir.js';
export * from './limits.js';
export * from './manifest-schema.js';
export * from './meilisearch-index.js';
export * from './ports.js';
export * from './postgres-budget-store.js';
export * from './postgres-revision-store.js';
export * from './revision-store.js';
