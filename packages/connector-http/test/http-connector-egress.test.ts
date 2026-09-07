import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { OperationSignature } from '@noodle-borg/compiler';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpConnector } from '../src/index.js';

const readSignature: OperationSignature = { type: 'read', input: {}, output: {} };
const credential = { token: 'redirect-secret' };

type TargetRequest = { readonly path: string; readonly headers: IncomingHttpHeaders };

let server: Server;
let crossOriginServer: Server;
let baseUrl: string;
let crossOriginUrl: string;
let targetRequests: TargetRequest[];
let redirectResponses = 0;

function respondWithRedirect(
  response: import('node:http').ServerResponse,
  location: string,
  status = 302,
): void {
  redirectResponses += 1;
  response.writeHead(status, { location, 'content-type': 'application/json' });
  response.end(JSON.stringify({ message: 'redirect response body' }));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/redirect/same-origin') {
      respondWithRedirect(
        response,
        '/redirect-target/same-origin?redirect-secret=should-not-appear',
      );
      return;
    }
    if (url.pathname === '/redirect/private-address') {
      respondWithRedirect(
        response,
        'http://169.254.169.254/latest/meta-data?redirect-secret=should-not-appear',
      );
      return;
    }
    if (url.pathname === '/redirect/cross-origin') {
      respondWithRedirect(response, `${crossOriginUrl}/redirect-target/cross-origin`);
      return;
    }
    if (url.pathname === '/redirect/loop') {
      respondWithRedirect(response, '/redirect/loop');
      return;
    }
    const statusMatch = /^\/redirect\/status\/(3\d\d)$/.exec(url.pathname);
    if (statusMatch?.[1] !== undefined) {
      respondWithRedirect(response, '/redirect-target/status', Number(statusMatch[1]));
      return;
    }
    if (url.pathname.startsWith('/redirect-target/')) {
      targetRequests.push({ path: url.pathname, headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results: [], next_cursor: null }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  crossOriginServer = createServer((request, response) => {
    targetRequests.push({ path: request.url ?? '/', headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ results: [], next_cursor: null }));
  });
  await Promise.all(
    [server, crossOriginServer].map(
      (current) => new Promise<void>((resolve) => current.listen(0, '127.0.0.1', resolve)),
    ),
  );
  const address = server.address();
  const crossOriginAddress = crossOriginServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const crossOriginPort =
    typeof crossOriginAddress === 'object' && crossOriginAddress ? crossOriginAddress.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  crossOriginUrl = `http://127.0.0.1:${crossOriginPort}`;
});

afterAll(async () => {
  await Promise.all(
    [server, crossOriginServer].map(
      (current) =>
        new Promise<void>((resolve, reject) =>
          current.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    ),
  );
});

beforeEach(() => {
  targetRequests = [];
  redirectResponses = 0;
});

function connector(
  path: string,
  auth:
    | { readonly kind: 'bearer' }
    | { readonly kind: 'apiKey'; readonly header: string }
    | {
        readonly kind: 'cookie';
      } = { kind: 'bearer' },
  pagination = false,
): HttpConnector {
  return new HttpConnector({
    id: 'redirecting-api',
    version: '1.0.0',
    baseUrl,
    headers: { cookie: 'session=static-cookie', 'x-custom-credential': 'custom-secret' },
    operations: {
      read: {
        path,
        signature: readSignature,
        auth,
        ...(pagination
          ? {
              pagination: {
                kind: 'cursor' as const,
                cursorParam: 'cursor',
                items: (json: unknown) => (json as { results: unknown[] }).results,
                nextCursor: (json: unknown) => (json as { next_cursor: string | null }).next_cursor,
              },
            }
          : {}),
      },
    },
  });
}

async function expectRejectedRedirect(request: Promise<unknown>, status = 302): Promise<void> {
  const error = await request.catch((reason: unknown) => reason);
  expect(error).toMatchObject({
    status,
    category: 'invalid_response',
    attempts: 1,
    retryable: false,
  });
  expect(JSON.stringify(error)).not.toContain('redirect-secret');
}

describe('HttpConnector redirect egress', () => {
  it.each([
    ['same-origin', '/redirect/same-origin'],
    ['cross-origin', '/redirect/cross-origin'],
    ['private-address', '/redirect/private-address'],
  ])('rejects a %s redirect without sending credentials to its target', async (_name, path) => {
    await expectRejectedRedirect(
      connector(path).invoke({ operation: 'read', args: {}, credential }),
    );

    expect(targetRequests).toEqual([]);
  });

  it('rejects a redirect loop as one non-retryable normalized egress failure', async () => {
    await expectRejectedRedirect(
      connector('/redirect/loop').invoke({ operation: 'read', args: {}, credential }),
    );

    expect(targetRequests).toEqual([]);
  });

  it.each([300, 302, 307, 399])('rejects HTTP %i without requesting its target', async (status) => {
    await expectRejectedRedirect(
      connector(`/redirect/status/${status}`).invoke({ operation: 'read', args: {}, credential }),
      status,
    );

    expect(targetRequests).toEqual([]);
  });

  it('does not retry a redirect response when a read retry policy is configured', async () => {
    const c = new HttpConnector({
      id: 'redirecting-api',
      version: '1.0.0',
      baseUrl,
      operations: {
        read: {
          path: '/redirect/same-origin',
          signature: readSignature,
          resilience: { retry: { maxAttempts: 3, baseDelayMs: 1 } },
        },
      },
    });

    await expectRejectedRedirect(c.invoke({ operation: 'read', args: {}, credential }));

    expect(redirectResponses).toBe(1);
    expect(targetRequests).toEqual([]);
  });

  it.each([
    [{ kind: 'bearer' } as const],
    [{ kind: 'apiKey', header: 'X-API-Key' } as const],
    [{ kind: 'cookie' } as const],
  ])('does not follow a redirect for %o credential presentation', async (auth) => {
    await expectRejectedRedirect(
      connector('/redirect/same-origin', auth).invoke({
        operation: 'read',
        args: {},
        credential:
          auth.kind === 'cookie' ? { kind: 'cookie', cookie: 'session=broker-cookie' } : credential,
      }),
    );

    expect(targetRequests).toEqual([]);
  });

  it('rejects a redirect from a paginated page without requesting the target', async () => {
    await expectRejectedRedirect(
      connector('/redirect/same-origin', { kind: 'bearer' }, true).invoke({
        operation: 'read',
        args: {},
        credential,
      }),
    );

    expect(targetRequests).toEqual([]);
  });
});
