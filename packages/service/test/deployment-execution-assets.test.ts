import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryAssetStore } from '../src/assets.js';
import { executeAuthorizedDeployment } from '../src/deployment-execution.js';
import { ServerRegistry } from '../src/registry.js';
import { InMemoryAuditStore } from '../src/store/audit.js';

const source = { org: 'acme', app: 'authored', env: 'prod' };
const target = { org: 'acme', app: 'installed', env: 'prod' };
const asset = {
  logicalId: 'logo',
  sourcePath: './logo.png',
  contentHash: `sha256:${'a'.repeat(64)}`,
  mimeType: 'image/png',
  byteLength: 1,
  width: 1,
  height: 1,
  publicUrl: 'https://assets.example.test/immutable.png',
  objectKey: 'immutable/source/key',
};

describe('authorized installation asset source scope', () => {
  it('verifies the original same-org bytes and retains target deployment reachability against their source object', async () => {
    const registry = new ServerRegistry();
    vi.spyOn(registry, 'deploy').mockResolvedValue({
      ok: true,
      deploymentId: 'installed-12345678',
      deploymentVersion: 1,
    });
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrgWithOwner({
      slug: 'acme',
      owner: { subject: 'owner', email: 'owner@example.com' },
    });
    const assets = new InMemoryAssetStore();
    const verify = vi
      .spyOn(assets, 'verifyUploadedAssets')
      .mockResolvedValue({ ok: true, assets: [asset] });
    const reachability = vi.spyOn(assets, 'recordReachability');
    const dependencies = {
      registry,
      controlPlane,
      audit: new InMemoryAuditStore(),
      options: { assetStore: assets },
    };
    expect(
      await executeAuthorizedDeployment(
        {
          tenant: target,
          assetSourceScope: source,
          hostedAssets: [asset],
          manifest: '{}',
          accessMode: 'public',
          serverVersion: '1',
        },
        dependencies,
      ),
    ).toMatchObject({ ok: true });
    expect(verify).toHaveBeenCalledWith({ scope: source, assets: [asset] });
    expect(reachability).toHaveBeenCalledWith({
      scope: source,
      assets: [asset],
      deploymentId: 'installed-12345678',
      deploymentVersion: 1,
    });
    expect(
      await executeAuthorizedDeployment(
        {
          tenant: target,
          assetSourceScope: { ...source, org: 'other' },
          hostedAssets: [asset],
          manifest: '{}',
          accessMode: 'public',
          serverVersion: '1',
        },
        dependencies,
      ),
    ).toMatchObject({ ok: false, status: 403, body: { code: 'asset_source_forbidden' } });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(registry.deploy).toHaveBeenCalledTimes(1);
  });
});
