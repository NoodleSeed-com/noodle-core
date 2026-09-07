type UnknownRecord = Readonly<Record<string, unknown>>;

export type StoreContentItem = {
  readonly kind: 'page' | 'article';
  readonly id: string;
  readonly handle: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly publishedAt: string | null;
  readonly tags: readonly string[];
  readonly section: string | null;
};

export type StoreContentSearchResult = {
  readonly status: 'ok' | 'error';
  readonly items: readonly StoreContentItem[];
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly totalCount: number;
  readonly errors: readonly string[];
};

export function normalizeStoreContentSearchOperation(input: {
  readonly raw: unknown;
}): StoreContentSearchResult {
  function asRecordLocal(value: unknown): UnknownRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as UnknownRecord)
      : undefined;
  }
  function asStringLocal(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  function errorMessagesLocal(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        const item = asRecordLocal(entry);
        const message = asStringLocal(item?.message);
        if (!message) return undefined;
        const code = asStringLocal(item?.code);
        return code ? `${code}: ${message}` : message;
      })
      .filter((message): message is string => message !== undefined)
      .slice(0, 20);
  }
  function plainTextLocal(html: string): string {
    const entities: Readonly<Record<string, string>> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&nbsp;': ' ',
      '&ndash;': '–',
      '&mdash;': '—',
    };
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(amp|lt|gt|quot|#39|nbsp|ndash|mdash);/g, (entity) => entities[entity] ?? entity)
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  }
  function contentItemLocal(value: unknown): StoreContentItem | undefined {
    const item = asRecordLocal(value);
    if (!item) return undefined;
    const kind =
      item.__typename === 'Page' ? 'page' : item.__typename === 'Article' ? 'article' : undefined;
    const id = asStringLocal(item.id);
    const handle = asStringLocal(item.handle);
    const title = asStringLocal(item.title);
    const rawBody = kind === 'page' ? item.body : item.content;
    if (!kind || !id || !handle || !title || typeof rawBody !== 'string') return undefined;
    return {
      kind,
      id,
      handle,
      title,
      body: plainTextLocal(rawBody).slice(0, 4_000),
      url: typeof item.onlineStoreUrl === 'string' ? item.onlineStoreUrl : null,
      publishedAt:
        typeof (kind === 'page' ? item.updatedAt : item.publishedAt) === 'string'
          ? String(kind === 'page' ? item.updatedAt : item.publishedAt)
          : null,
      tags:
        kind === 'article' && Array.isArray(item.tags)
          ? item.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 50)
          : [],
      section:
        kind === 'article' && typeof asRecordLocal(item.blog)?.title === 'string'
          ? String(asRecordLocal(item.blog)?.title)
          : null,
    };
  }

  const emptyPageInfo = { hasNextPage: false, endCursor: null } as const;
  const root = asRecordLocal(input.raw);
  const errors = errorMessagesLocal(root?.errors);
  if (errors.length > 0) {
    return { status: 'error', items: [], pageInfo: emptyPageInfo, totalCount: 0, errors };
  }
  const search = asRecordLocal(asRecordLocal(root?.data)?.search);
  if (!search || !Array.isArray(search.nodes)) {
    return {
      status: 'error',
      items: [],
      pageInfo: emptyPageInfo,
      totalCount: 0,
      errors: ['Shopify returned an incomplete store content response.'],
    };
  }
  const items = search.nodes
    .map(contentItemLocal)
    .filter((item): item is StoreContentItem => item !== undefined)
    .slice(0, 20);
  const pageInfo = asRecordLocal(search.pageInfo);
  const normalizedPageInfo = {
    hasNextPage: pageInfo?.hasNextPage === true,
    endCursor: typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null,
  };
  if (items.length !== search.nodes.length) {
    return {
      status: 'error',
      items: [],
      pageInfo: normalizedPageInfo,
      totalCount: 0,
      errors: ['Shopify returned malformed store content.'],
    };
  }
  return {
    status: 'ok',
    items,
    pageInfo: normalizedPageInfo,
    totalCount:
      typeof search.totalCount === 'number' && Number.isSafeInteger(search.totalCount)
        ? search.totalCount
        : items.length,
    errors: [],
  };
}

export function normalizeStoreContentSearchResponse(raw: unknown): StoreContentSearchResult {
  return normalizeStoreContentSearchOperation({ raw });
}
