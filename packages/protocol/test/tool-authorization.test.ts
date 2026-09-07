import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  evaluateToolAuthorization,
  filterAuthorizedTools,
  TOOL_AUTHORIZATION_DENIED,
} from '../src/index.js';
import { connectClientTo, servedArtifact } from './harness.js';

describe('tool authorization evaluator', () => {
  it('allows an unrestricted tool for an anonymous caller', () => {
    expect(evaluateToolAuthorization(undefined, undefined)).toEqual({ allow: true });
  });

  it('requires every scope and any one role', () => {
    const rule = {
      requiredScopes: ['tickets.read', 'tickets.write'],
      allowedRoles: ['admin', 'support'],
    };
    expect(
      evaluateToolAuthorization(rule, {
        scopes: ['tickets.read', 'tickets.write', 'profile'],
        roles: ['support'],
      }),
    ).toEqual({ allow: true });
    expect(
      evaluateToolAuthorization(rule, {
        scopes: ['tickets.read'],
        roles: ['support'],
      }),
    ).toEqual({
      allow: false,
      reason: 'insufficient_scope',
      requiredScopes: ['tickets.read', 'tickets.write'],
    });
  });

  it('uses role denial precedence without returning configured role names', () => {
    const result = evaluateToolAuthorization(
      {
        requiredScopes: ['tickets.write'],
        allowedRoles: ['admin', 'support'],
      },
      { scopes: [], roles: ['viewer'] },
    );

    expect(result).toEqual({ allow: false, reason: 'role_required' });
    expect(JSON.stringify(result)).not.toContain('admin');
    expect(JSON.stringify(result)).not.toContain('support');
  });

  it('filters tools without changing their artifact order', () => {
    const artifact = authorizationArtifact();
    expect(
      filterAuthorizedTools(artifact.tools, {
        scopes: ['tickets.read'],
        roles: ['viewer'],
      }).map((tool) => tool.name),
    ).toEqual(['public_lookup', 'scoped_lookup']);
  });

  it.each([
    {
      label: 'anonymous',
      caller: undefined,
      expected: ['public_lookup'],
    },
    {
      label: 'scope-only caller',
      caller: { scopes: ['tickets.read'], roles: ['viewer'] },
      expected: ['public_lookup', 'scoped_lookup'],
    },
    {
      label: 'role-only caller',
      caller: { scopes: [], roles: ['admin'] },
      expected: ['public_lookup', 'admin_lookup'],
    },
    {
      label: 'caller satisfying a combined rule',
      caller: { scopes: ['tickets.read', 'tickets.write'], roles: ['support'] },
      expected: ['public_lookup', 'scoped_lookup', 'support_write'],
    },
  ])('filters the public, scope, role, and combined matrix for a $label', ({
    caller,
    expected,
  }) => {
    expect(
      filterAuthorizedTools(authorizationArtifact().tools, caller).map((tool) => tool.name),
    ).toEqual(expected);
  });
});

describe('protocol tool authorization', () => {
  it('filters tools/list per caller and denies a direct call before argument validation', async () => {
    const served = servedArtifact();
    const restricted = {
      ...served,
      artifact: {
        ...served.artifact,
        tools: served.artifact.tools.map((tool) => ({
          ...tool,
          authorization: { requiredScopes: ['orders.read'] },
        })),
      },
    };
    const anonymous = await connectClientTo(restricted);

    await expect(anonymous.listTools()).resolves.toMatchObject({ tools: [] });
    await expect(anonymous.callTool({ name: 'get_order', arguments: {} })).rejects.toMatchObject({
      code: TOOL_AUTHORIZATION_DENIED,
      data: { reason: 'authentication_required' },
    });

    const authorized = await connectClientTo(restricted, {
      caller: { subject: 'customer-1', scopes: ['orders.read'], roles: [] },
    });
    await expect(authorized.listTools()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: 'get_order' })],
    });
  });

  it('keeps unknown tools on the existing invalid-params path', async () => {
    const served = servedArtifact();
    const client = await connectClientTo(
      {
        ...served,
        artifact: {
          ...served.artifact,
          tools: served.artifact.tools.map((tool) => ({
            ...tool,
            authorization: { allowedRoles: ['admin'] },
          })),
        },
      },
      { caller: { subject: 'customer-1', scopes: [], roles: ['viewer'] } },
    );

    await expect(client.callTool({ name: 'unknown', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });
});

function authorizationArtifact(): RuntimeArtifact {
  const served = servedArtifact();
  const base = served.artifact.tools[0];
  if (base === undefined) throw new Error('missing fixture tool');
  return {
    ...served.artifact,
    tools: [
      { ...base, name: 'public_lookup' },
      {
        ...base,
        name: 'scoped_lookup',
        authorization: { requiredScopes: ['tickets.read'] },
      },
      {
        ...base,
        name: 'admin_lookup',
        authorization: { allowedRoles: ['admin'] },
      },
      {
        ...base,
        name: 'support_write',
        authorization: {
          requiredScopes: ['tickets.read', 'tickets.write'],
          allowedRoles: ['support'],
        },
      },
    ],
  };
}
