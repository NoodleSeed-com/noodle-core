import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OwnerTokenVerifier } from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeIdentityMode,
  authorizeMixedMode,
  authorizePublicServiceMode,
  type IdentityAuthorizationOptions,
} from '../src/identity-authorization.js';

const SERVICE_CALLER = {
  subject: 'spn_00000000-0000-4000-8000-000000000001',
  scopes: ['todos.read'],
  roles: [],
  identityKind: 'service' as const,
};

describe('service-principal transport authorization', () => {
  it.each([
    'owner-only',
    'org-members',
    'authenticated',
    'customers',
  ] as const)('admits a verified service caller through %s without human/customer checks', async (accessMode) => {
    const authorizeDataPlaneIdentity = vi.fn();
    const result = await authorizeIdentityMode(
      request('Bearer machine-token'),
      {} as ServerResponse,
      options(accessMode, async () => ({ caller: SERVICE_CALLER }), authorizeDataPlaneIdentity),
    );
    expect(result).toEqual({ allow: true, caller: SERVICE_CALLER });
    expect(authorizeDataPlaneIdentity).not.toHaveBeenCalled();
  });

  it('admits a verified service caller through mixed mode', async () => {
    await expect(
      authorizeMixedMode(
        request('Bearer machine-token'),
        {} as ServerResponse,
        options('mixed', async () => ({ caller: SERVICE_CALLER })),
      ),
    ).resolves.toEqual({ allow: true, caller: SERVICE_CALLER });
  });

  it('uses valid service identity on public endpoints but keeps every other bearer anonymous', async () => {
    const service = await authorizePublicServiceMode(
      request('Bearer machine-token'),
      options('public', async () => ({ caller: SERVICE_CALLER })),
    );
    expect(service).toEqual({ allow: true, caller: SERVICE_CALLER });

    for (const verification of [
      null,
      { caller: { subject: 'human-1', scopes: [], roles: [], identityKind: 'platform' as const } },
      {
        caller: { subject: 'customer-1', scopes: [], roles: [], identityKind: 'customer' as const },
      },
    ]) {
      await expect(
        authorizePublicServiceMode(
          request('Bearer optional-token'),
          options('public', async () => verification),
        ),
      ).resolves.toEqual({ allow: true });
    }
    await expect(
      authorizePublicServiceMode(request(), options('public', vi.fn())),
    ).resolves.toEqual({ allow: true });
  });
});

function options(
  accessMode: IdentityAuthorizationOptions['accessMode'],
  verifyOwnerToken: OwnerTokenVerifier,
  authorizeDataPlaneIdentity = vi.fn(),
): IdentityAuthorizationOptions {
  return {
    accessMode,
    ownerSubject: 'human-owner',
    org: 'acme',
    orgMembershipSources: undefined,
    authentication: {
      kind: accessMode === 'customers' ? 'customer' : 'platform',
      verifyToken: verifyOwnerToken,
    },
    authorizeDataPlaneIdentity,
    trustProxy: false,
  };
}

function request(authorization?: string): IncomingMessage {
  return {
    url: '/o/acme/todoist/mcp',
    headers: {
      host: 'cloud.noodleseed.dev',
      ...(authorization === undefined ? {} : { authorization }),
    },
  } as IncomingMessage;
}
