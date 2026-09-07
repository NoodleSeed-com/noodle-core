import { describe, expect, it } from 'vitest';
import { connectorFileSchema } from '../src/index.js';

const MAX_AUTHORED_RESPONSE_BYTES = 6 * 1024 * 1024;

function connectorFile(maxResponseBytes: unknown): unknown {
  return {
    connectors: [
      {
        id: 'large_api',
        version: '1.0.0',
        http: { baseUrl: 'https://api.example.com' },
        operations: {
          fetch: {
            type: 'read',
            method: 'GET',
            path: '/large',
            limits: { maxResponseBytes },
          },
        },
      },
    ],
  };
}

describe('HTTP operation response-size limits', () => {
  it.each([
    1,
    MAX_AUTHORED_RESPONSE_BYTES,
  ])('accepts the positive safe-integer limit %i', (maxResponseBytes) => {
    expect(connectorFileSchema.safeParse(connectorFile(maxResponseBytes)).success).toBe(true);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not-a-number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['above the policy maximum', MAX_AUTHORED_RESPONSE_BYTES + 1],
  ])('rejects a %s response-size limit', (_label, maxResponseBytes) => {
    expect(connectorFileSchema.safeParse(connectorFile(maxResponseBytes)).success).toBe(false);
  });

  it('rejects unknown HTTP limit keys', () => {
    const candidate = connectorFile(MAX_AUTHORED_RESPONSE_BYTES) as {
      connectors: Array<{
        operations: { fetch: { limits: Record<string, unknown> } };
      }>;
    };
    const firstConnector = candidate.connectors[0];
    if (firstConnector === undefined) throw new Error('expected connector fixture');
    firstConnector.operations.fetch.limits.maxOutputBytes = 1;

    expect(connectorFileSchema.safeParse(candidate).success).toBe(false);
  });
});
