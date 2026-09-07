import { describe, expect, it } from 'vitest';
import { InMemoryPublicEmbedStore } from '../src/in-memory-embed-store.js';
import { authorizePublicConfiguration } from '../src/public-configuration.js';

const NOW = new Date('2030-08-01T00:00:00.000Z');
const ORIGIN = 'https://www.acme.test';
const TENANT = { org: 'acme', app: 'site', env: 'prod' };

describe('public assistant configuration authorization', () => {
  async function setup() {
    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });
    return { embeds, embed };
  }

  it('authorizes the exact origin against the active surface', async () => {
    const { embeds, embed } = await setup();
    await expect(
      authorizePublicConfiguration(
        { embedId: embed.embedId, origin: ORIGIN },
        {
          embeds,
          resolveActiveSurface: () =>
            Promise.resolve({ mode: 'public', origins: [ORIGIN], capabilities: [] }),
        },
      ),
    ).resolves.toEqual({ ok: true, embed });
  });

  it.each([
    ['invalid id', 'not-an-embed', ORIGIN, 400, 'invalid_embed_id'],
    ['missing origin', undefined, undefined, 403, 'origin_not_allowed'],
    ['unknown id', 'pub_bbbbbbbbbbbbbbbbbbbbbbbb', ORIGIN, 403, 'embed_not_found'],
    ['wrong origin', undefined, 'https://evil.test', 403, 'origin_not_allowed'],
  ])('refuses an %s without revealing configuration', async (_label, id, origin, status, code) => {
    const { embeds, embed } = await setup();
    const result = await authorizePublicConfiguration(
      { embedId: id ?? embed.embedId, origin },
      {
        embeds,
        resolveActiveSurface: () =>
          Promise.resolve({ mode: 'public', origins: [ORIGIN], capabilities: [] }),
      },
    );
    expect(result).toMatchObject({ ok: false, status, code });
  });

  it('refuses when the active deployment no longer exposes a public surface', async () => {
    const { embeds, embed } = await setup();
    await expect(
      authorizePublicConfiguration(
        { embedId: embed.embedId, origin: ORIGIN },
        { embeds, resolveActiveSurface: () => Promise.resolve(undefined) },
      ),
    ).resolves.toMatchObject({ ok: false, status: 409, code: 'surface_unavailable' });
  });
});
