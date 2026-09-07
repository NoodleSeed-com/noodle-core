import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetReference, compileManifest } from '../src/index.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noodle-assets-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'logo.png'), PNG_1X1);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('local packaged assets', () => {
  it('rewrites branding asset refs to local URLs and emits CSP metadata for widgets', () => {
    const logo = assetReference('./assets/logo.png');
    const result = compileManifest(manifestWithAsset(logo), {
      localAssets: { rootDir: root, publicOrigin: 'http://127.0.0.1:4567' },
    });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    expect(result.localAssets).toHaveLength(1);
    expect(result.artifact.assets).toHaveLength(1);
    expect(result.artifact.server.branding?.logo?.uri).toMatch(
      /^http:\/\/127\.0\.0\.1:4567\/__noodle\/assets\//,
    );
    expect(result.artifact.server.branding?.logo?.darkUri).toBe(
      result.artifact.server.branding?.logo?.uri,
    );
    expect(result.artifact.server.branding?.mark?.uri).toBe(
      result.artifact.server.branding?.logo?.uri,
    );
    expect(result.artifact.server.branding?.avatar?.uri).toBe(
      result.artifact.server.branding?.logo?.uri,
    );
    expect(result.artifact.assets?.[0]).toMatchObject({
      logicalId: logo.logicalId,
      sourcePath: 'assets/logo.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
    });
    const widget = result.artifact.resources?.find((resource) => resource.name === 'show_widget');
    expect(widget?._meta?.ui?.csp?.resourceDomains).toContain('http://127.0.0.1:4567');
    expect(
      (widget?._meta?.['openai/widgetCSP'] as { resource_domains?: string[] } | undefined)
        ?.resource_domains,
    ).toContain('http://127.0.0.1:4567');
    const html = widget?.fulfilment.kind === 'flow' ? widget.fulfilment.output.value : undefined;
    expect(html?.kind).toBe('literal');
    if (html?.kind === 'literal') expect(String(html.value)).toContain('/__noodle/assets/');
  });

  it('rejects unsafe packaged asset paths', () => {
    const escaped = compileManifest(manifestWithAsset(assetReference('../secret.png')), {
      localAssets: { rootDir: root, publicOrigin: 'http://127.0.0.1:4567' },
    });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.errors[0]?.code).toBe('invalid_asset');
  });

  it('rejects symlink escapes, SVG, unsupported content, and oversized files', () => {
    writeFileSync(join(root, 'outside.png'), PNG_1X1);
    symlinkSync(join(root, 'outside.png'), join(root, 'assets', 'escape.png'));
    const symlinkEscapeRoot = join(root, 'app');
    mkdirSync(join(symlinkEscapeRoot, 'assets'), { recursive: true });
    symlinkSync(join(root, 'outside.png'), join(symlinkEscapeRoot, 'assets', 'escape.png'));
    const symlinkEscape = compileManifest(
      manifestWithAsset(assetReference('./assets/escape.png')),
      {
        localAssets: { rootDir: symlinkEscapeRoot, publicOrigin: 'http://127.0.0.1:4567' },
      },
    );
    expect(symlinkEscape.ok).toBe(false);
    if (!symlinkEscape.ok) expect(symlinkEscape.errors[0]?.message).toContain('escapes');

    writeFileSync(join(root, 'assets', 'bad.svg'), '<svg></svg>');
    const svg = compileManifest(manifestWithAsset(assetReference('./assets/bad.svg')), {
      localAssets: { rootDir: root, publicOrigin: 'http://127.0.0.1:4567' },
    });
    expect(svg.ok).toBe(false);
    if (!svg.ok) expect(svg.errors[0]?.message).toContain('SVG');

    writeFileSync(join(root, 'assets', 'fake.png'), 'not a png');
    const fake = compileManifest(manifestWithAsset(assetReference('./assets/fake.png')), {
      localAssets: { rootDir: root, publicOrigin: 'http://127.0.0.1:4567' },
    });
    expect(fake.ok).toBe(false);
    if (!fake.ok) expect(fake.errors[0]?.message).toContain('content');

    writeFileSync(
      join(root, 'assets', 'huge.png'),
      Buffer.concat([PNG_1X1, Buffer.alloc(6 * 1024 * 1024)]),
    );
    const huge = compileManifest(manifestWithAsset(assetReference('./assets/huge.png')), {
      localAssets: { rootDir: root, publicOrigin: 'http://127.0.0.1:4567' },
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.errors[0]?.message).toContain('P0 limit');
  });

  it('keeps logical ids stable when content hashes change', () => {
    const ref = assetReference('./assets/logo.png');
    const first = compileManifest(manifestWithAsset(ref), {
      localAssets: { rootDir: root, publicOrigin: 'http://127.0.0.1:4567' },
    });
    writeFileSync(join(root, 'assets', 'logo.png'), Buffer.concat([PNG_1X1, Buffer.from([0])]));
    const second = compileManifest(manifestWithAsset(ref), {
      localAssets: { rootDir: root, publicOrigin: 'http://127.0.0.1:4567' },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.artifact.assets?.[0]?.logicalId).toBe(second.artifact.assets?.[0]?.logicalId);
    expect(first.artifact.assets?.[0]?.contentHash).not.toBe(
      second.artifact.assets?.[0]?.contentHash,
    );
  });

  it('requires a local resolver when asset refs are present', () => {
    const result = compileManifest(manifestWithAsset(assetReference('./assets/logo.png')));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.message).toContain('local or hosted asset resolver');
  });

  it('keeps dynamic media URLs CSP-governed by React widget metadata without packaging them', () => {
    const result = compileManifest({
      manifestVersion: '1',
      server: { name: 'dynamic_media', version: '1.0.0', title: 'Dynamic Media' },
      tools: [
        {
          name: 'show',
          description: 'Show dynamic media.',
          inputSchema: { type: 'object' },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
      widgets: [
        {
          name: 'show_widget',
          tool: 'show',
          csp: { resourceDomains: ['https://cdn.example.com'] },
          view: { component: 'ShowWidget', entry: './views/ShowWidget.tsx' },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.assets).toBeUndefined();
    const widget = result.artifact.resources?.find((resource) => resource.name === 'show_widget');
    expect(widget?._meta?.ui?.csp?.resourceDomains).toEqual(['https://cdn.example.com']);
  });

  it('rewrites packaged asset refs from hosted metadata and preserves handoff policy separately', () => {
    const logo = assetReference('./assets/logo.png');
    const result = compileManifest(
      {
        ...manifestWithAsset(logo),
        handoff: { allowedDomains: ['https://checkout.example.com'] },
      },
      {
        hostedAssets: {
          assets: [
            {
              logicalId: logo.logicalId,
              sourcePath: 'assets/logo.png',
              contentHash:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              mimeType: 'image/png',
              byteLength: 68,
              width: 1,
              height: 1,
              objectKey:
                'acme/app/prod/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo',
              publicUrl: 'https://assets.example.com/__noodle/hosted-assets/opaque-logo',
            },
          ],
        },
      },
    );

    expect(result.ok, result.ok ? '' : JSON.stringify(result.errors)).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.server.branding?.logo?.uri).toBe(
      'https://assets.example.com/__noodle/hosted-assets/opaque-logo',
    );
    expect(result.artifact.server.handoff?.allowedDomains).toEqual([
      'https://checkout.example.com',
    ]);
    expect(result.artifact.assets?.[0]).toMatchObject({
      logicalId: logo.logicalId,
      sourcePath: 'assets/logo.png',
      objectKey:
        'acme/app/prod/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo',
      publicUrl: 'https://assets.example.com/__noodle/hosted-assets/opaque-logo',
    });
    const widget = result.artifact.resources?.find((resource) => resource.name === 'show_widget');
    expect(widget?._meta?.ui?.csp?.resourceDomains).toEqual([
      'https://example.com',
      'https://assets.example.com',
    ]);
    expect(
      (widget?._meta?.['openai/widgetCSP'] as { resource_domains?: string[] } | undefined)
        ?.resource_domains,
    ).toEqual(['https://example.com', 'https://assets.example.com']);
  });

  it('rejects packaged asset refs when hosted metadata is missing or non-https', () => {
    const logo = assetReference('./assets/logo.png');
    const missing = compileManifest(manifestWithAsset(logo), { hostedAssets: { assets: [] } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]?.message).toContain('hosted asset metadata missing');

    const insecure = compileManifest(manifestWithAsset(logo), {
      hostedAssets: {
        assets: [
          {
            logicalId: logo.logicalId,
            sourcePath: 'assets/logo.png',
            contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            mimeType: 'image/png',
            byteLength: 68,
            width: 1,
            height: 1,
            objectKey: 'acme/app/prod/hash/logo',
            publicUrl: 'http://assets.example.com/logo.png',
          },
        ],
      },
    });
    expect(insecure.ok).toBe(false);
    if (!insecure.ok) expect(insecure.errors[0]?.message).toContain('https');
  });
});

function manifestWithAsset(asset: ReturnType<typeof assetReference>) {
  return {
    manifestVersion: '1',
    server: {
      name: 'asset_server',
      version: '1.0.0',
      title: 'Asset Server',
      branding: {
        logo: { uri: asset, darkUri: asset, alt: 'Asset Server logo' },
        mark: { uri: asset, alt: 'Asset Server mark' },
        avatar: { uri: asset, alt: 'Asset Server avatar' },
      },
    },
    tools: [
      {
        name: 'show',
        description: 'Show media.',
        inputSchema: { type: 'object' },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
    widgets: [
      {
        name: 'show_widget',
        tool: 'show',
        csp: { resourceDomains: ['https://example.com'] },
        view: { component: 'ShowWidget', entry: './views/ShowWidget.tsx' },
      },
    ],
  };
}
