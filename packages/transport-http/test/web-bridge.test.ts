import { createServer, request as httpRequest, type RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { toWebRequest, writeWebResponse } from '../src/web-bridge.js';

async function readIncoming(req: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function withServer<T>(
  listener: Parameters<typeof createServer>[0],
  run: (port: number) => Promise<T>,
): Promise<T> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function rawRequest(
  port: number,
  options: Omit<RequestOptions, 'port'>,
  body?: string,
): Promise<{ status: number; rawHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...options, port }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('node:http to web-standard bridge', () => {
  it('preserves method, absolute URL, repeated headers, and the already-buffered body', async () => {
    await withServer(
      async (req, res) => {
        const body = await readIncoming(req);
        const webRequest = toWebRequest(req, body);
        await writeWebResponse(
          res,
          Response.json({
            method: webRequest.method,
            url: webRequest.url,
            repeated: webRequest.headers.get('x-repeat'),
            body: await webRequest.text(),
          }),
        );
      },
      async (port) => {
        const response = await rawRequest(
          port,
          {
            method: 'POST',
            path: '/mcp?mode=golden',
            headers: [
              'host',
              'tenant.example.test',
              'x-forwarded-proto',
              'https',
              'x-repeat',
              'first',
              'x-repeat',
              'second',
              'content-type',
              'application/json',
            ],
          },
          '{"ok":true}',
        );

        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({
          method: 'POST',
          url: 'https://tenant.example.test/mcp?mode=golden',
          repeated: 'first, second',
          body: '{"ok":true}',
        });
      },
    );
  });

  it('writes JSON responses with status and headers intact', async () => {
    await withServer(
      (_req, res) =>
        void writeWebResponse(
          res,
          Response.json({ ok: true }, { status: 201, headers: { 'x-result': 'created' } }),
        ),
      async (port) => {
        const response = await rawRequest(port, { method: 'GET', path: '/' });
        expect(response.status).toBe(201);
        expect(response.rawHeaders).toContain('x-result');
        expect(JSON.parse(response.body)).toEqual({ ok: true });
      },
    );
  });

  it('writes an empty 202 response without inventing a body', async () => {
    await withServer(
      (_req, res) => void writeWebResponse(res, new Response(null, { status: 202 })),
      async (port) => {
        const response = await rawRequest(port, { method: 'GET', path: '/' });
        expect(response).toMatchObject({ status: 202, body: '' });
      },
    );
  });

  it('streams web ReadableStream bodies such as SSE', async () => {
    const encoder = new TextEncoder();
    await withServer(
      (_req, res) =>
        void writeWebResponse(
          res,
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('event: message\n'));
                controller.enqueue(encoder.encode('data: {"ok":true}\n\n'));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
      async (port) => {
        const response = await rawRequest(port, { method: 'GET', path: '/' });
        expect(response.status).toBe(200);
        expect(response.body).toBe('event: message\ndata: {"ok":true}\n\n');
      },
    );
  });

  it('keeps multiple Set-Cookie fields separate', async () => {
    await withServer(
      (_req, res) => {
        const headers = new Headers();
        headers.append('set-cookie', 'first=1; Path=/; HttpOnly');
        headers.append('set-cookie', 'second=2; Path=/; Secure');
        void writeWebResponse(res, new Response('ok', { headers }));
      },
      async (port) => {
        const response = await rawRequest(port, { method: 'GET', path: '/' });
        const cookies = response.rawHeaders.filter(
          (_value, index) =>
            index > 0 && response.rawHeaders[index - 1]?.toLowerCase() === 'set-cookie',
        );
        expect(cookies).toEqual(['first=1; Path=/; HttpOnly', 'second=2; Path=/; Secure']);
      },
    );
  });

  it('fails before mutating a response whose headers were already sent', async () => {
    await withServer(
      async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-original': 'yes' });
        res.flushHeaders();
        await expect(
          writeWebResponse(res, new Response('replacement', { status: 418 })),
        ).rejects.toThrow('headers already sent');
        res.end('original');
      },
      async (port) => {
        const response = await rawRequest(port, { method: 'GET', path: '/' });
        expect(response).toMatchObject({ status: 200, body: 'original' });
        expect(response.rawHeaders).toContain('x-original');
      },
    );
  });
});
