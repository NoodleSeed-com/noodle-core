import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { publicEmbedSnippet } from '../src/commands/deploy-embed-snippet.js';
import { deploy } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, 'fixtures', 'embedded-assistant', 'server.ts');

/**
 * The public embed id survives the trip from service to developer.
 *
 * `deploySuccessResponseSchema` strips unknown keys, so a field the service returns but the contract
 * does not declare parses cleanly and then vanishes. For the id a developer is meant to paste into
 * their page, that failure mode is silent — hence a test at the boundary rather than trust in the shape.
 */

const SUCCESS = {
  ok: true,
  org: 'acme',
  app: 'site',
  env: 'prod',
  deploymentId: 'dpl_1',
  serverVersion: '1',
  accessMode: 'public',
  url: 'https://cloud.test/acme/site/1/mcp',
  defaultUrl: 'https://cloud.test/acme/site/mcp',
};

function stub(body: Record<string, unknown>): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

async function outcomeFor(body: Record<string, unknown>) {
  return deploy({
    manifestPath: server,
    serviceUrl: 'http://127.0.0.1:1',
    fetchImpl: stub(body),
    serverVersion: '1',
  });
}

describe('deploy carries the public embed id back to the developer', () => {
  it('keeps the id the service provisioned', async () => {
    const outcome = await outcomeFor({ ...SUCCESS, embedId: 'pub_7f2q4k9x0000000000000000' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.embedId).toBe('pub_7f2q4k9x0000000000000000');
  });

  it('reports no id when the app declares no public surface', async () => {
    const outcome = await outcomeFor(SUCCESS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.embedId).toBeUndefined();
  });
});

describe('the snippet a developer pastes', () => {
  const lines = publicEmbedSnippet('pub_7f2q4k9x0000000000000000', 'https://cloud.test/');

  it('points the script at the service just deployed to', () => {
    // Not the hardcoded cloud URL: a dev deploy must print a snippet that talks to dev. The loader
    // derives its service origin from this src, so the two can never drift apart.
    expect(lines.join('\n')).toContain('src="https://cloud.test/v1/assistant/embed.js"');
  });

  it('says the id is not a secret, where someone about to paste it will read it', () => {
    expect(lines.join('\n')).toContain('not a secret');
  });

  it('offers the React mount too, since an app with a build step should not use a script tag', () => {
    expect(lines.join('\n')).toContain(
      '<NoodleAssistant embedId="pub_7f2q4k9x0000000000000000" />',
    );
  });
});
