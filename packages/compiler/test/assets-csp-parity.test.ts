import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetReference, compileManifest } from '../src/index.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

// Both local-dev and hosted rewrites must merge the *same* asset origin into widget CSP. Holding the
// origin equal across the two compile modes lets us assert byte-for-byte parity of the resulting CSP.
const ASSET_ORIGIN = 'https://assets.example.com';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noodle-csp-parity-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'logo.png'), PNG_1X1);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function widgetCsp(result: ReturnType<typeof compileManifest>): {
  resourceDomains: readonly string[] | undefined;
  openaiResourceDomains: readonly string[] | undefined;
  handoffAllowed: readonly string[] | undefined;
} {
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
  const widget = result.artifact.resources?.find((resource) => resource.name === 'show_widget');
  return {
    resourceDomains: widget?._meta?.ui?.csp?.resourceDomains,
    openaiResourceDomains: (
      widget?._meta?.['openai/widgetCSP'] as { resource_domains?: string[] } | undefined
    )?.resource_domains,
    handoffAllowed: result.artifact.server.handoff?.allowedDomains,
  };
}

describe('local↔managed CSP parity', () => {
  it('adds identical resource domains and leaves handoff allowlists unchanged', () => {
    const logo = assetReference('./assets/logo.png');
    const base = {
      ...manifestWithAsset(logo),
      handoff: { allowedDomains: ['https://checkout.example.com'] },
    };

    const local = compileManifest(base, {
      localAssets: { rootDir: root, publicOrigin: ASSET_ORIGIN },
    });
    const hosted = compileManifest(base, {
      hostedAssets: {
        assets: [hostedAsset(logo, `${ASSET_ORIGIN}/__noodle/hosted-assets/opaque-logo`)],
      },
    });

    const localCsp = widgetCsp(local);
    const hostedCsp = widgetCsp(hosted);

    // Standard CSP resource domains: identical between the two modes, declared origin preserved first.
    expect(localCsp.resourceDomains).toEqual(['https://example.com', ASSET_ORIGIN]);
    expect(hostedCsp.resourceDomains).toEqual(localCsp.resourceDomains);

    // ChatGPT-compat resource domains: identical between the two modes and include declared media
    // domains, not only packaged asset origins.
    expect(localCsp.openaiResourceDomains).toEqual(['https://example.com', ASSET_ORIGIN]);
    expect(hostedCsp.openaiResourceDomains).toEqual(localCsp.openaiResourceDomains);

    // Handoff/open-link allowlist is untouched and identical — the asset origin never leaks into it.
    expect(localCsp.handoffAllowed).toEqual(['https://checkout.example.com']);
    expect(hostedCsp.handoffAllowed).toEqual(localCsp.handoffAllowed);
    expect(localCsp.resourceDomains).not.toContain('https://checkout.example.com');
    expect(hostedCsp.resourceDomains).not.toContain('https://checkout.example.com');
  });

  it('produces an identical asset-only CSP when the widget declares no resource domains', () => {
    const logo = assetReference('./assets/logo.png');
    const base = manifestWithAsset(logo, { declareCsp: false });

    const local = compileManifest(base, {
      localAssets: { rootDir: root, publicOrigin: ASSET_ORIGIN },
    });
    const hosted = compileManifest(base, {
      hostedAssets: {
        assets: [hostedAsset(logo, `${ASSET_ORIGIN}/__noodle/hosted-assets/opaque-logo`)],
      },
    });

    const localCsp = widgetCsp(local);
    const hostedCsp = widgetCsp(hosted);
    expect(localCsp.resourceDomains).toEqual([ASSET_ORIGIN]);
    expect(hostedCsp.resourceDomains).toEqual(localCsp.resourceDomains);
    expect(hostedCsp.openaiResourceDomains).toEqual(localCsp.openaiResourceDomains);
  });
});

function hostedAsset(asset: ReturnType<typeof assetReference>, publicUrl: string) {
  return {
    logicalId: asset.logicalId,
    sourcePath: 'assets/logo.png',
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mimeType: 'image/png',
    byteLength: PNG_1X1.byteLength,
    width: 1,
    height: 1,
    objectKey:
      'acme/app/prod/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo',
    publicUrl,
  };
}

function manifestWithAsset(
  asset: ReturnType<typeof assetReference>,
  opts: { declareCsp?: boolean } = {},
) {
  const declareCsp = opts.declareCsp ?? true;
  return {
    manifestVersion: '1',
    server: {
      name: 'asset_server',
      version: '1.0.0',
      title: 'Asset Server',
      branding: { logo: { uri: asset, alt: 'Asset Server logo' } },
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
        ...(declareCsp ? { csp: { resourceDomains: ['https://example.com'] } } : {}),
        view: { component: 'ShowWidget', entry: './views/ShowWidget.tsx' },
      },
    ],
  };
}
