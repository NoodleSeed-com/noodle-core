import { compileManifest } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { server, tool, z } from '../src/index.js';

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
