import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpConnector } from '../src/index.js';

const credential = { token: 'svc-token' };
const readSignature = { type: 'read' as const, input: {}, output: {} };

function connector(operations: ConstructorParameters<typeof HttpConnector>[0]['operations']) {
  return new HttpConnector({
    id: 'fake-api',
    version: '1.0.0',
    baseUrl: 'https://api.example.test',
    fakeMode: true,
    operations,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpConnector fake mode', () => {
  it('maps a fake response without making an outbound HTTP request', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('fake mode should not fetch');
    });
    vi.stubGlobal('fetch', fetch);

    const c = connector({
      get: {
        path: '/live',
        signature: readSignature,
        fake: { response: { id: 'fake-1', title: 'Fixture title' } },
        mapResponse: (json) => ({ title: (json as { title: string }).title }),
      },
    });

    await expect(c.invoke({ operation: 'get', args: {}, credential })).resolves.toEqual({
      title: 'Fixture title',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails clearly when fake mode invokes an operation without fake data', async () => {
    const c = connector({
      get: {
        path: '/live',
        signature: readSignature,
      },
    });

    await expect(c.invoke({ operation: 'get', args: {}, credential })).rejects.toMatchObject({
      category: 'invalid_response',
      retryable: false,
    });
  });

  it('aggregates fake cursor pages through the same pagination contract', async () => {
    const c = connector({
      list: {
        path: '/items',
        signature: readSignature,
        fake: {
          pages: [
            { results: [{ id: 'a' }], next_cursor: 'next' },
            { results: [{ id: 'b' }], next_cursor: null },
          ],
        },
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
  });

  it('rejects duplicate cursors in fake paginated data', async () => {
    const c = connector({
      list: {
        path: '/items',
        signature: readSignature,
        fake: {
          pages: [
            { results: [{ id: 'a' }], next_cursor: 'same' },
            { results: [{ id: 'b' }], next_cursor: 'same' },
          ],
        },
        pagination: {
          kind: 'cursor',
          cursorParam: 'cursor',
          nextCursor: (json) => (json as { next_cursor?: string | null }).next_cursor,
          items: (json) => (json as { results: unknown[] }).results,
        },
      },
    });

    await expect(c.invoke({ operation: 'list', args: {}, credential })).rejects.toMatchObject({
      category: 'invalid_response',
      retryable: false,
    });
  });

  it('ignores fake data in live mode and fetches the upstream response', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ title: 'Live title' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    try {
      const c = new HttpConnector({
        id: 'live-api',
        version: '1.0.0',
        baseUrl: `http://127.0.0.1:${address.port}`,
        operations: {
          get: {
            path: '/live',
            signature: readSignature,
            fake: { response: { title: 'Fake title' } },
            mapResponse: (json) => ({ title: (json as { title: string }).title }),
          },
        },
      });

      await expect(c.invoke({ operation: 'get', args: {}, credential })).resolves.toEqual({
        title: 'Live title',
      });
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
