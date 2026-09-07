import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../../connector-defs/src/index.js';
import { connector, secret, z } from '../src/index.js';

describe('form-urlencoded HTTP authoring', () => {
  it('preserves the encoding through authoring, catalog compilation, and execution', async () => {
    let body = '';
    let headers: Record<string, string | string[] | undefined> = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk as Buffer));
      request.on('end', () => {
        body = Buffer.concat(chunks).toString('utf8');
        headers = request.headers;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const api = connector('jettly_search')
      .version('1.0.0')
      .http({
        baseUrl: `http://127.0.0.1:${port}`,
        auth: { kind: 'bearer', secret: secret('JETTLY_API_KEY') },
        operations: {
          search: {
            type: 'read',
            method: 'POST',
            path: '/search',
            requestEncoding: 'form-urlencoded',
            input: z.object({ from: z.string(), categories: z.array(z.string()) }),
            output: z.object({ ok: z.boolean() }),
            request: {
              'from airport id': '${args.from}',
              'aircraft[categories]': '${args.categories}',
            },
            response: { ok: '${response.ok}' },
          },
        },
      });

    expect(api.httpDef?.operations.search.requestEncoding).toBe('form-urlencoded');
    const compiled = compileConnectors(JSON.stringify({ connectors: [api.httpDef] }));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    }

    try {
      await expect(
        compiled.connectors[0]?.invoke({
          operation: 'search',
          args: { from: 'abc', categories: ['jet', 'turboprop'] },
          credential: { token: 'service-token' },
        }),
      ).resolves.toEqual({ ok: true });
      expect(body).toBe(
        'from+airport+id=abc&aircraft%5Bcategories%5D=%5B%22jet%22%2C%22turboprop%22%5D',
      );
      expect(headers['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
      expect(headers.authorization).toBe('Bearer service-token');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
