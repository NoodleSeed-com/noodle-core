import { describe, expect, it } from 'vitest';
import { compileConnectors, connectorFileSchema } from '../src/index.js';

const emptyObject = { type: 'object', properties: {}, additionalProperties: false };

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    connectors: [
      {
        id: 'mail',
        version: '1.0.0',
        kind: 'catalog',
        credentialProfiles: {
          delegated: { kind: 'bearer' },
          service: { kind: 'bearer' },
        },
        http: { baseUrl: 'https://mail.example.com' },
        operations: {
          search: {
            type: 'read',
            path: '/messages',
            input: emptyObject,
            output: emptyObject,
            credentials: {
              profiles: ['delegated'],
              scopes: ['mail.read'],
              audience: 'https://mail.example.com',
            },
          },
        },
        ...overrides,
      },
    ],
  };
}

describe('connector credential profiles', () => {
  it('parses named profiles and compiles operation credential requirements outside signatures', () => {
    const result = compileConnectors(JSON.stringify(catalog()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.catalog[0]).toMatchObject({
      credentialProfiles: {
        delegated: { kind: 'bearer' },
        service: { kind: 'bearer' },
      },
      operationCredentials: {
        search: {
          profiles: ['delegated'],
          scopes: ['mail.read'],
          audience: 'https://mail.example.com',
        },
      },
    });
    expect(result.catalog[0]?.operations.search).not.toHaveProperty('credentials');
  });

  it('rejects an operation requirement that names an undeclared profile', () => {
    const raw = catalog({
      credentialProfiles: { delegated: { kind: 'bearer' } },
    });
    (
      raw.connectors[0] as { operations: { search: { credentials: { profiles: string[] } } } }
    ).operations.search.credentials.profiles = ['missing'];

    const parsed = connectorFileSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['connectors', 0, 'operations', 'search', 'credentials', 'profiles', 0],
        message: expect.stringContaining('undeclared credential profile'),
      }),
    );
  });

  it('rejects credential and account values in profile declarations', () => {
    for (const forbidden of [
      { token: 'forbidden' },
      { account: 'forbidden' },
      { secret: 'forbidden' },
    ]) {
      const raw = catalog({ credentialProfiles: { delegated: { kind: 'bearer', ...forbidden } } });
      expect(connectorFileSchema.safeParse(raw).success).toBe(false);
    }
  });
});
