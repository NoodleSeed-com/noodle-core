import { createServer, type Server } from 'node:http';
import type { OperationSignature } from '@noodle-borg/compiler';
import { afterAll, beforeAll } from 'vitest';
import { HttpConnector, type HttpConnectorConfig } from '../src/index.js';

/** A closed object signature schema over one required string input and named output fields. */
function sig(
  type: OperationSignature['type'],
  inputField: string,
  outputs: Record<string, string>,
): OperationSignature {
  return {
    type,
    input: {
      type: 'object',
      properties: { [inputField]: { type: 'string' } },
      required: [inputField],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(outputs).map(([name, fieldType]) => [name, { type: fieldType }]),
      ),
      additionalProperties: false,
    },
  };
}

export const getPostSig = sig('read', 'post_id', { title: 'string', body: 'string' });
const listPostsSig = sig('read', 'user_id', { count: 'number' });
export const createSig = sig('action', 'label', { token: 'string' });
export const enrichSig = sig('action', 'derived', { derived: 'string' });

/** A local backing API: records each request (method/headers/body) and serves canned JSON. */
type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};
let server: Server;
export let baseUrl: string;
export let origin: string;
export let lastRequest: Recorded;
let flakyCount = 0;
let alwaysUnavailableCount = 0;
let unauthorizedCount = 0;
let rateLimitedCount = 0;

// A second backing host, to exercise the multi-host allowlist.
let server2: Server;
export let baseUrl2: string;
export let origin2: string;
export let lastRequest2: Recorded;

function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

/** httpbin-style echo: reflect the parsed body and the auth header so callers can map/assert on them. */
function echo(
  res: import('node:http').ServerResponse,
  req: import('node:http').IncomingMessage,
  body: unknown,
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      method: req.method,
      json: body,
      seen_auth: req.headers.authorization ?? req.headers['x-api-key'],
    }),
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      void readJsonBody(req).then((body) => {
        lastRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/anything' || url.pathname === '/api/v1/anything')
          return echo(res, req, body);
        if (url.pathname === '/always-503') {
          alwaysUnavailableCount += 1;
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'still unavailable' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    lastRequest = { method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers };
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/posts\/(\w+)$/.exec(url.pathname);
    const encodedMatch = /^\/encoded\/(.+)$/.exec(url.pathname);
    if (match) {
      const id = match[1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ id: Number(id), title: `t${id}`, body: `b${id}`, extra: 'drop-me' }),
      );
      return;
    }
    if (encodedMatch) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ encoded: encodedMatch[1] }));
      return;
    }
    if (url.pathname === '/posts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: 3 }));
      return;
    }
    if (url.pathname === '/large-declared') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/large-chunked') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: 'x'.repeat(64) }));
      return;
    }
    if (url.pathname === '/invalid-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json');
      return;
    }
    if (url.pathname === '/plain-text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('# Getting Started\nURL: /getting-started\nInstall the CLI, then run noodle dev.');
      return;
    }
    if (url.pathname === '/plain-large') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
      res.end('x'.repeat(64));
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 50);
      return;
    }
    if (url.pathname === '/flaky') {
      flakyCount += 1;
      if (flakyCount === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'try again' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: flakyCount }));
      return;
    }
    if (url.pathname === '/always-503') {
      alwaysUnavailableCount += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'still unavailable' }));
      return;
    }
    if (url.pathname === '/unauthorized') {
      unauthorizedCount += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad token' }));
      return;
    }
    if (url.pathname === '/rate-limited') {
      rateLimitedCount += 1;
      if (rateLimitedCount === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: 'slow down' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: rateLimitedCount }));
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/anything') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  origin = new URL(baseUrl).origin;

  // The secondary host only needs the echo route.
  server2 = createServer((req, res) => {
    void readJsonBody(req).then((body) => {
      lastRequest2 = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/anything') return echo(res, req, body);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const address2 = server2.address();
  const port2 = typeof address2 === 'object' && address2 ? address2.port : 0;
  baseUrl2 = `http://127.0.0.1:${port2}`;
  origin2 = new URL(baseUrl2).origin;
});

afterAll(async () => {
  await Promise.all(
    [server, server2].map(
      (s) => new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve()))),
    ),
  );
});

export function connector(extra: Partial<HttpConnectorConfig> = {}): HttpConnector {
  return new HttpConnector({
    id: 'jsonplaceholder',
    version: '1.0.0',
    baseUrl,
    operations: {
      get_post: {
        path: '/posts/{post_id}',
        signature: getPostSig,
        mapResponse: (j) => ({
          title: (j as { title: string }).title,
          body: (j as { body: string }).body,
        }),
      },
      list_posts: { path: '/posts', query: ['user_id'], signature: listPostsSig },
      encoded: { path: '/encoded/{value}', signature: getPostSig },
      bad_origin: { path: '//other.invalid/x', signature: getPostSig },
      missing: { path: '/nope', signature: getPostSig },
      large_declared: { path: '/large-declared', signature: getPostSig },
      large_chunked: { path: '/large-chunked', signature: getPostSig },
      invalid_json: { path: '/invalid-json', signature: getPostSig },
      slow: { path: '/slow', signature: getPostSig },
    },
    ...extra,
  });
}

export const credential = { token: 'svc-token' };

export function resetFlakyCount(): void {
  flakyCount = 0;
}

export function getFlakyCount(): number {
  return flakyCount;
}

export function resetAlwaysUnavailableCount(): void {
  alwaysUnavailableCount = 0;
}

export function getAlwaysUnavailableCount(): number {
  return alwaysUnavailableCount;
}

export function resetUnauthorizedCount(): void {
  unauthorizedCount = 0;
}

export function getUnauthorizedCount(): number {
  return unauthorizedCount;
}

export function resetRateLimitedCount(): void {
  rateLimitedCount = 0;
}

export function getRateLimitedCount(): number {
  return rateLimitedCount;
}
