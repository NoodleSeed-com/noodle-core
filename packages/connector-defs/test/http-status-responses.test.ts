import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { compileConnectors } from '../src/index.js';

const output = {
  type: 'object',
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
  required: ['status'],
  additionalProperties: false,
};
function definition(overrides: Record<string, unknown> = {}, baseUrl = 'https://example.com') {
  return JSON.stringify({
    connectors: [
      {
        id: 'provider',
        version: '1.0.0',
        http: { baseUrl },
        operations: {
          update: {
            type: 'action',
            method: 'PATCH',
            path: '/resource',
            output,
            response: { status: 'ok' },
            evidence: { outcome: 'completed' },
            responses: {
              '412': {
                response: { status: 'conflict', reason: '${response.error.reason}' },
                evidence: { outcome: 'rejected' },
              },
            },
            ...overrides,
          },
        },
      },
    ],
  });
}

describe('HTTP status response catalog compilation', () => {
  it('compiles expected provider responses into typed operation outcomes and evidence', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(412, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { reason: 'conditionNotMet', message: 'private diagnostic' } }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const compiled = compileConnectors(
        definition({}, `http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      );
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
      const connector = compiled.connectors[0];
      if (!connector) throw new Error('Missing connector');
      const reportOutcome = vi.fn();
      await expect(
        connector.invoke({
          operation: 'update',
          args: {},
          credential: { token: '' },
          reportOutcome,
        }),
      ).resolves.toEqual({ status: 'conflict', reason: 'conditionNotMet' });
      expect(reportOutcome).toHaveBeenCalledExactlyOnceWith({ outcome: 'rejected' });
      expect(connector.signature('update')?.output).toEqual(output);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    '200',
    '302',
    '401',
    '403',
    '429',
    '500',
    '4xx',
    '0409',
  ])('rejects forbidden status %s', (status) => {
    expect(
      compileConnectors(definition({ responses: { [status]: { response: { status: 'error' } } } }))
        .ok,
    ).toBe(false);
  });

  it.each([
    'completed',
    'accepted',
    '${response.outcome}',
  ])('rejects invalid rejection evidence %s', (outcome) => {
    expect(
      compileConnectors(
        definition({
          responses: { '409': { response: { status: 'error' }, evidence: { outcome } } },
        }),
      ).ok,
    ).toBe(false);
  });

  it('requires an explicit response projection', () => {
    expect(
      compileConnectors(definition({ responses: { '409': { evidence: { outcome: 'rejected' } } } }))
        .ok,
    ).toBe(false);
  });

  it.each([
    '${env.SECRET}',
    '${execution.id}',
    '${secrets.token}',
  ])('rejects forbidden mapping root %s', (status) => {
    expect(
      compileConnectors(definition({ responses: { '409': { response: { status } } } })).ok,
    ).toBe(false);
  });

  it('rejects pagination combined with per-status responses', () => {
    expect(
      compileConnectors(
        definition({
          type: 'read',
          method: 'GET',
          pagination: {
            kind: 'cursor',
            cursorParam: 'cursor',
            items: '${response.items}',
            nextCursor: '${response.next}',
          },
        }),
      ).ok,
    ).toBe(false);
  });

  it('keeps action retries invalid even for explicitly handled statuses', () => {
    expect(compileConnectors(definition({ resilience: { retry: { maxAttempts: 3 } } })).ok).toBe(
      false,
    );
  });
});
