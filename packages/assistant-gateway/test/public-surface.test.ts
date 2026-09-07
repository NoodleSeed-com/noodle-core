import { describe, expect, it } from 'vitest';
import {
  authenticatedSurfaceOf,
  publicSurfaceOf,
  surfaceBindingForOrigin,
} from '../src/public-surface.js';

const surface = (extra: Record<string, unknown>) => ({
  surfaces: [{ origins: ['https://www.acme.test'], capabilities: [], ...extra }],
});

describe('reading a deployment’s public surface', () => {
  it('returns the public surface with its mode, origins, and capabilities', () => {
    const found = publicSurfaceOf({
      surfaces: [
        { mode: 'authenticated', origins: ['https://app.acme.test'] },
        {
          mode: 'public',
          origins: ['https://www.acme.test'],
          capabilities: [{ kind: 'tool', name: 'ask_product' }],
          instructions: 'Guide visitors consultatively.',
        },
      ],
    });

    expect(found).toEqual({
      mode: 'public',
      origins: ['https://www.acme.test'],
      capabilities: [{ kind: 'tool', name: 'ask_product' }],
      instructions: 'Guide visitors consultatively.',
    });
  });

  it('treats a mixed surface as public-facing', () => {
    // A mixed surface admits strangers too; sign-in only widens what they reach after elevation.
    expect(publicSurfaceOf(surface({ mode: 'mixed' }))?.mode).toBe('mixed');
  });

  it('finds nothing when the assistant declares only an authenticated surface', () => {
    expect(publicSurfaceOf(surface({ mode: 'authenticated' }))).toBeUndefined();
  });

  it('finds nothing on the legacy single-surface shape', () => {
    // Manifests predating surfaces-plural carry `allowedOrigins` and no `surfaces` array at all.
    expect(publicSurfaceOf({ allowedOrigins: ['https://www.acme.test'] })).toBeUndefined();
  });

  it('finds nothing when the server declares no assistant', () => {
    expect(publicSurfaceOf(undefined)).toBeUndefined();
  });

  /**
   * Both defaults fail closed, which is why they are defaults rather than rejections. A surface with no
   * origins matches no browser, so nothing mints; a surface with no capabilities projects to an empty
   * artifact, so nothing is reachable. Neither may ever read as "unset, therefore unrestricted".
   */
  it('defaults a missing origin list to empty, so no page matches', () => {
    const found = publicSurfaceOf({ surfaces: [{ mode: 'public', capabilities: [] }] });
    expect(found?.origins).toEqual([]);
  });

  it('defaults a missing capability list to empty, so nothing is reachable', () => {
    const found = publicSurfaceOf({ surfaces: [{ mode: 'public', origins: ['https://a.test'] }] });
    expect(found?.capabilities).toEqual([]);
  });
});

describe('reading a deployment’s authenticated surface', () => {
  const assistant = {
    surfaces: [
      {
        mode: 'public',
        origins: ['https://www.acme.test'],
        capabilities: [{ kind: 'tool', name: 'ask_product' }],
      },
      {
        mode: 'authenticated',
        origins: ['https://app.acme.test'],
        instructions: 'Help the signed-in operator.',
      },
    ],
  };

  it('returns origins and instructions, and keeps an omitted allowlist omitted', () => {
    // Unlike a public surface, an absent capability list is the authored whole-server intent —
    // the compiler requires the allowlist only on public-audience surfaces.
    expect(authenticatedSurfaceOf(assistant)).toEqual({
      origins: ['https://app.acme.test'],
      instructions: 'Help the signed-in operator.',
    });
  });

  it('finds nothing when only public-audience surfaces exist', () => {
    expect(authenticatedSurfaceOf(surface({ mode: 'mixed' }))).toBeUndefined();
  });
});

describe('selecting the surface that owns an origin', () => {
  const assistant = {
    surfaces: [
      { mode: 'mixed', origins: ['https://www.acme.test'], capabilities: [] },
      { mode: 'authenticated', origins: ['https://app.acme.test'] },
    ],
  };

  it('selects the public-audience surface for its own origin', () => {
    expect(surfaceBindingForOrigin(assistant, 'https://www.acme.test')).toEqual({ kind: 'public' });
  });

  it('selects the authenticated surface for its own origin', () => {
    expect(surfaceBindingForOrigin(assistant, 'https://app.acme.test')).toEqual({
      kind: 'authenticated',
    });
  });

  it('refuses an origin no surface owns instead of falling back to a union', () => {
    expect(surfaceBindingForOrigin(assistant, 'https://legacy.acme.test')).toEqual({
      kind: 'unowned',
    });
  });

  it('reports the pre-surfaces artifact shape distinctly: its union is its whole contract', () => {
    expect(
      surfaceBindingForOrigin(
        { allowedOrigins: ['https://www.acme.test'] },
        'https://www.acme.test',
      ),
    ).toEqual({ kind: 'pre-surfaces' });
  });
});
