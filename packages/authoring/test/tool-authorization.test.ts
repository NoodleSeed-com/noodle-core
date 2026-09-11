import { compileManifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { server, type ToolAuthorizationOptions, tool, z } from '../src/index.js';

describe('tool authorization authoring', () => {
  it('emits unrestricted, scope-only, role-only, and combined declarations through Core v2', async () => {
    const app = server('support_portal', { title: 'Support Portal', version: '1.0.0' }, [
      authoredTool('public_status'),
      authoredTool('read_orders', { requiredScopes: ['orders:read'] }),
      authoredTool('triage_orders', { allowedRoles: ['support', 'admin'] }),
      authoredTool('refund_order', {
        requiredScopes: ['orders:refund'],
        allowedRoles: ['support', 'admin'],
      }),
    ]);

    const manifest = await app.toManifest();

    expect(manifest.tools.map(({ name, authorization }) => ({ name, authorization }))).toEqual([
      { name: 'public_status', authorization: undefined },
      { name: 'read_orders', authorization: { requiredScopes: ['orders:read'] } },
      { name: 'triage_orders', authorization: { allowedRoles: ['support', 'admin'] } },
      {
        name: 'refund_order',
        authorization: {
          requiredScopes: ['orders:refund'],
          allowedRoles: ['support', 'admin'],
        },
      },
    ]);
  });

  it('preserves public discovery and normalizes authorized discovery to omission', async () => {
    const emit = (discovery?: 'authorized' | 'public') =>
      server('support_portal', { title: 'Support Portal', version: '1.0.0' }, [
        authoredTool('read_orders', {
          requiredScopes: ['orders:read'],
          ...(discovery === undefined ? {} : { discovery }),
        }),
      ]).toManifest();
    expect(await emit('authorized')).toEqual(await emit());
    expect((await emit('public')).tools[0]?.authorization).toEqual({
      requiredScopes: ['orders:read'],
      discovery: 'public',
    });
  });

  it.each([
    { discovery: 'public' },
    { discovery: 'public', requiredScopes: [] },
    { discovery: 'everyone', allowedRoles: ['support'] },
    { discover: 'public', allowedRoles: ['support'] },
    { securitySchemes: [{ type: 'noauth' }], allowedRoles: ['support'] },
  ])('does not erase invalid authorization before compiler validation %j', async (authorization) => {
    const app = server('support_portal', { title: 'Support Portal', version: '1.0.0' }, [
      authoredTool('read_orders', authorization as ToolAuthorizationOptions),
    ]);
    expect(compileManifest(await app.toManifest()).ok).toBe(false);
  });

  it('retains existing emitted bytes when callers declare role keys before scopes', async () => {
    const app = server('support_portal', { title: 'Support Portal', version: '1.0.0' }, [
      authoredTool('read_orders', { allowedRoles: ['support'], requiredScopes: ['orders:read'] }),
    ]);
    expect(JSON.stringify((await app.toManifest()).tools[0]?.authorization)).toBe(
      '{"requiredScopes":["orders:read"],"allowedRoles":["support"]}',
    );
  });

  it('rejects raw securitySchemes at the authoring boundary', () => {
    expect(() =>
      tool('read_orders', {
        description: 'Read orders.',
        input: z.object({}),
        fulfil: () => ({ ok: true }),
        ...{ securitySchemes: [{ type: 'noauth' }] },
      }),
    ).toThrow(/securitySchemes/);
  });

  it('compiles authored authorization into a canonical runtime artifact', async () => {
    const app = server('support_portal', { title: 'Support Portal', version: '1.0.0' }, [
      authoredTool('refund_order', {
        requiredScopes: [' orders:write ', 'orders:read', 'orders:write'],
        allowedRoles: [' support ', 'admin', 'support'],
      }),
    ]);

    const result = compileManifest(await app.toManifest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools[0]?.authorization).toEqual({
      requiredScopes: ['orders:read', 'orders:write'],
      allowedRoles: ['admin', 'support'],
    });
  });
});

function authoredTool(
  name: string,
  authorization?: {
    readonly discovery?: 'authorized' | 'public';
    readonly requiredScopes?: readonly string[];
    readonly allowedRoles?: readonly string[];
  },
) {
  return tool(name, {
    description: `Run ${name}.`,
    ...(authorization === undefined ? {} : { authorization }),
    input: z.object({}),
    fulfil: () => ({ ok: true }),
  });
}
