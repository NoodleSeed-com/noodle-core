import { describe, expect, it } from 'vitest';
import { connectorFileSchema } from '../src/index.js';

function operation(overrides: Record<string, unknown> = {}) {
  return {
    type: 'read',
    method: 'POST',
    path: '/search',
    requestEncoding: 'form-urlencoded',
    request: { 'from airport id': '${args.from}' },
    ...overrides,
  };
}

function catalog(search: Record<string, unknown>) {
  return {
    connectors: [
      {
        id: 'search_api',
        version: '1.0.0',
        kind: 'custom',
        http: { baseUrl: 'https://api.example.test' },
        operations: { search },
      },
    ],
  };
}

describe('form-urlencoded connector definition', () => {
  it('accepts a non-GET operation with a request mapping', () => {
    expect(connectorFileSchema.safeParse(catalog(operation())).success).toBe(true);
  });

  it('rejects form encoding for GET operations', () => {
    const parsed = connectorFileSchema.safeParse(catalog(operation({ method: 'GET' })));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['connectors', 0, 'operations', 'search', 'requestEncoding'],
      }),
    );
  });

  it('rejects form encoding without a request mapping', () => {
    const candidate = operation();
    delete candidate.request;
    const parsed = connectorFileSchema.safeParse(catalog(candidate));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({ path: ['connectors', 0, 'operations', 'search', 'request'] }),
    );
  });
});
