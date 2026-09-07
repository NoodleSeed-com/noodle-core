import { describe, expect, it } from 'vitest';
import { InMemoryControlPlaneStore } from '../src/index.js';

describe('InMemoryControlPlaneStore MCP subdomain parity', () => {
  it('claims the organization slug on every hosted organization creation path', async () => {
    const store = new InMemoryControlPlaneStore({
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    });

    await store.createOrg({ slug: 'direct-org' });
    await store.createOrgWithOwner({
      slug: 'owned-org',
      owner: { subject: 'owner-sub', email: 'owner@example.com' },
    });
    await store.provisionPersonalWorkspace({
      slug: 'u-person-12345678',
      subject: 'person-sub',
      email: 'person@example.com',
    });
    await store.createOrg({ slug: 'local' });

    await expect(store.getActiveMcpSubdomain('direct-org')).resolves.toMatchObject({
      mcpSubdomain: 'direct-org',
      orgSlug: 'direct-org',
    });
    await expect(store.getActiveMcpSubdomain('owned-org')).resolves.toMatchObject({
      mcpSubdomain: 'owned-org',
      orgSlug: 'owned-org',
    });
    await expect(store.resolveActiveMcpSubdomain('u-person-12345678')).resolves.toMatchObject({
      orgSlug: 'u-person-12345678',
    });
    await expect(store.getActiveMcpSubdomain('local')).resolves.toBeUndefined();
  });
});
