import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deploy } from '../src/index.js';
import { parseDeployRequestJson } from './deploy-request-test-helpers.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const FAR_PAST = '2000-01-01T00:00:00.000Z';
const STALE_UPLOAD_URL = 'https://upload.example.test/stale';
const FRESH_UPLOAD_URL = 'https://upload.example.test/fresh';
function firstPreflightAsset(body: string): {
  logicalId: string;
} {
  const parsed = JSON.parse(body) as {
    assets: Array<{
      logicalId: string;
    }>;
  };
  const asset = parsed.assets[0];
  if (asset === undefined) throw new Error('expected preflight request to include one asset');
  return asset;
}
describe('noodle deploy hosted assets', () => {
  it('preflights and uploads packaged assets before final deploy', async () => {
    const root = mkdtempSync(join(tmpdir(), `noodle-asset-deploy-${process.pid}-`));
    mkdirSync(join(root, 'assets'));
    writeFixtureWidget(root);
    writeFileSync(join(root, 'assets', 'logo.png'), PNG_1X1);
    const authored = join(root, 'server.ts');
    writeFileSync(
      authored,
      `
import { asset, server, tool, z } from '@noodleseed/one';

const logo = asset('./assets/logo.png');

export default server(
  'asset_cli',
  {
    title: 'Asset CLI',
    version: '1.0.0',
    branding: { logo: { uri: logo, alt: 'Asset CLI logo' } },
  },
  [
    tool(
      'show',
      {
        description: 'Show an asset.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        fulfil: () => ({ ok: true }),
        viewTitle: 'Asset',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
      },
    ),
  ],
);
`,
    );
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    const calls: string[] = [];
    let deployBody: Record<string, unknown> | undefined;
    let preflightBody: string | undefined;
    let uploadedBytes = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/assets/preflight')) {
        preflightBody = String(init?.body);
        const { logicalId } = firstPreflightAsset(preflightBody);
        return new Response(
          JSON.stringify({
            ok: true,
            assetOrigin: 'https://assets.example.test',
            assets: [
              {
                logicalId,
                sourcePath: 'assets/logo.png',
                contentHash,
                mimeType: 'image/png',
                byteLength: PNG_1X1.byteLength,
                width: 1,
                height: 1,
                objectKey: `local/asset/prod/${contentHash.slice(7)}/${logicalId}`,
                publicUrl: 'https://assets.example.test/__noodle/hosted-assets/opaque',
              },
            ],
            uploads: [
              {
                logicalId,
                objectKey: `local/asset/prod/${contentHash.slice(7)}/${logicalId}`,
                uploadUrl: 'https://upload.example.test/asset',
                method: 'PUT',
                headers: {
                  'content-type': 'image/png',
                  'x-noodle-content-length': String(PNG_1X1.byteLength),
                  'x-noodle-content-sha256': contentHash.slice(7),
                },
                expiresAt: FAR_FUTURE,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://upload.example.test/asset') {
        uploadedBytes = Buffer.from(await new Response(init?.body).arrayBuffer()).byteLength;
        return new Response('', { status: 201 });
      }
      deployBody = parseDeployRequestJson(init);
      return new Response(
        JSON.stringify({
          ok: true,
          org: 'local',
          app: 'server',
          env: 'prod',
          deploymentId: 'asset-cli-12345678',
          serverVersion: '1',
          url: 'https://svc.example/o/local/asset/v1/mcp',
          defaultUrl: 'https://svc.example/o/local/asset/mcp',
          accessMode: 'owner-only',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(calls).toEqual([
        'https://svc.example/v1/orgs/local/apps/server/envs/prod/assets/preflight',
        'https://upload.example.test/asset',
        'https://svc.example/v1/orgs/local/apps/server/envs/prod/deploy',
      ]);
      expect(uploadedBytes).toBe(PNG_1X1.byteLength);
      expect(preflightBody).not.toContain(root);
      expect(deployBody?.hostedAssets).toEqual([
        expect.objectContaining({
          sourcePath: 'assets/logo.png',
          publicUrl: 'https://assets.example.test/__noodle/hosted-assets/opaque',
        }),
      ]);
      expect(JSON.stringify(deployBody)).not.toContain(PNG_1X1.toString('base64'));
      expect(outcome.ok && outcome.assets).toEqual({
        checked: 1,
        uploaded: 1,
        reused: 0,
        uploadedBytes: PNG_1X1.byteLength,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('reports reused assets and skips upload when the object already exists', async () => {
    const project = setupAssetProject();
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/assets/preflight')) {
        return preflightResponse(firstPreflightAsset(String(init?.body)).logicalId, contentHash, {
          uploads: [],
        });
      }
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: project.authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(calls).toEqual([
        'https://svc.example/v1/orgs/local/apps/server/envs/prod/assets/preflight',
        'https://svc.example/v1/orgs/local/apps/server/envs/prod/deploy',
      ]);
      expect(outcome.ok && outcome.assets).toEqual({
        checked: 1,
        uploaded: 0,
        reused: 1,
        uploadedBytes: 0,
      });
    } finally {
      project.cleanup();
    }
  });
  it('reports zero assets and skips preflight when none are packaged', async () => {
    const root = mkdtempSync(join(tmpdir(), `noodle-asset-deploy-${process.pid}-`));
    writeFixtureWidget(root);
    const authored = join(root, 'server.ts');
    writeFileSync(
      authored,
      `
import { server, tool, z } from '@noodleseed/one';

export default server(
  'no_assets',
  { title: 'No Assets', version: '1.0.0' },
  [
    tool(
      'show',
      {
        description: 'Show.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        fulfil: () => ({ ok: true }),
        viewTitle: 'Plain',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
      },
    ),
  ],
);
`,
    );
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(calls).toEqual(['https://svc.example/v1/orgs/local/apps/server/envs/prod/deploy']);
      expect(outcome.ok && outcome.assets).toEqual({
        checked: 0,
        uploaded: 0,
        reused: 0,
        uploadedBytes: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('re-preflights before uploading to an already-expired target', async () => {
    const project = setupAssetProject();
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    const calls: string[] = [];
    let preflights = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/assets/preflight')) {
        preflights += 1;
        const id = firstPreflightAsset(String(init?.body)).logicalId;
        const stale = preflights === 1;
        return preflightResponse(id, contentHash, {
          uploads: [
            uploadTarget(id, contentHash, {
              url: stale ? STALE_UPLOAD_URL : FRESH_UPLOAD_URL,
              expiresAt: stale ? FAR_PAST : FAR_FUTURE,
            }),
          ],
        });
      }
      if (url === FRESH_UPLOAD_URL) return new Response('', { status: 201 });
      if (url === STALE_UPLOAD_URL)
        return new Response(JSON.stringify({ error: 'upload target expired' }), { status: 410 });
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: project.authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(preflights).toBe(2);
      expect(calls).toContain(FRESH_UPLOAD_URL);
      expect(calls).not.toContain(STALE_UPLOAD_URL);
      expect(outcome.ok && outcome.assets).toEqual({
        checked: 1,
        uploaded: 1,
        reused: 0,
        uploadedBytes: PNG_1X1.byteLength,
      });
    } finally {
      project.cleanup();
    }
  });
  it('re-preflights and continues when an upload target expires mid-batch (410)', async () => {
    const project = setupAssetProject();
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    const calls: string[] = [];
    let preflights = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/assets/preflight')) {
        preflights += 1;
        const id = firstPreflightAsset(String(init?.body)).logicalId;
        // Both targets advertise a future expiry; the first PUT still 410s (server-side expiry race).
        return preflightResponse(id, contentHash, {
          uploads: [
            uploadTarget(id, contentHash, {
              url: preflights === 1 ? STALE_UPLOAD_URL : FRESH_UPLOAD_URL,
              expiresAt: FAR_FUTURE,
            }),
          ],
        });
      }
      if (url === STALE_UPLOAD_URL)
        return new Response(JSON.stringify({ error: 'upload target expired' }), { status: 410 });
      if (url === FRESH_UPLOAD_URL) return new Response('', { status: 201 });
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: project.authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(preflights).toBe(2);
      expect(calls).toContain(STALE_UPLOAD_URL);
      expect(calls).toContain(FRESH_UPLOAD_URL);
      expect(outcome.ok && outcome.assets).toEqual({
        checked: 1,
        uploaded: 1,
        reused: 0,
        uploadedBytes: PNG_1X1.byteLength,
      });
    } finally {
      project.cleanup();
    }
  });
  it('fails after a single re-preflight when the target is still expired', async () => {
    const project = setupAssetProject();
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    let preflights = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/assets/preflight')) {
        preflights += 1;
        const id = firstPreflightAsset(String(init?.body)).logicalId;
        return preflightResponse(id, contentHash, {
          uploads: [uploadTarget(id, contentHash, { url: STALE_UPLOAD_URL, expiresAt: FAR_PAST })],
        });
      }
      if (url === STALE_UPLOAD_URL)
        return new Response(JSON.stringify({ error: 'upload target expired' }), { status: 410 });
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: project.authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok).toBe(false);
      expect(preflights).toBe(2);
      expect(!outcome.ok && outcome.message).toMatch(/expired|410/);
    } finally {
      project.cleanup();
    }
  });
  it('reports a local asset validation failure as a repairable validate-stage error', async () => {
    const root = mkdtempSync(join(tmpdir(), `noodle-asset-bad-${process.pid}-`));
    writeFixtureWidget(root);
    const authored = join(root, 'server.ts');
    // References an asset file that was never created.
    writeFileSync(
      authored,
      `
import { asset, server, tool, z } from '@noodleseed/one';
const logo = asset('./assets/missing.png');
export default server('bad', { title: 'Bad', version: '1.0.0', branding: { logo: { uri: logo, alt: 'x' } } }, [
  tool('show', { description: 'Show.', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }), viewTitle: 'A', view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' } }),
]);
`,
    );
    const fetchImpl = (async (url: string) => {
      throw new Error(`network must not be called, got ${url}`);
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.status).toBe(422);
      expect(outcome.stage).toBe('validate');
      expect(outcome.message).toMatch(/missing\.png/);
      expect(outcome.message).toMatch(/does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('reports a preflight quota rejection as a repairable preflight-stage error', async () => {
    const project = setupAssetProject();
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/assets/preflight')) {
        return new Response(JSON.stringify({ error: 'org asset quota exceeded' }), { status: 400 });
      }
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: project.authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.status).toBe(422);
      expect(outcome.stage).toBe('preflight');
      expect(outcome.message).toMatch(/quota/);
    } finally {
      project.cleanup();
    }
  });
  it('reports an upload checksum rejection as a repairable upload-stage error', async () => {
    const project = setupAssetProject();
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/assets/preflight')) {
        const id = firstPreflightAsset(String(init?.body)).logicalId;
        return preflightResponse(id, contentHash, {
          uploads: [
            uploadTarget(id, contentHash, { url: FRESH_UPLOAD_URL, expiresAt: FAR_FUTURE }),
          ],
        });
      }
      if (url === FRESH_UPLOAD_URL) {
        return new Response(JSON.stringify({ error: 'asset upload checksum mismatch' }), {
          status: 400,
        });
      }
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: project.authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.status).toBe(422);
      expect(outcome.stage).toBe('upload');
      expect(outcome.message).toMatch(/checksum/);
    } finally {
      project.cleanup();
    }
  });
  it('never includes the local absolute project path in any request body', async () => {
    const project = setupAssetProject();
    const contentHash = `sha256:${createHash('sha256').update(PNG_1X1).digest('hex')}`;
    let preflightBody = '';
    let deployBody = '';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/assets/preflight')) {
        preflightBody = String(init?.body);
        const id = firstPreflightAsset(preflightBody).logicalId;
        return preflightResponse(id, contentHash, {
          uploads: [
            uploadTarget(id, contentHash, { url: FRESH_UPLOAD_URL, expiresAt: FAR_FUTURE }),
          ],
        });
      }
      if (url === FRESH_UPLOAD_URL) return new Response('', { status: 201 });
      deployBody = String(init?.body);
      return deployResponse();
    }) as unknown as typeof fetch;
    try {
      const outcome = await deploy({
        manifestPath: project.authored,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      // The temp root is an absolute path (e.g. /var/folders/.../noodle-asset-deploy-...).
      expect(preflightBody).not.toContain(project.root);
      expect(deployBody).not.toContain(project.root);
      // Defense in depth: no absolute filesystem segment leaks into either request.
      expect(preflightBody).not.toMatch(/"\/(?:var|tmp|Users|home)\//);
      expect(deployBody).not.toMatch(/"\/(?:var|tmp|Users|home)\//);
    } finally {
      project.cleanup();
    }
  });
  it('keeps the absolute path out of an asset validation failure message', async () => {
    const root = mkdtempSync(join(tmpdir(), `noodle-asset-abs-${process.pid}-`));
    writeFixtureWidget(root);
    const authored = join(root, 'server.ts');
    writeFileSync(
      authored,
      `
import { asset, server, tool, z } from '@noodleseed/one';
const logo = asset('./assets/missing.png');
export default server('bad', { title: 'Bad', version: '1.0.0', branding: { logo: { uri: logo, alt: 'x' } } }, [
  tool('show', { description: 'Show.', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }), viewTitle: 'A', view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' } }),
]);
`,
    );
    try {
      const outcome = await deploy({
        manifestPath: authored,
        serviceUrl: 'https://svc.example',
        fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.message).toContain('assets/missing.png');
      expect(outcome.message).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
/** Create a temp project that references one packaged PNG logo + widget image. */
function setupAssetProject(): {
  root: string;
  authored: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), `noodle-asset-deploy-${process.pid}-`));
  mkdirSync(join(root, 'assets'));
  writeFixtureWidget(root);
  writeFileSync(join(root, 'assets', 'logo.png'), PNG_1X1);
  const authored = join(root, 'server.ts');
  writeFileSync(
    authored,
    `
import { asset, server, tool, z } from '@noodleseed/one';

const logo = asset('./assets/logo.png');

export default server(
  'asset_cli',
  {
    title: 'Asset CLI',
    version: '1.0.0',
    branding: { logo: { uri: logo, alt: 'Asset CLI logo' } },
  },
  [
    tool(
      'show',
      {
        description: 'Show an asset.',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        fulfil: () => ({ ok: true }),
        viewTitle: 'Asset',
        view: { component: 'FixtureWidget', entry: './views/FixtureWidget.tsx' },
      },
    ),
  ],
);
`,
  );
  return { root, authored, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeFixtureWidget(root: string): void {
  mkdirSync(join(root, 'views'));
  writeFileSync(
    join(root, 'views', 'FixtureWidget.tsx'),
    'export default function FixtureWidget() { return <main>Fixture widget ready</main>; }\n',
  );
}
/** Build a preflight 200 response for one asset, with caller-chosen upload targets. */
function preflightResponse(
  logicalId: string,
  contentHash: string,
  opts: {
    uploads: unknown[];
  },
): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      assetOrigin: 'https://assets.example.test',
      assets: [
        {
          logicalId,
          sourcePath: 'assets/logo.png',
          contentHash,
          mimeType: 'image/png',
          byteLength: PNG_1X1.byteLength,
          width: 1,
          height: 1,
          objectKey: `local/asset/prod/${contentHash.slice(7)}/${logicalId}`,
          publicUrl: 'https://assets.example.test/__noodle/hosted-assets/opaque',
        },
      ],
      uploads: opts.uploads,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
/** Build a single signed upload target with a caller-chosen URL + expiry. */
function uploadTarget(
  logicalId: string,
  contentHash: string,
  opts: {
    url: string;
    expiresAt: string;
  },
): Record<string, unknown> {
  return {
    logicalId,
    objectKey: `local/asset/prod/${contentHash.slice(7)}/${logicalId}`,
    uploadUrl: opts.url,
    method: 'PUT',
    headers: {
      'content-type': 'image/png',
      'x-noodle-content-length': String(PNG_1X1.byteLength),
      'x-noodle-content-sha256': contentHash.slice(7),
    },
    expiresAt: opts.expiresAt,
  };
}
/** Build the final deploy 201 success response. */
function deployResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      org: 'local',
      app: 'server',
      env: 'prod',
      deploymentId: 'asset-cli-12345678',
      serverVersion: '1',
      url: 'https://svc.example/o/local/asset/v1/mcp',
      defaultUrl: 'https://svc.example/o/local/asset/mcp',
      accessMode: 'owner-only',
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}
