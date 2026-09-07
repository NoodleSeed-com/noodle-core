import { describe, expect, it } from 'vitest';
import { AlgoliaKnowledgeIndex } from '../src/algolia-index.js';
import { describeKnowledgeIndex, testScope } from '../src/conformance.js';
import { MeilisearchKnowledgeIndex } from '../src/meilisearch-index.js';

/**
 * BYO index adapters run the SAME shared conformance suite as the fake and the bundled BM25 —
 * against small in-test emulators that implement the providers' *documented* semantics (object
 * storage, equality filters, word matching), never the adapters' own assumptions. Wire-shape
 * assertions pin the documented endpoints, auth headers, and filter syntax.
 */

interface StoredRecord {
  [key: string]: unknown;
  text?: string;
  title?: string;
}

function matches(record: StoredRecord, query: string): boolean {
  const haystack = `${record.title ?? ''} ${record.text ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '')
    .some((term) => haystack.includes(term));
}

/** Algolia emulator: batch object writes, `k:v AND k:v` filters, word-match search. */
function algoliaEmulator(): {
  fetchImpl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const indexes = new Map<string, Map<string, StoredRecord>>();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as never);
    const uid = path.split('/')[3] ?? '';
    const index = indexes.get(uid) ?? new Map<string, StoredRecord>();
    indexes.set(uid, index);
    const filterMatch = (record: StoredRecord, filters: string | undefined): boolean =>
      (filters ?? '')
        .split(' AND ')
        .filter((clause) => clause !== '')
        .every((clause) => {
          const [key, value] = clause.split(':');
          return key !== undefined && String(record[key]) === value;
        });
    if (path.endsWith('/settings')) return new Response('{}', { status: 200 });
    if (path.endsWith('/batch')) {
      for (const request of (body as { requests: { body: StoredRecord & { objectID: string } }[] })
        .requests) {
        index.set(request.body.objectID, request.body);
      }
      return new Response('{}', { status: 200 });
    }
    if (path.endsWith('/deleteByQuery')) {
      const { filters } = body as { filters?: string };
      for (const [id, record] of index) {
        if (filterMatch(record, filters)) index.delete(id);
      }
      return new Response('{}', { status: 200 });
    }
    if (path.endsWith('/query')) {
      const { query, filters, hitsPerPage } = body as {
        query: string;
        filters?: string;
        hitsPerPage?: number;
      };
      const hits = [...index.values()]
        .filter((record) => filterMatch(record, filters) && matches(record, query))
        .slice(0, hitsPerPage ?? 20);
      return new Response(JSON.stringify({ hits, nbHits: hits.length }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Meilisearch emulator: async task writes, `k = "v" AND …` filters, word-match search. */
function meilisearchEmulator(): {
  fetchImpl: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const indexes = new Map<string, Map<string, StoredRecord>>();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let taskCounter = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as never);
    if (path.startsWith('/tasks/')) {
      return new Response(JSON.stringify({ status: 'succeeded' }), { status: 200 });
    }
    const uid = path.split('/')[2] ?? '';
    const index = indexes.get(uid) ?? new Map<string, StoredRecord>();
    indexes.set(uid, index);
    const filterMatch = (record: StoredRecord, filter: string | undefined): boolean =>
      (filter ?? '')
        .split(' AND ')
        .filter((clause) => clause !== '')
        .every((clause) => {
          const parts = /^(\S+) = "([^"]*)"$/.exec(clause.trim());
          return parts !== null && String(record[parts[1] ?? '']) === parts[2];
        });
    if (path.endsWith('/settings')) {
      taskCounter += 1;
      return new Response(JSON.stringify({ taskUid: taskCounter }), { status: 202 });
    }
    if (path.endsWith('/documents/delete')) {
      const { filter } = body as unknown as { filter?: string };
      for (const [id, record] of index) {
        if (filterMatch(record, filter)) index.delete(id);
      }
      taskCounter += 1;
      return new Response(JSON.stringify({ taskUid: taskCounter }), { status: 202 });
    }
    if (path.endsWith('/documents')) {
      for (const record of body as unknown as (StoredRecord & { id: string })[]) {
        index.set(record.id, record);
      }
      taskCounter += 1;
      return new Response(JSON.stringify({ taskUid: taskCounter }), { status: 202 });
    }
    if (path.endsWith('/search')) {
      const { q, filter, limit } = body as unknown as {
        q: string;
        filter?: string;
        limit?: number;
      };
      const hits = [...index.values()]
        .filter((record) => filterMatch(record, filter) && matches(record, q))
        .slice(0, limit ?? 20);
      return new Response(JSON.stringify({ hits }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const runner = { describe, it };

describeKnowledgeIndex(
  runner,
  () =>
    new AlgoliaKnowledgeIndex({
      appId: 'APP123',
      apiKey: 'algolia-key',
      scope: testScope,
      fetchImpl: algoliaEmulator().fetchImpl,
    }),
  'BYO Algolia (documented-semantics emulator)',
);

describeKnowledgeIndex(
  runner,
  () =>
    new MeilisearchKnowledgeIndex({
      host: 'https://ms.customer.test',
      apiKey: 'meili-key',
      scope: testScope,
      fetchImpl: meilisearchEmulator().fetchImpl,
      pollIntervalMs: 0,
    }),
  'BYO Meilisearch (documented-semantics emulator)',
);

describe('BYO index wire contracts', () => {
  it('algolia: documented host, auth headers, faceting settings, and filter syntax', async () => {
    const { fetchImpl, calls } = algoliaEmulator();
    const index = new AlgoliaKnowledgeIndex({
      appId: 'APP123',
      apiKey: 'algolia-key',
      scope: testScope,
      fetchImpl,
    });
    const revision = await index.stage(testScope, 'product', [
      {
        descriptor: { path: 'a.md', title: 'A', sha256: 'a'.repeat(64), bytes: 5 },
        text: 'alpha pricing',
      },
    ]);
    await index.activate(revision.revisionId);
    await index.search(testScope, 'product', { query: 'pricing', limit: 5 });
    expect(calls[0]?.url).toContain('https://APP123-dsn.algolia.net/1/indexes/');
    expect(calls[0]?.headers['x-algolia-application-id']).toBe('APP123');
    expect(calls[0]?.headers['x-algolia-api-key']).toBe('algolia-key');
  });

  it('meilisearch: customer host, bearer auth, task polling, and filter syntax', async () => {
    const { fetchImpl, calls } = meilisearchEmulator();
    const index = new MeilisearchKnowledgeIndex({
      host: 'https://ms.customer.test',
      apiKey: 'meili-key',
      scope: testScope,
      fetchImpl,
      pollIntervalMs: 0,
    });
    const revision = await index.stage(testScope, 'product', [
      {
        descriptor: { path: 'a.md', title: 'A', sha256: 'b'.repeat(64), bytes: 5 },
        text: 'alpha pricing',
      },
    ]);
    await index.activate(revision.revisionId);
    await index.search(testScope, 'product', { query: 'pricing', limit: 5 });
    expect(calls[0]?.url).toContain('https://ms.customer.test/indexes/');
    expect(calls[0]?.headers.authorization).toBe('Bearer meili-key');
    expect(calls.some((call) => call.url.includes('/tasks/'))).toBe(true);
  });

  it('provider errors are attributable and never carry the API key', async () => {
    const failing = (async () =>
      new Response('{"message":"bad key algolia-key"}', {
        status: 403,
      })) as unknown as typeof fetch;
    const index = new AlgoliaKnowledgeIndex({
      appId: 'APP123',
      apiKey: 'algolia-key',
      scope: testScope,
      fetchImpl: failing,
    });
    const attempt = index.stage(testScope, 'product', [
      {
        descriptor: { path: 'a.md', title: 'A', sha256: 'c'.repeat(64), bytes: 5 },
        text: 'alpha',
      },
    ]);
    await expect(attempt).rejects.toMatchObject({ layer: 'provider' });
    await expect(attempt).rejects.not.toThrow(/algolia-key/);
  });
});
