import { createServer, type Server } from 'node:http';
import type { OperationSignature } from '@noodle-borg/compiler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConnector } from '../src/index.js';

type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

const updateSig: OperationSignature = {
  type: 'action',
  input: {
    type: 'object',
    properties: { id: { type: 'string' }, label: { type: 'string' } },
    required: ['id', 'label'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { method: { type: 'string' }, label: { type: 'string' } },
    additionalProperties: false,
  },
};

const deleteSig: OperationSignature = {
  type: 'action',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { deleted: { type: 'boolean' } },
    additionalProperties: false,
  },
};

let server: Server;
let baseUrl: string;
let lastRequest: Recorded;

function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw.length === 0 ? undefined : JSON.parse(raw));
    });
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'PUT' || req.method === 'PATCH') {
      void readJsonBody(req).then((body) => {
        lastRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
        if (req.url === '/items/1/fields') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, json: body }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
      return;
    }

    if (req.method === 'DELETE') {
      lastRequest = { method: 'DELETE', url: req.url ?? '', headers: req.headers };
      if (req.url === '/items/1') {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector(): HttpConnector {
  return new HttpConnector({
    id: 'methods',
    version: '1.0.0',
    baseUrl,
    operations: {
      update_item: {
        method: 'PATCH',
        path: '/items/{id}/fields',
        signature: updateSig,
        body: (args) => ({ label: args.label }),
        mapResponse: (json) => ({
          method: (json as { method: string }).method,
          label: (json as { json?: { label?: string } }).json?.label,
        }),
      },
      replace_item: {
        method: 'PUT',
        path: '/items/{id}/fields',
        signature: updateSig,
        body: (args) => ({ label: args.label }),
        mapResponse: (json) => ({
          method: (json as { method: string }).method,
          label: (json as { json?: { label?: string } }).json?.label,
        }),
      },
      delete_item: {
        method: 'DELETE',
        path: '/items/{id}',
        signature: deleteSig,
        responseType: 'empty',
        mapResponse: () => ({ deleted: true }),
      },
      delete_missing: {
        method: 'DELETE',
        path: '/missing-items/{id}',
        signature: deleteSig,
        responseType: 'empty',
        mapResponse: () => ({ deleted: true }),
      },
    },
  });
}

describe('HttpConnector HTTP methods', () => {
  const credential = { token: 'svc-token' };

  it('sends PATCH requests with a JSON body', async () => {
    const result = await connector().invoke({
      operation: 'update_item',
      args: { id: '1', label: 'Updated' },
      credential,
    });
    expect(result).toEqual({ method: 'PATCH', label: 'Updated' });
    expect(lastRequest).toMatchObject({
      method: 'PATCH',
      url: '/items/1/fields',
      body: { label: 'Updated' },
    });
    expect(lastRequest.headers['content-type']).toBe('application/json');
  });

  it('sends PUT requests with a JSON body', async () => {
    const result = await connector().invoke({
      operation: 'replace_item',
      args: { id: '1', label: 'Replaced' },
      credential,
    });
    expect(result).toEqual({ method: 'PUT', label: 'Replaced' });
    expect(lastRequest).toMatchObject({
      method: 'PUT',
      url: '/items/1/fields',
      body: { label: 'Replaced' },
    });
    expect(lastRequest.headers['content-type']).toBe('application/json');
  });

  it('sends DELETE requests and accepts empty 204 responses', async () => {
    const result = await connector().invoke({
      operation: 'delete_item',
      args: { id: '1' },
      credential,
    });
    expect(result).toEqual({ deleted: true });
    expect(lastRequest).toMatchObject({ method: 'DELETE', url: '/items/1' });
    expect(lastRequest.body).toBeUndefined();
    expect(lastRequest.headers['content-type']).toBeUndefined();
  });

  it('still reports non-2xx DELETE responses', async () => {
    await expect(
      connector().invoke({ operation: 'delete_missing', args: { id: '2' }, credential }),
    ).rejects.toThrow(/responded 404/);
  });
});
