import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OperationSignature } from '@noodle-borg/compiler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConnector, type HttpOperation } from '../src/index.js';

const signature: OperationSignature = {
  type: 'read',
  input: { type: 'object', additionalProperties: true },
  output: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
};

interface RecordedRequest {
  readonly body: string;
  readonly contentType?: string;
  readonly authorization?: string;
}

let server: Server;
let baseUrl: string;
const requests: RecordedRequest[] = [];
let retryAttempts = 0;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void readBody(request).then((body) => {
      requests.push({
        body,
        ...(request.headers['content-type'] === undefined
          ? {}
          : { contentType: request.headers['content-type'] }),
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      });
      if (request.url === '/retry' && retryAttempts++ === 0) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'retry' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector(operation: HttpOperation): HttpConnector {
  return new HttpConnector({
    id: 'request_encoding',
    version: '1.0.0',
    baseUrl,
    headers: { 'Content-Type': 'application/incorrect' },
    auth: { kind: 'bearer' },
    operations: { search: operation },
  });
}

describe('HTTP request encoding', () => {
  const credential = { token: 'jettly-service-token' };

  it('sends an exact URLSearchParams body with bearer auth', async () => {
    requests.length = 0;
    const client = connector({
      method: 'POST',
      path: '/search',
      signature,
      requestEncoding: 'form-urlencoded',
      body: () => ({
        'from airport id': 'abc',
        'aircraft[categories]': ['jet', 'turboprop'],
        'include/empty': false,
        passengers: 4,
        notes: null,
        filters: { private: true },
        omitted: undefined,
        'empty list': [],
        'empty object': {},
      }),
    });

    await expect(client.invoke({ operation: 'search', args: {}, credential })).resolves.toEqual({
      ok: true,
    });
    expect(requests).toEqual([
      {
        body: 'from+airport+id=abc&aircraft%5Bcategories%5D=%5B%22jet%22%2C%22turboprop%22%5D&include%2Fempty=false&passengers=4&notes=null&filters=%7B%22private%22%3Atrue%7D&empty+list=%5B%5D&empty+object=%7B%7D',
        contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
        authorization: 'Bearer jettly-service-token',
      },
    ]);
  });

  it('preserves the existing JSON request behavior by default', async () => {
    requests.length = 0;
    const client = connector({
      method: 'POST',
      path: '/json',
      signature,
      body: () => ({ label: 'Updated' }),
    });

    await client.invoke({ operation: 'search', args: {}, credential });
    expect(requests).toEqual([
      {
        body: '{"label":"Updated"}',
        contentType: 'application/json',
        authorization: 'Bearer jettly-service-token',
      },
    ]);
  });

  it('reuses the identical form body across retries', async () => {
    requests.length = 0;
    retryAttempts = 0;
    const client = connector({
      method: 'POST',
      path: '/retry',
      signature,
      requestEncoding: 'form-urlencoded',
      body: () => ({ 'from airport id': 'abc', categories: ['jet'] }),
      resilience: {
        retry: { maxAttempts: 2, baseDelayMs: 1, retryOn: ['upstream_5xx'] },
      },
    });

    await client.invoke({ operation: 'search', args: {}, credential });
    expect(requests.map(({ body }) => body)).toEqual([
      'from+airport+id=abc&categories=%5B%22jet%22%5D',
      'from+airport+id=abc&categories=%5B%22jet%22%5D',
    ]);
  });

  it('rejects a pre-encoded string instead of quoting it', async () => {
    requests.length = 0;
    const client = connector({
      method: 'POST',
      path: '/search',
      signature,
      requestEncoding: 'form-urlencoded',
      body: () => 'from+airport+id=abc',
    });

    await expect(client.invoke({ operation: 'search', args: {}, credential })).rejects.toThrow(
      'form-urlencoded request body must be a plain object',
    );
    expect(requests).toEqual([]);
  });

  it('rejects non-finite and non-JSON-compatible field values', async () => {
    for (const value of [Number.NaN, 1n]) {
      const client = connector({
        method: 'POST',
        path: '/search',
        signature,
        requestEncoding: 'form-urlencoded',
        body: () => ({ invalid: value }),
      });
      await expect(client.invoke({ operation: 'search', args: {}, credential })).rejects.toThrow(
        'form-urlencoded request field must be JSON-compatible',
      );
    }
  });
});
