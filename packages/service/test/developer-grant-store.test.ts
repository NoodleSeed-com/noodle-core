import { describe, expect, it } from 'vitest';

import { activeDeveloperGrant, InMemoryDeveloperGrantStore } from '../src/oauth/developer-grant.js';

const NOW = '2026-07-17T12:00:00.000Z';
const CLI_RESOURCE = 'https://cloud.noodleseed.com/developer/cli';
const MCP_RESOURCE = 'https://cloud.noodleseed.com/developer/mcp';

function input() {
  return {
    clientId: 'client-1',
    subject: 'developer@example.com',
    resource: CLI_RESOURCE,
    capabilities: ['deployments:write', 'cloud:read', 'cloud:read'] as const,
  };
}

describe('InMemoryDeveloperGrantStore', () => {
  it('creates normalized immutable live-user grants and returns defensive copies', async () => {
    const store = new InMemoryDeveloperGrantStore({
      now: () => NOW,
      id: () => 'grant-1',
    });

    const created = await store.getOrCreateActive(input());
    expect(created).toEqual({
      version: 2,
      id: 'grant-1',
      clientId: 'client-1',
      subject: 'developer@example.com',
      resource: CLI_RESOURCE,
      accessModel: 'live_user',
      capabilities: ['cloud:read', 'deployments:write'],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const firstRead = await store.get('grant-1');
    expect(firstRead).toEqual(created);
    expect(firstRead).not.toBe(created);
    expect(firstRead?.capabilities).not.toBe(created.capabilities);
  });

  it('reuses one active grant for the exact client, subject, and resource tuple', async () => {
    let nextId = 0;
    const store = new InMemoryDeveloperGrantStore({
      now: () => NOW,
      id: () => `grant-${++nextId}`,
    });

    const first = await store.getOrCreateActive(input());
    const repeated = await store.getOrCreateActive({
      ...input(),
      capabilities: ['cloud:read', 'deployments:write'],
    });
    const otherResource = await store.getOrCreateActive({
      ...input(),
      resource: MCP_RESOURCE,
      capabilities: ['cloud:read'],
    });

    expect(repeated.id).toBe(first.id);
    expect(otherResource.id).not.toBe(first.id);
    await expect(
      store.getActive({
        clientId: 'client-1',
        subject: 'developer@example.com',
        resource: CLI_RESOURCE,
      }),
    ).resolves.toMatchObject({ id: first.id });
  });

  it('creates a new active grant after revocation without reviving the old grant ID', async () => {
    let nextId = 0;
    const store = new InMemoryDeveloperGrantStore({
      now: () => NOW,
      id: () => `grant-${++nextId}`,
    });
    const first = await store.getOrCreateActive(input());
    await store.revoke(first.id, '2026-07-17T13:00:00.000Z');

    const replacement = await store.getOrCreateActive(input());

    expect(replacement.id).toBe('grant-2');
    await expect(store.get(first.id)).resolves.toMatchObject({
      id: first.id,
      revokedAt: '2026-07-17T13:00:00.000Z',
    });
  });

  it('rejects unsupported resources and empty capabilities', async () => {
    const store = new InMemoryDeveloperGrantStore({ now: () => NOW, id: () => 'grant-1' });

    await expect(
      store.getOrCreateActive({ ...input(), resource: 'https://cloud.noodleseed.com/' }),
    ).rejects.toThrow('invalid developer resource');
    await expect(
      store.getOrCreateActive({ ...input(), resource: `${CLI_RESOURCE}?unexpected=scope` }),
    ).rejects.toThrow('invalid developer resource');
    await expect(
      store.getOrCreateActive({ ...input(), resource: `${CLI_RESOURCE}/` }),
    ).rejects.toThrow('invalid developer resource');
    await expect(store.getOrCreateActive({ ...input(), capabilities: [] })).rejects.toThrow(
      'at least one capability',
    );
  });

  it('revokes idempotently while preserving the first timestamp', async () => {
    const store = new InMemoryDeveloperGrantStore({ now: () => NOW, id: () => 'grant-1' });
    await store.getOrCreateActive(input());

    const revoked = await store.revoke('grant-1', '2026-07-17T13:00:00.000Z');
    const repeated = await store.revoke('grant-1', '2026-07-17T14:00:00.000Z');

    expect(revoked?.revokedAt).toBe('2026-07-17T13:00:00.000Z');
    expect(repeated?.revokedAt).toBe('2026-07-17T13:00:00.000Z');
    expect(repeated?.updatedAt).toBe('2026-07-17T13:00:00.000Z');
    await expect(store.revoke('missing', NOW)).resolves.toBeUndefined();
  });

  it('requires an active grant with the exact subject, OAuth client, and resource', async () => {
    const store = new InMemoryDeveloperGrantStore({ now: () => NOW, id: () => 'grant-1' });
    const grant = await store.getOrCreateActive({
      ...input(),
      expiresAt: '2026-07-17T13:00:00.000Z',
    });

    expect(
      activeDeveloperGrant(grant, {
        subject: 'developer@example.com',
        clientId: 'client-1',
        resource: CLI_RESOURCE,
        at: NOW,
      }),
    ).toBe(true);
    for (const mismatch of [
      { subject: 'other@example.com', clientId: 'client-1', resource: CLI_RESOURCE },
      { subject: 'developer@example.com', clientId: 'other-client', resource: CLI_RESOURCE },
      { subject: 'developer@example.com', clientId: 'client-1', resource: MCP_RESOURCE },
    ]) {
      expect(activeDeveloperGrant(grant, { ...mismatch, at: NOW })).toBe(false);
    }
    expect(
      activeDeveloperGrant(grant, {
        subject: 'developer@example.com',
        clientId: 'client-1',
        resource: CLI_RESOURCE,
        at: '2026-07-17T13:00:00.000Z',
      }),
    ).toBe(false);
  });
});
