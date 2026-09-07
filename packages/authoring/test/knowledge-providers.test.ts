import { describe, expect, it } from 'vitest';
import { secret, variable } from '../src/config.js';
import {
  algolia,
  file,
  firecrawl,
  knowledge,
  manifestKnowledge,
  meilisearch,
  site,
  tavily,
} from '../src/knowledge.js';

/**
 * Providers are declared in code with config NAMES (the variable()/secret() doctrine); values
 * are operated through the CLI. The manifest carries the provider kind and the referenced names
 * — never a value — and `refresh` compiles to bounded minutes.
 */
describe('knowledge provider declarations', () => {
  it('site() parses refresh durations to minutes and rejects out-of-bounds values', () => {
    expect(site({ origin: 'https://a.test', include: ['/**'], refresh: '6h' }).refreshMinutes).toBe(
      360,
    );
    expect(
      site({ origin: 'https://a.test', include: ['/**'], refresh: '15m' }).refreshMinutes,
    ).toBe(15);
    expect(site({ origin: 'https://a.test', include: ['/**'], refresh: '7d' }).refreshMinutes).toBe(
      7 * 24 * 60,
    );
    expect(site({ origin: 'https://a.test', include: ['/**'] }).refreshMinutes).toBeUndefined();
    expect(() => site({ origin: 'https://a.test', include: ['/**'], refresh: '5m' })).toThrow(
      /refresh/,
    );
    expect(() => site({ origin: 'https://a.test', include: ['/**'], refresh: '8d' })).toThrow(
      /refresh/,
    );
    expect(() => site({ origin: 'https://a.test', include: ['/**'], refresh: 'soon' })).toThrow(
      /refresh/,
    );
  });

  it('provider helpers carry config references by name and kind, never values', () => {
    const component = knowledge('product', {
      title: 'Product',
      description: 'Docs.',
      documents: [file('./knowledge/a.md', { title: 'A' })],
      sites: [site({ origin: 'https://a.test', include: ['/**'], refresh: '6h' })],
      crawler: firecrawl({ apiKey: secret('FIRECRAWL_API_KEY') }),
      index: algolia({ appId: variable('ALGOLIA_APP_ID'), apiKey: secret('ALGOLIA_API_KEY') }),
    });
    const manifest = manifestKnowledge(component);
    expect(manifest.crawler).toEqual({
      provider: 'firecrawl',
      config: { apiKey: { kind: 'secret', name: 'FIRECRAWL_API_KEY' } },
    });
    expect(manifest.index).toEqual({
      provider: 'algolia',
      config: {
        appId: { kind: 'variable', name: 'ALGOLIA_APP_ID' },
        apiKey: { kind: 'secret', name: 'ALGOLIA_API_KEY' },
      },
    });
    expect(manifest.sites[0]?.refreshMinutes).toBe(360);
    expect(JSON.stringify(manifest)).not.toContain('tvly');
  });

  it('tavily and meilisearch helpers produce their provider kinds', () => {
    expect(tavily({ apiKey: secret('TAVILY_API_KEY') }).provider).toBe('tavily');
    expect(
      meilisearch({ host: variable('MEILI_HOST'), apiKey: secret('MEILI_API_KEY') }).provider,
    ).toBe('meilisearch');
  });

  it('omitted crawler/index mean the managed defaults and stay absent from the manifest', () => {
    const manifest = manifestKnowledge(
      knowledge('product', {
        title: 'Product',
        description: 'Docs.',
        documents: [file('./knowledge/a.md', { title: 'A' })],
      }),
    );
    expect(manifest.crawler).toBeUndefined();
    expect(manifest.index).toBeUndefined();
  });
});
