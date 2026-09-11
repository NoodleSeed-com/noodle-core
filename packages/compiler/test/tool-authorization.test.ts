import { readFileSync } from 'node:fs';
import { validateJsonSchema } from '@noodle-borg/app-package';
import { describe, expect, it } from 'vitest';
import { compileAppPackage, compileManifest, manifestSchema } from '../src/index.js';

describe('tool authorization manifest contract', () => {
  it.each([
    { requiredScopes: ['orders:read'] },
    { allowedRoles: ['support'] },
    { requiredScopes: ['orders:read'], allowedRoles: ['support'] },
  ])('accepts the declaration %j', (authorization) => {
    expect(compileManifest(manifestWith(authorization)).ok).toBe(true);
  });

  it('cannot silently send public discovery to the older strict manifest authorization schema', () => {
    const oldSchema = JSON.parse(
      readFileSync(
        new URL('./fixtures/tool-authorization-pre-discovery.schema.json', import.meta.url),
        'utf8',
      ),
    );
    expect(validateJsonSchema(oldSchema, { requiredScopes: ['orders:read'] })).toEqual([]);
    expect(
      validateJsonSchema(oldSchema, { requiredScopes: ['orders:read'], discovery: 'public' })
        .length,
    ).toBeGreaterThan(0);
  });

  it('normalizes authorized discovery without changing artifact or package identity', () => {
    const compile = (discovery?: 'authorized' | 'public') =>
      compileManifest(
        manifestWith({
          requiredScopes: ['orders:read'],
          ...(discovery === undefined ? {} : { discovery }),
        }),
      );
    const implicit = compile();
    const authorized = compile('authorized');
    const publicDiscovery = compile('public');
    expect(implicit.ok && authorized.ok && publicDiscovery.ok).toBe(true);
    if (!implicit.ok || !authorized.ok || !publicDiscovery.ok) return;
    expect(authorized.artifact).toEqual(implicit.artifact);
    expect(authorized.appPackage).toEqual(implicit.appPackage);
    expect(publicDiscovery.artifact.tools[0]?.authorization).toEqual({
      requiredScopes: ['orders:read'],
      discovery: 'public',
    });
    expect(publicDiscovery.appPackage?.surface.tools[0]?.authorization).toEqual({
      requiredScopes: ['orders:read'],
      discovery: 'public',
    });
    expect(publicDiscovery.appPackage?.provenance.mcpSurfaceSha256).not.toBe(
      implicit.appPackage?.provenance.mcpSurfaceSha256,
    );
    expect(publicDiscovery.appPackage?.provenance.sourceManifestSha256).not.toBe(
      implicit.appPackage?.provenance.sourceManifestSha256,
    );
  });

  it('normalizes explicit authorized discovery for the standalone App Package projection', () => {
    const implicit = manifestSchema.parse(manifestWith({ requiredScopes: ['orders:read'] }));
    const compiled = compileManifest(implicit);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const explicit = {
      ...implicit,
      tools: implicit.tools.map((tool) => ({
        ...tool,
        authorization: { ...tool.authorization, discovery: 'authorized' as const },
      })),
    };
    const projected = compileAppPackage({
      manifest: explicit,
      sourceManifest: explicit,
      artifact: compiled.artifact,
    });
    expect(projected.errors).toEqual([]);
    expect(projected.appPackage).toEqual(compiled.appPackage);
  });

  it('rejects raw tool securitySchemes injection', () => {
    const manifest = manifestWith(undefined);
    expect(
      compileManifest({
        ...manifest,
        tools: manifest.tools.map((tool) => ({ ...tool, securitySchemes: [{ type: 'noauth' }] })),
      }).ok,
    ).toBe(false);
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
    ['public discovery without a rule', { discovery: 'public' }],
    ['public discovery with an empty rule', { discovery: 'public', requiredScopes: [] }],
    ['an unknown discovery mode', { discovery: 'everyone', requiredScopes: ['orders:read'] }],
    ['a misspelled discovery key', { discover: 'public', requiredScopes: ['orders:read'] }],
    [
      'raw security schemes',
      { securitySchemes: [{ type: 'noauth' }], requiredScopes: ['orders:read'] },
    ],
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
    server: {
      name: 'support_portal',
      title: 'Support Portal',
      version: '1.0.0',
      agentGuide: {
        description: 'Review orders.',
        useWhen: ['The user asks about orders.'],
        workflows: [
          {
            id: 'review_orders',
            title: 'Review orders',
            steps: [{ capability: { kind: 'tool', name: 'refund_order' } }],
          },
        ],
      },
    },
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
