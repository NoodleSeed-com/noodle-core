import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConnector } from '../src/index.js';

let server: Server;
let baseUrl: string;
let lastUrl = '';
let paginatedFlakyCount = 0;

const credential = { token: 'svc-token' };
const readSignature = { type: 'read' as const, input: {}, output: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? '';
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/cursor-items') {
      const cursor = url.searchParams.get('cursor');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          cursor === 'next'
            ? { results: [{ id: 'b' }], next_cursor: null }
            : { results: [{ id: 'a' }], next_cursor: 'next' },
        ),
      );
      return;
    }
    if (url.pathname === '/duplicate-cursor') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ results: [{ id: url.searchParams.get('cursor') ?? 'a' }], next: 'same' }),
      );
      return;
    }
    if (url.pathname === '/numbered-items') {
      const page = Number(url.searchParams.get('page') ?? '1');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ id: `p${page}` }], has_more: page < 3 }));
      return;
    }
    if (url.pathname === '/exact-final-page') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ id: 'only' }], has_more: false }));
      return;
    }
    if (url.pathname === '/paginated-flaky') {
      paginatedFlakyCount += 1;
      if (paginatedFlakyCount === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'try page again' }));
        return;
      }
      const cursor = url.searchParams.get('cursor');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          cursor === 'next'
            ? { results: [{ id: 'retry-b' }], next_cursor: null }
            : { results: [{ id: 'retry-a' }], next_cursor: 'next' },
        ),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function connector(operations: ConstructorParameters<typeof HttpConnector>[0]['operations']) {
  return new HttpConnector({
    id: 'paginated',
    version: '1.0.0',
    baseUrl,
    operations,
  });
}

describe('HttpConnector pagination', () => {
  it('aggregates cursor-paginated responses before mapping', async () => {
    const c = connector({
      list: {
        path: '/cursor-items',
        signature: readSignature,
        pagination: {
          kind: 'cursor',
          cursorParam: 'cursor',
          nextCursor: (json) => (json as { next_cursor?: string | null }).next_cursor,
          items: (json) => (json as { results: unknown[] }).results,
          maxPages: 5,
          maxItems: 10,
        },
        mapResponse: (json) => ({
          items: (json as { items: unknown[] }).items,
          pageCount: (json as { pageCount: number }).pageCount,
          partial: (json as { partial: boolean }).partial,
        }),
      },
    });
    await expect(c.invoke({ operation: 'list', args: {}, credential })).resolves.toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      pageCount: 2,
      partial: false,
    });
    expect(lastUrl).toBe('/cursor-items?cursor=next');
  });

  it('fails closed when a cursor-paginated response repeats a cursor', async () => {
    const c = connector({
      list: {
        path: '/duplicate-cursor',
        signature: readSignature,
        pagination: {
          kind: 'cursor',
          cursorParam: 'cursor',
          nextCursor: (json) => (json as { next: string }).next,
          items: (json) => (json as { results: unknown[] }).results,
        },
      },
    });
    await expect(c.invoke({ operation: 'list', args: {}, credential })).rejects.toMatchObject({
      category: 'invalid_response',
      retryable: false,
    });
  });

  it('aggregates page-number responses and marks max-page partials', async () => {
    const c = connector({
      list: {
        path: '/numbered-items',
        signature: readSignature,
        pagination: {
          kind: 'pageNumber',
          pageParam: 'page',
          startPage: 1,
          hasMore: (json) => (json as { has_more: boolean }).has_more,
          items: (json) => (json as { results: unknown[] }).results,
          maxPages: 2,
          maxItems: 10,
        },
      },
    });
    await expect(c.invoke({ operation: 'list', args: {}, credential })).resolves.toEqual({
      items: [{ id: 'p1' }, { id: 'p2' }],
      pages: [
        { results: [{ id: 'p1' }], has_more: true },
        { results: [{ id: 'p2' }], has_more: true },
      ],
      last: { results: [{ id: 'p2' }], has_more: true },
      pageCount: 2,
      partial: true,
      stopReason: 'max_pages',
    });
  });

  it('stops at maxItems and returns a bounded partial aggregate', async () => {
    const c = connector({
      list: {
        path: '/numbered-items',
        signature: readSignature,
        pagination: {
          kind: 'pageNumber',
          pageParam: 'page',
          hasMore: (json) => (json as { has_more: boolean }).has_more,
          items: (json) => (json as { results: unknown[] }).results,
          maxPages: 5,
          maxItems: 2,
        },
      },
    });
    await expect(c.invoke({ operation: 'list', args: {}, credential })).resolves.toMatchObject({
      items: [{ id: 'p1' }, { id: 'p2' }],
      pageCount: 2,
      partial: true,
      stopReason: 'max_items',
    });
  });

  it('does not mark an exact maxItems final page as partial', async () => {
    const c = connector({
      list: {
        path: '/exact-final-page',
        signature: readSignature,
        pagination: {
          kind: 'pageNumber',
          pageParam: 'page',
          hasMore: (json) => (json as { has_more: boolean }).has_more,
          items: (json) => (json as { results: unknown[] }).results,
          maxPages: 5,
          maxItems: 1,
        },
      },
    });
    await expect(c.invoke({ operation: 'list', args: {}, credential })).resolves.toMatchObject({
      items: [{ id: 'only' }],
      pageCount: 1,
      partial: false,
    });
  });

  it('applies resilience retries to each paginated page request', async () => {
    paginatedFlakyCount = 0;
    const c = connector({
      list: {
        path: '/paginated-flaky',
        signature: readSignature,
        resilience: { retry: { maxAttempts: 2, baseDelayMs: 1 } },
        pagination: {
          kind: 'cursor',
          cursorParam: 'cursor',
          nextCursor: (json) => (json as { next_cursor?: string | null }).next_cursor,
          items: (json) => (json as { results: unknown[] }).results,
          maxPages: 5,
          maxItems: 10,
        },
      },
    });
    await expect(c.invoke({ operation: 'list', args: {}, credential })).resolves.toMatchObject({
      items: [{ id: 'retry-a' }, { id: 'retry-b' }],
      pageCount: 2,
      partial: false,
    });
    expect(paginatedFlakyCount).toBe(3);
  });
});
