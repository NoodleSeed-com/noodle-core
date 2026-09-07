import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DnsLookup } from '../src/ssrf.js';

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));

vi.mock('../src/ssrf.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/ssrf.js')>();
  return { ...original, guardedFetch };
});

import { HttpConnector } from '../src/index.js';

const readSignature = { type: 'read' as const, input: {}, output: {} };
const publicAddress = { address: '93.184.216.34', family: 4 };

afterEach(() => {
  guardedFetch.mockReset();
});

describe('HttpConnector DNS guard orchestration', () => {
  it('pins a public DNS name for every retry and successive pagination page', async () => {
    const lookupCalls: string[] = [];
    const lookup: DnsLookup = (hostname, _options, callback) => {
      lookupCalls.push(hostname);
      callback(null, [publicAddress]);
    };
    const bodies = [
      new Response(JSON.stringify({ error: 'try again' }), { status: 503 }),
      new Response(JSON.stringify({ results: [{ id: 'a' }], next: 'next-page' }), { status: 200 }),
      new Response(JSON.stringify({ results: [{ id: 'b' }], next: null }), { status: 200 }),
    ];
    const guardedUrls: string[] = [];
    guardedFetch.mockImplementation(async (url, _init, options) => {
      guardedUrls.push(url.toString());
      if (options.lookup === undefined) throw new Error('DNS guard lookup was not forwarded');
      await new Promise<void>((resolve, reject) =>
        options.lookup?.(url.hostname, { all: true }, (error, addresses) => {
          if (error) reject(error);
          else if (!Array.isArray(addresses) || addresses[0]?.address !== publicAddress.address) {
            reject(new Error('DNS guard did not receive the public pinned address'));
          } else resolve();
        }),
      );
      const response = bodies.shift();
      if (response === undefined) throw new Error('unexpected additional outbound request');
      return response;
    });

    const connector = new HttpConnector({
      id: 'public-api',
      version: '1.0.0',
      baseUrl: 'https://api.example.test',
      allowedOrigins: ['https://api.example.test'],
      lookup,
      operations: {
        list: {
          path: '/records',
          signature: readSignature,
          resilience: { retry: { maxAttempts: 2, baseDelayMs: 0 } },
          pagination: {
            kind: 'cursor',
            cursorParam: 'cursor',
            nextCursor: (json) => (json as { next: string | null }).next,
            items: (json) => (json as { results: unknown[] }).results,
          },
        },
      },
    });

    await expect(
      connector.invoke({ operation: 'list', args: {}, credential: { token: 'service-token' } }),
    ).resolves.toMatchObject({
      items: [{ id: 'a' }, { id: 'b' }],
      pageCount: 2,
      partial: false,
    });
    expect(guardedUrls).toEqual([
      'https://api.example.test/records',
      'https://api.example.test/records',
      'https://api.example.test/records?cursor=next-page',
    ]);
    // One preflight in invoke, one preflight per page, and one pinned transport lookup per request.
    expect(lookupCalls).toEqual([
      'api.example.test',
      'api.example.test',
      'api.example.test',
      'api.example.test',
      'api.example.test',
      'api.example.test',
    ]);
  });
});
