/**
 * Customer-owned knowledge authoring (ADR 0202): one declarative component that compiles to a
 * generated `search_<name>` capability. Public developers never name a provider, touch an index,
 * or wrap a search tool — they point at bounded Markdown/text files and their live public site,
 * and ordinary deployment owns publication.
 */

/** One deploy-coupled knowledge document. */
export interface KnowledgeFileInput {
  /** Required non-empty title shown as the citation label. */
  readonly title: string;
  /** Optional exact HTTPS source URL shown as the citation target. */
  readonly sourceUrl?: string;
}

export interface KnowledgeFileDeclaration {
  readonly kind: 'file';
  readonly path: string;
  readonly title: string;
  readonly sourceUrl?: string;
}

/** Declare one project-root-relative UTF-8 `.md`/`.txt` document. */
export function file(path: string, input: KnowledgeFileInput): KnowledgeFileDeclaration {
  return {
    kind: 'file',
    path,
    title: input.title,
    ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
  };
}

export interface KnowledgeSiteInput {
  /** Exact HTTPS origin of the live public site, with no path. */
  readonly origin: string;
  /** Positive path globs that scope what the crawler may index and return. */
  readonly include: readonly string[];
  /** Crawl refresh interval, `15m`–`7d` (e.g. `'6h'`); the platform default is daily. */
  readonly refresh?: string;
}

export interface KnowledgeSiteDeclaration {
  readonly kind: 'site';
  readonly origin: string;
  readonly include: readonly string[];
  readonly refreshMinutes?: number;
}

const REFRESH_PATTERN = /^(\d+)(m|h|d)$/;
const MIN_REFRESH_MINUTES = 15;
const MAX_REFRESH_MINUTES = 7 * 24 * 60;

function parseRefreshMinutes(refresh: string): number {
  const match = REFRESH_PATTERN.exec(refresh);
  if (match === null) {
    throw new Error(`site refresh must look like '15m', '6h', or '7d' — got '${refresh}'`);
  }
  const value = Number(match[1]);
  const minutes = match[2] === 'm' ? value : match[2] === 'h' ? value * 60 : value * 24 * 60;
  if (minutes < MIN_REFRESH_MINUTES || minutes > MAX_REFRESH_MINUTES) {
    throw new Error(`site refresh must be between 15m and 7d — got '${refresh}'`);
  }
  return minutes;
}

/** Declare one live public website scope; the platform crawls and refreshes it. */
export function site(input: KnowledgeSiteInput): KnowledgeSiteDeclaration {
  return {
    kind: 'site',
    origin: input.origin,
    include: [...input.include],
    ...(input.refresh === undefined ? {} : { refreshMinutes: parseRefreshMinutes(input.refresh) }),
  };
}

/** A provider config reference by NAME (the variable()/secret() doctrine) — never a value. */
interface NamedConfigRef {
  readonly kind: 'variable' | 'secret';
  readonly name: string;
}

function namedRef(ref: {
  readonly kind: 'variable' | 'secret';
  readonly name: string;
}): NamedConfigRef {
  return { kind: ref.kind, name: ref.name };
}

export interface KnowledgeCrawlerDeclaration {
  readonly provider: 'firecrawl' | 'tavily';
  readonly config: { readonly apiKey: NamedConfigRef };
}

/** Crawl through the customer's own Firecrawl account (their key, their bill). */
export function firecrawl(input: {
  readonly apiKey: { readonly kind: 'variable' | 'secret'; readonly name: string };
}): KnowledgeCrawlerDeclaration {
  return { provider: 'firecrawl', config: { apiKey: namedRef(input.apiKey) } };
}

/** Crawl through the customer's own Tavily account (their key, their bill). */
export function tavily(input: {
  readonly apiKey: { readonly kind: 'variable' | 'secret'; readonly name: string };
}): KnowledgeCrawlerDeclaration {
  return { provider: 'tavily', config: { apiKey: namedRef(input.apiKey) } };
}

export interface KnowledgeIndexDeclaration {
  readonly provider: 'algolia' | 'meilisearch';
  readonly config: Readonly<Record<string, NamedConfigRef>>;
}

/** Index in the customer's own Algolia application. */
export function algolia(input: {
  readonly appId: { readonly kind: 'variable' | 'secret'; readonly name: string };
  readonly apiKey: { readonly kind: 'variable' | 'secret'; readonly name: string };
}): KnowledgeIndexDeclaration {
  return {
    provider: 'algolia',
    config: { appId: namedRef(input.appId), apiKey: namedRef(input.apiKey) },
  };
}

/** Index in the customer's own Meilisearch (Cloud or self-hosted). */
export function meilisearch(input: {
  readonly host: { readonly kind: 'variable' | 'secret'; readonly name: string };
  readonly apiKey: { readonly kind: 'variable' | 'secret'; readonly name: string };
}): KnowledgeIndexDeclaration {
  return {
    provider: 'meilisearch',
    config: { host: namedRef(input.host), apiKey: namedRef(input.apiKey) },
  };
}

export interface KnowledgeInput {
  readonly title: string;
  readonly description: string;
  readonly documents?: readonly KnowledgeFileDeclaration[];
  readonly sites?: readonly KnowledgeSiteDeclaration[];
  /** BYO crawler; omitted means the managed first-party crawler. */
  readonly crawler?: KnowledgeCrawlerDeclaration;
  /** BYO index; omitted means the managed bundled index. */
  readonly index?: KnowledgeIndexDeclaration;
}

export interface KnowledgeDeclaration {
  readonly kind: 'knowledge';
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly documents: readonly KnowledgeFileDeclaration[];
  readonly sites: readonly KnowledgeSiteDeclaration[];
  readonly crawler?: KnowledgeCrawlerDeclaration;
  readonly index?: KnowledgeIndexDeclaration;
}

/**
 * Declare one knowledge component. The compiler generates a `search_<name>` capability from it;
 * retrieval adapters and publication are platform concerns, never authoring concerns.
 */
export function knowledge(name: string, input: KnowledgeInput): KnowledgeDeclaration {
  return {
    kind: 'knowledge',
    name,
    title: input.title,
    description: input.description,
    documents: [...(input.documents ?? [])],
    sites: [...(input.sites ?? [])],
    ...(input.crawler === undefined ? {} : { crawler: input.crawler }),
    ...(input.index === undefined ? {} : { index: input.index }),
  };
}

/** Manifest-shaped projection consumed by `server()`; the compile pass hashes every document. */
export interface ManifestKnowledgeComponent {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly documents: {
    readonly path: string;
    readonly title: string;
    readonly sourceUrl?: string;
  }[];
  readonly sites: {
    readonly origin: string;
    readonly include: string[];
    readonly refreshMinutes?: number;
  }[];
  readonly crawler?: KnowledgeCrawlerDeclaration;
  readonly index?: KnowledgeIndexDeclaration;
}

export function manifestKnowledge(declaration: KnowledgeDeclaration): ManifestKnowledgeComponent {
  return {
    name: declaration.name,
    title: declaration.title,
    description: declaration.description,
    documents: declaration.documents.map((document) => ({
      path: document.path,
      title: document.title,
      ...(document.sourceUrl !== undefined ? { sourceUrl: document.sourceUrl } : {}),
    })),
    sites: declaration.sites.map((entry) => ({
      origin: entry.origin,
      include: [...entry.include],
      ...(entry.refreshMinutes === undefined ? {} : { refreshMinutes: entry.refreshMinutes }),
    })),
    // Provider declarations carry config NAMES only — a value here would leak into every
    // artifact and diff the manifest touches.
    ...(declaration.crawler === undefined ? {} : { crawler: declaration.crawler }),
    ...(declaration.index === undefined ? {} : { index: declaration.index }),
  };
}
