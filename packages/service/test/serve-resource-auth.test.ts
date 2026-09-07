import { describe, expect, it, vi } from 'vitest';
import type { ServerRegistry } from '../src/registry.js';
import { bridgeAuthForResource } from '../src/serve-resource-auth.js';
import type { ControlPlaneStore } from '../src/store.js';

describe('bridgeAuthForResource routing', () => {
  it.each([
    'https://AREZ.cloud.noodleseed.dev/todoist/mcp',
    'https://arez.cloud.noodleseed.dev:443/todoist/mcp',
    'https://arez.cloud.noodleseed.dev/%74odoist/mcp',
  ])('rejects noncanonical public resource %s before claim or tenant reads', async (resource) => {
    const getActiveByTenant = vi.fn();
    const registry = {
      getActiveByTenant,
      getActiveByTenantVersion: vi.fn(),
    } as unknown as ServerRegistry;
    const resolveActiveMcpSubdomain = vi.fn().mockResolvedValue({
      mcpSubdomain: 'arez',
      orgSlug: 'acme',
      claimedAt: '2026-08-11T00:00:00.000Z',
    });
    const controlPlane = {
      resolveActiveMcpSubdomain,
    } as unknown as ControlPlaneStore;

    await expect(
      bridgeAuthForResource(registry, resource, ['cloud.noodleseed.dev'], controlPlane),
    ).resolves.toBeUndefined();
    expect(resolveActiveMcpSubdomain).not.toHaveBeenCalled();
    expect(getActiveByTenant).not.toHaveBeenCalled();
  });

  it.each([
    'https://retired.cloud.noodleseed.dev/o/acme/todoist/mcp',
    'https://retired.cloud.noodleseed.dev./o/acme/todoist/mcp',
  ])('does not let public MCP host %s fall back to a legacy tenant path', async (resource) => {
    const getActiveByTenant = vi.fn();
    const registry = {
      getActiveByTenant,
      getActiveByTenantVersion: vi.fn(),
    } as unknown as ServerRegistry;
    const resolveActiveMcpSubdomain = vi.fn();
    const controlPlane = {
      resolveActiveMcpSubdomain,
    } as unknown as ControlPlaneStore;

    await expect(
      bridgeAuthForResource(registry, resource, ['cloud.noodleseed.dev'], controlPlane),
    ).resolves.toBeUndefined();
    expect(resolveActiveMcpSubdomain).not.toHaveBeenCalled();
    expect(getActiveByTenant).not.toHaveBeenCalled();
  });

  it('keeps legacy tenant paths available on the service origin', async () => {
    const getActiveByTenant = vi.fn().mockResolvedValue(undefined);
    const registry = {
      getActiveByTenant,
      getActiveByTenantVersion: vi.fn(),
    } as unknown as ServerRegistry;
    const controlPlane = {} as ControlPlaneStore;

    await expect(
      bridgeAuthForResource(
        registry,
        'https://service.example/o/acme/todoist/mcp',
        ['cloud.noodleseed.dev'],
        controlPlane,
      ),
    ).resolves.toBeUndefined();
    expect(getActiveByTenant).toHaveBeenCalledWith({
      org: 'acme',
      app: 'todoist',
      env: 'prod',
    });
  });
});
