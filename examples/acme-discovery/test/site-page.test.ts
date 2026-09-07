import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

/**
 * `site/index.html` is the demo half of the WebMCP story (ADR 0220): the marketing page a browser
 * agent actually visits. The compiled server says the marketing surface opts in; only a real page
 * running the real snippet shows what that buys.
 *
 * These guard the two properties that make the demo honest rather than the markup, which is meant to
 * be edited: the page mounts the published one-liner and nothing else, and it never advertises a
 * getaway the server cannot discuss.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'site', 'index.html'), 'utf8');

describe('the acme-discovery demo page', () => {
  it('mounts the assistant with the published one-line snippet', () => {
    expect(page).toContain('<script src="https://cloud.noodleseed.dev/v1/assistant/embed.js"');
    expect(page).toMatch(/data-embed-id="pub_[a-z0-9]{20,64}"/u);
  });

  it('carries bootstrap markup only, so the page never borrows the session itself', () => {
    // The bridge lives in the embed bundle, where it runs under the session's authority and budgets.
    // Page-local JavaScript reaching for the same tools would carry none of that, so there is none:
    // the demo's only script is the snippet above, and it has no body of its own.
    expect(page.match(/<script\b/gu)).toHaveLength(1);
    expect(page).toMatch(/data-embed-id="pub_[a-z0-9]{20,64}"><\/script>/u);
  });

  it('is a placeholder deployment, not a live embed anyone can point at', () => {
    // Copying this file must not aim a stranger's page at a real deployment, so the id is fictional
    // and the README says how to mint your own.
    expect(page).toContain('pub_examplepublicembedid00');
    expect(page).toContain('noodle deploy');
  });

  it('offers only getaways the server can actually discuss', async () => {
    const catalog = JSON.stringify(await app.toManifest());
    const offered = [...page.matchAll(/<h3 class="listing-name">([^<]+)<\/h3>/gu)].map(
      (match) => match[1],
    );

    expect(offered.length).toBeGreaterThan(2);
    for (const name of offered) {
      expect(catalog, `${name} is on the page but not in the server's catalog`).toContain(name);
    }
  });
});
