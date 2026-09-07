import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { compileConnectors } from '../src/index.js';

it('maps trusted execution identity into provider headers/body independently of input', async () => {
  const received: { key?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ key: String(req.headers['idempotency-key']), body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const compiled = compileConnectors(
      JSON.stringify({
        connectors: [
          {
            id: 'test_action',
            version: '1.0.0',
            http: { baseUrl: url },
            operations: {
              submit: {
                type: 'action',
                method: 'POST',
                path: '/',
                input: { type: 'object', properties: {}, additionalProperties: false },
                output: { type: 'object', properties: {}, additionalProperties: false },
                headers: { 'Idempotency-Key': '${execution.id}' },
                request: { request_key: '${execution.id}' },
                evidence: { outcome: 'accepted', reference: 'job-42' },
              },
            },
          },
        ],
      }),
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const connector = compiled.connectors[0];
    if (!connector) throw new Error('Missing connector');
    const reportOutcome = vi.fn();
    await connector.invoke({
      operation: 'submit',
      args: {},
      credential: { token: '' },
      execution: { id: 'trusted' },
      reportOutcome,
    });
    expect(reportOutcome).toHaveBeenCalledWith({ outcome: 'accepted', reference: 'job-42' });
    expect(received).toEqual([{ key: 'trusted', body: '{"request_key":"trusted"}' }]);
    await expect(
      connector.invoke({
        operation: 'submit',
        args: { execution: { id: 'forged' } },
        credential: { token: '' },
      }),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
