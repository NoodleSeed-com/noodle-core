import { describe, expect, it } from 'vitest';
import {
  InMemoryMcpSubdomainClaimStore,
  McpSubdomainCooldownError,
  McpSubdomainIdempotencyConflictError,
  McpSubdomainOwnerRequiredError,
  McpSubdomainUnavailableError,
  mcpSubdomainEndpointOptions,
  resolveMcpSubdomainTenant,
} from '../src/index.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');

describe('in-memory MCP subdomain claims', () => {
  it('creates one idempotent default claim for a hosted organization', async () => {
    const store = new InMemoryMcpSubdomainClaimStore(() => NOW);

    const first = store.ensureDefaultMcpSubdomain('arez-internal');
    const second = store.ensureDefaultMcpSubdomain('arez-internal');

    expect(first).toEqual({
      mcpSubdomain: 'arez-internal',
      orgSlug: 'arez-internal',
      claimedAt: NOW.toISOString(),
    });
    expect(second).toEqual(first);
    await expect(store.getActiveMcpSubdomain('arez-internal')).resolves.toEqual(first);
    await expect(store.resolveActiveMcpSubdomain('arez-internal')).resolves.toEqual(first);
  });

  it('excludes the local bootstrap organization and fails closed for unknown labels', async () => {
    const store = new InMemoryMcpSubdomainClaimStore(() => NOW);

    expect(store.ensureDefaultMcpSubdomain('local')).toBeUndefined();
    await expect(store.getActiveMcpSubdomain('local')).resolves.toBeUndefined();
    await expect(store.resolveActiveMcpSubdomain('unknown')).resolves.toBeUndefined();
  });

  it('allows the exact owner to change the default immediately and permanently retires it', async () => {
    let now = NOW;
    const store = new InMemoryMcpSubdomainClaimStore(() => now);
    store.ensureDefaultMcpSubdomain('arez-internal');
    store.ensureDefaultMcpSubdomain('another-org');

    await expect(
      store.changeMcpSubdomain(mutation('arez-internal', 'arez', 'first-change'), async () => true),
    ).resolves.toEqual({
      orgSlug: 'arez-internal',
      previousMcpSubdomain: 'arez-internal',
      mcpSubdomain: 'arez',
      changed: true,
      replayed: false,
      changedAt: NOW.toISOString(),
      changeAllowedAt: '2026-09-10T12:00:00.000Z',
      auditCommitted: false,
    });
    await expect(store.resolveActiveMcpSubdomain('arez-internal')).resolves.toBeUndefined();
    await expect(store.resolveActiveMcpSubdomain('arez')).resolves.toMatchObject({
      orgSlug: 'arez-internal',
    });

    now = new Date('2026-09-10T12:00:00.000Z');
    await expect(
      store.changeMcpSubdomain(
        mutation('another-org', 'arez-internal', 'retired-label'),
        async () => true,
      ),
    ).rejects.toBeInstanceOf(McpSubdomainUnavailableError);
  });

  it('rechecks exact owner authorization inside the serialized mutation', async () => {
    const store = new InMemoryMcpSubdomainClaimStore(() => NOW);
    store.ensureDefaultMcpSubdomain('arez-internal');
    let owner = true;

    const pending = store.changeMcpSubdomain(
      mutation('arez-internal', 'arez', 'owner-recheck'),
      async () => owner,
    );
    owner = false;

    await expect(pending).rejects.toBeInstanceOf(McpSubdomainOwnerRequiredError);
    await expect(store.getActiveMcpSubdomain('arez-internal')).resolves.toMatchObject({
      mcpSubdomain: 'arez-internal',
    });
  });

  it('records no-ops and exact replays without starting or extending cooldown', async () => {
    let now = NOW;
    const store = new InMemoryMcpSubdomainClaimStore(() => now);
    store.ensureDefaultMcpSubdomain('arez-internal');

    const noOp = await store.changeMcpSubdomain(
      mutation('arez-internal', 'arez-internal', 'noop'),
      async () => true,
    );
    expect(noOp).toMatchObject({ changed: false, replayed: false });
    expect(noOp.changedAt).toBeUndefined();
    expect(noOp.changeAllowedAt).toBeUndefined();

    const changed = await store.changeMcpSubdomain(
      mutation('arez-internal', 'arez', 'change'),
      async () => true,
    );
    now = new Date('2026-08-20T12:00:00.000Z');
    const replay = await store.changeMcpSubdomain(
      mutation('arez-internal', 'arez', 'change'),
      async () => true,
    );
    const currentNoOp = await store.changeMcpSubdomain(
      mutation('arez-internal', 'arez', 'current-noop'),
      async () => true,
    );

    expect(replay).toEqual({ ...changed, replayed: true });
    expect(currentNoOp).toMatchObject({
      changed: false,
      replayed: false,
      changeAllowedAt: changed.changeAllowedAt,
    });
    await expect(
      store.changeMcpSubdomain(
        mutation('arez-internal', 'another-label', 'change'),
        async () => true,
      ),
    ).rejects.toBeInstanceOf(McpSubdomainIdempotencyConflictError);
  });

  it('enforces 30 days between successful changes at the exact boundary', async () => {
    let now = NOW;
    const store = new InMemoryMcpSubdomainClaimStore(() => now);
    store.ensureDefaultMcpSubdomain('arez-internal');
    await store.changeMcpSubdomain(mutation('arez-internal', 'arez', 'first'), async () => true);

    now = new Date('2026-09-10T11:59:59.999Z');
    const blocked = store.changeMcpSubdomain(
      mutation('arez-internal', 'arez-platform', 'too-soon'),
      async () => true,
    );
    await expect(blocked).rejects.toMatchObject({
      changeAllowedAt: '2026-09-10T12:00:00.000Z',
    });
    await expect(blocked).rejects.toBeInstanceOf(McpSubdomainCooldownError);

    now = new Date('2026-09-10T12:00:00.000Z');
    await expect(
      store.changeMcpSubdomain(
        mutation('arez-internal', 'arez-platform', 'boundary'),
        async () => true,
      ),
    ).resolves.toMatchObject({ changed: true, mcpSubdomain: 'arez-platform' });
  });

  it('arbitrates a global race so exactly one organization claims a free label', async () => {
    const store = new InMemoryMcpSubdomainClaimStore(() => NOW);
    store.ensureDefaultMcpSubdomain('first-org');
    store.ensureDefaultMcpSubdomain('second-org');

    const results = await Promise.allSettled([
      store.changeMcpSubdomain(mutation('first-org', 'shared-label', 'first'), async () => true),
      store.changeMcpSubdomain(mutation('second-org', 'shared-label', 'second'), async () => true),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure).toMatchObject({ reason: expect.any(McpSubdomainUnavailableError) });
    await expect(store.resolveActiveMcpSubdomain('shared-label')).resolves.toBeDefined();
  });
});

function mutation(org: string, mcpSubdomain: string, idempotencyKey: string) {
  return {
    org,
    mcpSubdomain,
    idempotencyKey,
    actor: { subject: 'owner-subject', email: 'owner@example.com' },
  };
}

describe('MCP subdomain claim projections', () => {
  const claim = {
    mcpSubdomain: 'arez',
    orgSlug: 'arez-internal',
    claimedAt: NOW.toISOString(),
  };
  const store = {
    getActiveMcpSubdomain: async (org: string) => (org === claim.orgSlug ? claim : undefined),
    resolveActiveMcpSubdomain: async (mcpSubdomain: string) =>
      mcpSubdomain === claim.mcpSubdomain ? claim : undefined,
  };

  it('maps a public route label to the immutable tenant org', async () => {
    await expect(
      resolveMcpSubdomainTenant(store, {
        mcpSubdomain: 'arez',
        app: 'todoist',
        env: 'prod',
      }),
    ).resolves.toEqual({ org: 'arez-internal', app: 'todoist', env: 'prod' });
    await expect(
      resolveMcpSubdomainTenant(store, {
        mcpSubdomain: 'retired',
        app: 'todoist',
        env: 'prod',
      }),
    ).resolves.toBeUndefined();
  });

  it('requires an active claim before producing public endpoint options', async () => {
    await expect(
      mcpSubdomainEndpointOptions(store, 'arez-internal', 'cloud.noodleseed.dev'),
    ).resolves.toEqual({
      publicBaseDomain: 'cloud.noodleseed.dev',
      mcpSubdomain: 'arez',
    });
    await expect(
      mcpSubdomainEndpointOptions(store, 'missing', 'cloud.noodleseed.dev'),
    ).rejects.toThrow('active MCP subdomain claim missing');
  });
});
