import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type ControlPlaneIdentity,
  type DeployAuthGate,
  InMemoryControlPlaneStore,
  NoodleOAuthControlPlaneGate,
} from '@noodle-borg/control-plane/portable';
import {
  DEVELOPER_ASSISTANT_PATH,
  DEVELOPER_CLI_PATH,
  DEVELOPER_MCP_PATH,
  type DeveloperCapability,
} from '@noodle-borg/developer-mcp';
import { describe, expect, it } from 'vitest';
import {
  authorizeDeveloperGrant,
  type DeveloperGrantAuthorizationContext,
} from '../src/auth/developer-grant-guard.js';
import { InMemoryDeveloperGrantStore } from '../src/oauth/developer-grant.js';
import { authorizeControlPlane } from '../src/routes/control-plane.js';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const AUTHORIZED_AT = '2026-01-01T12:00:00.000Z';
const CLOUD_ORIGIN = 'https://cloud.noodleseed.com';
const identity: ControlPlaneIdentity = {
  subject: 'subject-1',
  email: 'developer@noodleseed.com',
  superAdmin: false,
  developerGrantId: 'grant-1',
  oauthClientId: 'client-1',
};

describe('authorizeDeveloperGrant', () => {
  it('uses live membership for every current organization', async () => {
    const fixture = await grantFixture();

    await expect(authorizeDeveloperGrant(identity, fixture.context)).resolves.toBe(true);

    await fixture.controlPlane.addOrgMember({
      org: 'second-org',
      subject: identity.subject,
      email: identity.email,
      role: 'developer',
    });
    await expect(
      authorizeDeveloperGrant(identity, { ...fixture.context, org: 'second-org' }),
    ).resolves.toBe(true);

    await expect(
      authorizeDeveloperGrant(identity, { ...fixture.context, org: 'not-a-member' }),
    ).resolves.toBe(false);
    await expect(
      authorizeDeveloperGrant(identity, {
        ...fixture.context,
        capability: 'deployments:rollback',
      }),
    ).resolves.toBe(false);

    await fixture.controlPlane.removeOrgMember({ org: 'acme', subject: identity.subject });
    await expect(authorizeDeveloperGrant(identity, fixture.context)).resolves.toBe(false);
  });

  it('applies live role changes without reconnecting and reserves rollback for owners', async () => {
    const fixture = await grantFixture({
      resourcePath: DEVELOPER_MCP_PATH,
      capabilities: ['cloud:read', 'deployments:rollback'],
      role: 'owner',
    });
    const rollback = { ...fixture.context, capability: 'deployments:rollback' as const };

    await expect(authorizeDeveloperGrant(identity, rollback)).resolves.toBe(true);
    await fixture.controlPlane.updateOrgMemberRole({
      org: 'acme',
      subject: identity.subject,
      role: 'developer',
    });
    await expect(authorizeDeveloperGrant(identity, rollback)).resolves.toBe(false);
    await expect(
      authorizeDeveloperGrant(identity, { ...rollback, capability: 'cloud:read' }),
    ).resolves.toBe(true);

    await fixture.controlPlane.updateOrgMemberRole({
      org: 'acme',
      subject: identity.subject,
      role: 'owner',
    });
    await expect(authorizeDeveloperGrant(identity, rollback)).resolves.toBe(true);
  });

  it('keeps CLI and MCP grants separate even when they share a capability', async () => {
    const fixture = await grantFixture({
      resourcePath: DEVELOPER_MCP_PATH,
      capabilities: ['cloud:read', 'deployments:rollback'],
    });

    await expect(authorizeDeveloperGrant(identity, fixture.context)).resolves.toBe(true);
    await expect(
      authorizeDeveloperGrant(identity, {
        ...fixture.context,
        resourcePaths: new Set([DEVELOPER_CLI_PATH]),
      }),
    ).resolves.toBe(false);
  });

  it('admits an assistant-resource grant to routes serving that resource, never beyond its ceiling', async () => {
    const fixture = await grantFixture({
      resourcePath: DEVELOPER_ASSISTANT_PATH,
      capabilities: ['cloud:read', 'deployments:write'],
    });
    const controlPlaneRoutes = {
      ...fixture.context,
      resourcePaths: new Set([DEVELOPER_CLI_PATH, DEVELOPER_ASSISTANT_PATH]),
    };

    await expect(authorizeDeveloperGrant(identity, controlPlaneRoutes)).resolves.toBe(true);
    await expect(
      authorizeDeveloperGrant(identity, {
        ...controlPlaneRoutes,
        capability: 'deployments:write',
      }),
    ).resolves.toBe(true);
    await expect(
      authorizeDeveloperGrant(identity, {
        ...controlPlaneRoutes,
        capability: 'deployments:rollback',
      }),
    ).resolves.toBe(false);
    await expect(
      authorizeDeveloperGrant(identity, {
        ...controlPlaneRoutes,
        capability: 'config:write',
      }),
    ).resolves.toBe(false);
    await expect(
      authorizeDeveloperGrant(identity, {
        ...fixture.context,
        resourcePaths: new Set([DEVELOPER_CLI_PATH]),
      }),
    ).resolves.toBe(false);
  });

  it('denies missing, revoked, expired, mismatched, and incomplete grant-bound identities', async () => {
    const missing = await grantFixture({ id: 'other-grant' });
    await expect(authorizeDeveloperGrant(identity, missing.context)).resolves.toBe(false);

    const revoked = await grantFixture();
    await revoked.grants.revoke('grant-1', AUTHORIZED_AT);
    await expect(authorizeDeveloperGrant(identity, revoked.context)).resolves.toBe(false);

    const expired = await grantFixture({ expiresAt: '2026-01-01T06:00:00.000Z' });
    await expect(authorizeDeveloperGrant(identity, expired.context)).resolves.toBe(false);

    await expect(
      authorizeDeveloperGrant({ ...identity, subject: 'other' }, expired.context),
    ).resolves.toBe(false);
    await expect(
      authorizeDeveloperGrant({ ...identity, oauthClientId: undefined }, expired.context),
    ).resolves.toBe(false);
    await expect(
      authorizeDeveloperGrant({ ...identity, developerGrantId: undefined }, expired.context),
    ).resolves.toBe(false);
  });

  it('does not let super-admin status widen a developer grant', async () => {
    const fixture = await grantFixture();
    await fixture.controlPlane.removeOrgMember({ org: 'acme', subject: identity.subject });

    await expect(
      authorizeDeveloperGrant({ ...identity, superAdmin: true }, fixture.context),
    ).resolves.toBe(false);
  });
});

describe('control-plane grant boundary', () => {
  it('carries the verified grant/client claims through the Noodle OAuth gate', async () => {
    const gate = new NoodleOAuthControlPlaneGate({
      audience: CLOUD_ORIGIN,
      admins: [],
      verifier: async () => ({
        subject: identity.subject,
        email: identity.email,
        developerGrantId: identity.developerGrantId,
        oauthClientId: identity.oauthClientId,
      }),
    });
    await expect(gate.authorize(request())).resolves.toMatchObject({ ok: true, identity });
  });

  it('accepts a pinned developer resource audience without widening route authorization', async () => {
    const audiences: string[] = [];
    const gate = new NoodleOAuthControlPlaneGate({
      audience: [
        CLOUD_ORIGIN,
        `${CLOUD_ORIGIN}${DEVELOPER_MCP_PATH}`,
        `${CLOUD_ORIGIN}${DEVELOPER_CLI_PATH}`,
      ],
      admins: [],
      verifier: async (_token, audience) => {
        audiences.push(audience);
        return audience.endsWith(DEVELOPER_CLI_PATH)
          ? {
              subject: identity.subject,
              email: identity.email,
              developerGrantId: identity.developerGrantId,
              oauthClientId: identity.oauthClientId,
            }
          : null;
      },
    });
    await expect(gate.authorize(request())).resolves.toMatchObject({ ok: true, identity });
    expect(audiences).toEqual([
      CLOUD_ORIGIN,
      `${CLOUD_ORIGIN}${DEVELOPER_MCP_PATH}`,
      `${CLOUD_ORIGIN}${DEVELOPER_CLI_PATH}`,
    ]);
  });

  it('never projects super-admin authority onto a grant-bound OAuth identity', async () => {
    const gate = new NoodleOAuthControlPlaneGate({
      audience: `${CLOUD_ORIGIN}${DEVELOPER_CLI_PATH}`,
      admins: [identity.email],
      verifier: async () => ({
        subject: identity.subject,
        email: identity.email,
        developerGrantId: identity.developerGrantId,
        oauthClientId: identity.oauthClientId,
      }),
    });

    await expect(gate.authorize(request())).resolves.toMatchObject({
      ok: true,
      identity: { developerGrantId: 'grant-1', superAdmin: false },
    });
  });

  it('denies grant-bound identities by default and permits an explicit route context', async () => {
    const fixture = await grantFixture();
    const gate: DeployAuthGate = { authorize: async () => ({ ok: true, identity }) };
    const denied = response();
    await expect(
      authorizeControlPlane(request(), denied.res, gate, { requireIdentity: true }),
    ).resolves.toBe(false);
    expect(denied.status()).toBe(403);

    const allowed = response();
    await expect(
      authorizeControlPlane(request(), allowed.res, gate, {
        requireIdentity: true,
        developerAccess: fixture.context,
      }),
    ).resolves.toEqual(identity);
    expect(allowed.status()).toBeUndefined();
  });

  it('admits a grant-bound identity to an explicitly grant-independent route', async () => {
    const gate: DeployAuthGate = { authorize: async () => ({ ok: true, identity }) };
    const allowed = response();
    await expect(
      authorizeControlPlane(request(), allowed.res, gate, {
        requireIdentity: true,
        developerAccess: 'grant-independent',
      }),
    ).resolves.toEqual(identity);
    expect(allowed.status()).toBeUndefined();
  });
});

async function grantFixture(
  options: {
    id?: string;
    expiresAt?: string;
    resourcePath?:
      | typeof DEVELOPER_CLI_PATH
      | typeof DEVELOPER_MCP_PATH
      | typeof DEVELOPER_ASSISTANT_PATH;
    capabilities?: readonly DeveloperCapability[];
    role?: 'owner' | 'developer';
  } = {},
): Promise<{
  grants: InMemoryDeveloperGrantStore;
  controlPlane: InMemoryControlPlaneStore;
  context: DeveloperGrantAuthorizationContext;
}> {
  const resourcePath = options.resourcePath ?? DEVELOPER_CLI_PATH;
  const capabilities = options.capabilities ?? ['cloud:read', 'deployments:write', 'config:write'];
  const grants = new InMemoryDeveloperGrantStore({
    now: () => CREATED_AT,
    id: () => options.id ?? 'grant-1',
  });
  await grants.getOrCreateActive({
    clientId: identity.oauthClientId as string,
    subject: identity.subject,
    resource: `${CLOUD_ORIGIN}${resourcePath}`,
    capabilities,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  });
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: identity.subject,
    email: identity.email,
    role: options.role ?? 'developer',
  });
  return {
    grants,
    controlPlane,
    context: {
      grants,
      controlPlane,
      org: 'acme',
      capability: capabilities[0] as DeveloperCapability,
      resourcePaths: new Set([resourcePath]),
      now: () => AUTHORIZED_AT,
    },
  };
}

function request(): IncomingMessage {
  return { headers: { authorization: 'Bearer token' } } as IncomingMessage;
}

function response(): {
  res: ServerResponse;
  status: () => number | undefined;
} {
  let status: number | undefined;
  return {
    res: {
      writeHead: (value: number) => {
        status = value;
        return undefined as never;
      },
      end: () => undefined,
    } as unknown as ServerResponse,
    status: () => status,
  };
}
