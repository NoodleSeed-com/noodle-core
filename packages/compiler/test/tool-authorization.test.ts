import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/index.js';

describe('tool authorization manifest contract', () => {
  it.each([
    { requiredScopes: ['orders:read'] },
    { allowedRoles: ['support'] },
    { requiredScopes: ['orders:read'], allowedRoles: ['support'] },
  ])('accepts the declaration %j', (authorization) => {
    expect(compileManifest(manifestWith(authorization)).ok).toBe(true);
  });

  it('deduplicates, trims, and sorts the artifact rule deterministically', () => {
    const result = compileManifest(
      manifestWith({
        requiredScopes: [' orders:write ', 'orders:read', 'orders:write'],
        allowedRoles: [' support ', 'admin', 'support'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]?.authorization).toEqual({
      requiredScopes: ['orders:read', 'orders:write'],
      allowedRoles: ['admin', 'support'],
    });
  });

  it('does not add authorization output to existing unrestricted tools', () => {
    const result = compileManifest(manifestWith(undefined));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]).not.toHaveProperty('authorization');
  });

  it.each([
    ['an empty object', {}],
    ['an empty scope list', { requiredScopes: [] }],
    ['an empty role list', { allowedRoles: [] }],
    ['a scope containing spaces', { requiredScopes: ['orders read'] }],
    ['an overlong scope', { requiredScopes: ['s'.repeat(513)] }],
    ['an overlong role', { allowedRoles: ['r'.repeat(201)] }],
    ['too many scopes', { requiredScopes: Array.from({ length: 129 }, (_, i) => `scope:${i}`) }],
    ['too many roles', { allowedRoles: Array.from({ length: 129 }, (_, i) => `role-${i}`) }],
    ['an unknown field', { requiredScopes: ['orders:read'], predicate: 'tenant == acme' }],
  ])('rejects %s', (_label, authorization) => {
    const result = compileManifest(manifestWith(authorization));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_shape',
        path: expect.stringContaining('authorization'),
      }),
    );
  });
});

function manifestWith(authorization: unknown) {
  return {
    manifestVersion: '2',
    server: { name: 'support_portal', title: 'Support Portal', version: '1.0.0' },
    tools: [
      {
        name: 'refund_order',
        description: 'Refund an order.',
        ...(authorization === undefined ? {} : { authorization }),
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  };
}
