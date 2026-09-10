import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpConnector, type HttpOperation } from '../src/index.js';

let server: Server;
let baseUrl: string;
let calls = 0;
const operation: HttpOperation = {
  path: '/409',
  method: 'POST',
  signature: { type: 'action', input: {}, output: {} },
  mapResponse: () => ({ outcome: 'success' }),
  evidence: () => ({ outcome: 'completed' }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    calls += 1;
    const [status, mode] = (req.url ?? '').slice(1).split('/');
    res.statusCode = Number(status);
    if (res.statusCode === 302) res.setHeader('location', `${baseUrl}/200`);
    if (mode === 'declared') res.setHeader('content-length', '100000');
    res.end(
      mode === 'invalid'
        ? 'sensitive backend diagnostic'
        : JSON.stringify({ reason: 'duplicate', secret: 'private-provider-diagnostic' }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  calls = 0;
});

function invoke(overrides: Partial<HttpOperation> = {}) {
  const connector = new HttpConnector({
    id: 'provider',
    version: '1.0.0',
    baseUrl,
    operations: { write: { ...operation, ...overrides } },
  });
  const reportOutcome = vi.fn();
  return {
    reportOutcome,
    result: connector.invoke({
      operation: 'write',
      args: { resource: 'r1' },
      credential: { token: 'credential-must-not-escape' },
      reportOutcome,
    }),
  };
}

describe('explicit HTTP status responses', () => {
  it.each([
    404, 409, 410, 412,
  ])('maps declared %s without inheriting success evidence', async (status) => {
    const { result, reportOutcome } = invoke({
      path: `/${status}`,
      responses: {
        [status]: {
          mapResponse: (_body, args) => ({ outcome: 'unavailable', resource: args.resource }),
        },
      },
    });
    await expect(result).resolves.toEqual({ outcome: 'unavailable', resource: 'r1' });
    expect(reportOutcome).toHaveBeenCalledExactlyOnceWith({ outcome: 'unknown' });
    expect(calls).toBe(1);
  });

  it('allows selected parsed fields and explicit rejected evidence only', async () => {
    const { result, reportOutcome } = invoke({
      responses: {
        '409': {
          mapResponse: (body) => ({ outcome: (body as { reason: string }).reason }),
          evidence: () => ({ outcome: 'rejected', reference: 'known-reference' }),
        },
      },
    });
    await expect(result).resolves.toEqual({ outcome: 'duplicate' });
    expect(reportOutcome).toHaveBeenCalledExactlyOnceWith({
      outcome: 'rejected',
      reference: 'known-reference',
    });
  });

  it('preserves normal success mappings', async () => {
    const { result, reportOutcome } = invoke({ path: '/200' });
    await expect(result).resolves.toEqual({ outcome: 'success' });
    expect(reportOutcome).toHaveBeenCalledExactlyOnceWith({ outcome: 'completed' });
  });

  it('retains 204 success and selects a JSON mapping for an empty-mode operation error', async () => {
    const responses = {
      '410': {
        responseType: 'json' as const,
        mapResponse: () => ({ outcome: 'gone' }),
        evidence: () => ({ outcome: 'rejected' as const }),
      },
    };
    const success = invoke({ path: '/204', responseType: 'empty', responses });
    await expect(success.result).resolves.toEqual({ outcome: 'success' });
    const gone = invoke({ path: '/410', responseType: 'empty', responses });
    await expect(gone.result).resolves.toEqual({ outcome: 'gone' });
  });

  it.each([401, 403, 404, 429, 500])('keeps undeclared %s as a failure', async (status) => {
    const { result, reportOutcome } = invoke({ path: `/${status}` });
    await expect(result).rejects.toMatchObject({ status });
    expect(reportOutcome).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });

  it('does not retry a mapped status or an action transport failure', async () => {
    const mapped = invoke({
      responses: { '409': { mapResponse: () => ({ outcome: 'conflict' }) } },
      resilience: { retry: { maxAttempts: 3, baseDelayMs: 0 } },
    });
    await expect(mapped.result).resolves.toEqual({ outcome: 'conflict' });
    expect(calls).toBe(1);
    const failed = invoke({
      path: '/500',
      resilience: { retry: { maxAttempts: 3, baseDelayMs: 0 } },
    });
    await expect(failed.result).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(2);
  });

  it('fails closed on malformed JSON without returning provider diagnostics', async () => {
    const { result, reportOutcome } = invoke({
      path: '/409/invalid',
      responses: { '409': { mapResponse: () => ({ outcome: 'conflict' }) } },
    });
    await expect(result).rejects.toMatchObject({ category: 'invalid_response' });
    expect(reportOutcome).not.toHaveBeenCalled();
  });

  it.each(['', '/declared'])('enforces byte limits on declared errors %s', async (mode) => {
    const { result, reportOutcome } = invoke({
      path: `/409${mode}`,
      maxResponseBytes: 10,
      responses: { '409': { mapResponse: () => ({ outcome: 'conflict' }) } },
    });
    await expect(result).rejects.toMatchObject({ category: 'response_too_large' });
    expect(reportOutcome).not.toHaveBeenCalled();
  });

  it('never follows redirects', async () => {
    const { result } = invoke({ path: '/302' });
    await expect(result).rejects.toMatchObject({ status: 302, category: 'invalid_response' });
    expect(calls).toBe(1);
  });

  it('does not report success when response mapping fails', async () => {
    const { result, reportOutcome } = invoke({
      responses: {
        '409': {
          mapResponse: () => {
            throw new Error('mapping failed');
          },
          evidence: () => ({ outcome: 'rejected' }),
        },
      },
    });
    await expect(result).rejects.toThrow('mapping failed');
    expect(reportOutcome).not.toHaveBeenCalled();
  });

  it.each([
    '200',
    '302',
    '401',
    '403',
    '429',
    '500',
    '4xx',
  ])('rejects unsupported status %s at construction', (status) => {
    expect(() => invoke({ responses: { [status]: { mapResponse: () => ({}) } } })).toThrow(
      'response status',
    );
    expect(calls).toBe(0);
  });
});
