import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetReference } from '@noodle-borg/compiler';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterEach, describe, expect, it } from 'vitest';
import { createModule as createAssetStorageModule } from '../src/index.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const SALT = Buffer.alloc(32, 0x43).toString('base64url');

let running: RunningService | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

describe('filesystem asset-store service integration', () => {
  it('retains a deployed asset after reachability overflow and a real service restart', async () => {
    temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'noodle-service-filesystem-assets-')),
    );
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrg({ slug: 'acme' });
    running = await bootService(temporaryRoot, controlPlane, 0);
    const originalUrl = running.url;
    const originalPort = running.port;
    const ref = assetReference('./assets/logo.png');
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;

    const preflight = await fetch(
      `${running.url}/v1/orgs/acme/apps/restart-assets/envs/prod/assets/preflight`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assets: [
            {
              logicalId: ref.logicalId,
              sourcePath: 'assets/logo.png',
              contentHash,
              mimeType: 'image/png',
              byteLength: PNG_1X1.byteLength,
              width: 1,
              height: 1,
            },
          ],
        }),
      },
    );
    const plan = (await preflight.json()) as {
      assets: Array<{ objectKey: string; publicUrl: string }>;
      uploads: Array<{
        uploadUrl: string;
        method: 'PUT';
        headers: Record<string, string>;
      }>;
    };
    expect(preflight.status, JSON.stringify(plan)).toBe(200);
    const asset = plan.assets[0];
    const upload = plan.uploads[0];
    expect(asset).toBeDefined();
    expect(upload).toBeDefined();
    if (asset === undefined || upload === undefined) return;

    const uploaded = await fetch(upload.uploadUrl, {
      method: upload.method,
      headers: upload.headers,
      body: PNG_1X1,
    });
    expect(uploaded.status).toBe(201);
    const metadataPath = await seedReachabilityCapacity(temporaryRoot, asset.objectKey);
    const deployed = await fetch(
      `${running.url}/v1/orgs/acme/apps/restart-assets/envs/prod/deploy`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: JSON.stringify(manifestWithHostedAsset(ref)),
          hostedAssets: plan.assets,
        }),
      },
    );
    expect(deployed.status).toBe(201);
    const overflowed = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      reachableBy: unknown[];
      retainIndefinitely?: unknown;
    };
    expect(overflowed.reachableBy).toHaveLength(256);
    expect(overflowed.retainIndefinitely).toBe(true);

    const assetPath = new URL(asset.publicUrl).pathname;
    const beforeHead = await fetch(`${running.url}${assetPath}`, { method: 'HEAD' });
    const beforeGet = await fetch(`${running.url}${assetPath}`);
    expect(beforeHead.status).toBe(200);
    expect(beforeGet.status).toBe(200);
    const beforeBytes = Buffer.from(await beforeGet.arrayBuffer());
    const beforeEtag = beforeHead.headers.get('etag');
    expect(beforeEtag).toBe(`"${contentHash.slice('sha256:'.length)}"`);
    expect(beforeGet.headers.get('etag')).toBe(beforeEtag);

    await running.close();
    running = undefined;
    running = await bootService(temporaryRoot, undefined, originalPort);

    expect(running.url).toBe(originalUrl);
    const afterHead = await fetch(`${running.url}${assetPath}`, { method: 'HEAD' });
    const afterGet = await fetch(`${running.url}${assetPath}`);
    expect(afterHead.status).toBe(200);
    expect(afterGet.status).toBe(200);
    expect(Buffer.from(await afterGet.arrayBuffer())).toEqual(beforeBytes);
    expect(beforeBytes).toEqual(PNG_1X1);
    expect(afterHead.headers.get('etag')).toBe(beforeEtag);
    expect(afterGet.headers.get('etag')).toBe(beforeEtag);
  });
});

async function seedReachabilityCapacity(root: string, objectKey: string): Promise<string> {
  const physicalId = createHash('sha256').update(objectKey, 'utf8').digest('hex');
  const metadataPath = join(root, 'objects', `${physicalId}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  metadata.reachableBy = Array.from({ length: 256 }, (_, index) => ({
    deploymentId: `seeded-deployment-${index}`,
    deploymentVersion: index,
  }));
  metadata.retainIndefinitely = false;
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  return metadataPath;
}

function bootService(
  root: string,
  controlPlaneStore: InMemoryControlPlaneStore | undefined,
  port: number,
): Promise<RunningService> {
  return serveService({
    host: '127.0.0.1',
    port,
    ...(controlPlaneStore === undefined ? {} : { controlPlaneStore }),
    modules: [createAssetStorageModule({ root, salt: SALT })],
    deployGate: {
      authorize: () =>
        Promise.resolve({
          ok: true,
          identity: { subject: 'owner-sub', email: 'owner@example.test', superAdmin: true },
        }),
    },
  });
}

function manifestWithHostedAsset(asset: ReturnType<typeof assetReference>) {
  return {
    manifestVersion: '1',
    server: {
      name: 'restart_assets',
      version: '1.0.0',
      title: 'Restart Assets',
      branding: { logo: { uri: asset, alt: 'Asset logo' } },
    },
    tools: [
      {
        name: 'show',
        description: 'Show asset.',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
    widgets: [
      {
        name: 'show_widget',
        tool: 'show',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
      },
    ],
  };
}
