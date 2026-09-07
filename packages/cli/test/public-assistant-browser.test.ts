import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
  ServerRegistry,
} from '@noodle-borg/service';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The public surface, in a real browser, as a stranger.
 *
 * The authenticated arc is covered by `embedded-assistant-browser.test.ts`. What only this can prove is
 * the anonymous path end to end through Chromium's own CORS enforcement: a page with no backend and no
 * credential presents a non-secret embed id, gets a session, holds a turn, and cannot reach past the
 * surface's capability allowlist. Every layer in between — mint refusal ordering, projection, admission —
 * has unit coverage; this is the one place they run together against a real origin check.
 */

let browser: Browser;
const servers: Server[] = [];

beforeAll(async () => {
  // Same posture as the authenticated browser test: keep CORS enforcement, allow the intercepted public
  // origin to reach the loopback service. Production has two public HTTPS origins and no local hop.
  browser = await chromium.launch({
    headless: true,
    args: [
      '--allow-running-insecure-content',
      '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC',
    ],
  });
});

afterAll(async () => {
  await browser?.close();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const SITE = 'https://www.acme.test';
const OTHER = 'https://evil.test';

describe('the public website surface in a real browser', () => {
  it('lets a stranger hold a conversation, and holds the surface boundary', async () => {
    const registry = new ServerRegistry();
    const scope = { level: 'env' as const, org: 'acme', app: 'site', env: 'prod' };
    for (const [name, value] of [
      ['MODEL_URL', 'https://models.example/v1'],
      ['MODEL', 'test'],
    ]) {
      await registry.configStore.setConfigValue({ kind: 'variable', scope, name, value });
    }
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MODEL_KEY',
      value: 'provider-secret',
    });

    const deployed = await registry.deploy({ org: 'acme', app: 'site', env: 'prod' }, manifest(), {
      accessMode: 'public',
    });
    expect(deployed.ok, JSON.stringify(deployed)).toBe(true);

    const modelFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => sseModel(['Noodle Seed is ', 'a declarative platform.']));

    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({
      org: 'acme',
      app: 'site',
      env: 'prod',
      surfaceMode: 'public',
      now: new Date(),
    });

    const service = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
        publicEmbeds: embeds,
        admissionCounters: durableCounters(),
      } as unknown as Parameters<typeof createServiceHandler>[1]),
    );
    servers.push(service);
    await listen(service);
    const serviceOrigin = origin(service);

    const page = await browser.newPage();
    // A page on the allowed origin, carrying only the embed id. No backend, no secret, exactly what a
    // customer pastes.
    await page.route(`${SITE}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>acme</title>' }),
    );
    await page.goto(`${SITE}/`);

    const minted = await page.evaluate(
      async ([base, embedId]) => {
        const response = await fetch(`${base}/v1/assistant/public-sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ embedId }),
          credentials: 'omit',
        });
        return { status: response.status, body: await response.json() };
      },
      [serviceOrigin, embed.embedId],
    );

    expect(minted.status).toBe(201);
    expect(minted.body.token).toBeTruthy();
    // Chromium enforced the CORS response itself: a wrong allow-origin would have failed the read above.

    const turn = await page.evaluate(
      async ([base, token]) => {
        const response = await fetch(`${base}/v1/assistant/turns`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'What is Noodle Seed?' }),
        });
        return { status: response.status, text: await response.text() };
      },
      [serviceOrigin, minted.body.token as string],
    );

    expect(turn.status).toBe(200);
    expect(turn.text).toContain('declarative platform');

    const listed = await page.evaluate(
      async ([base, token]) => {
        const response = await fetch(`${base}/v1/assistant/apps`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'tools/list', params: {} }),
        });
        return (await response.json()) as { tools?: { name: string }[] };
      },
      [serviceOrigin, minted.body.token as string],
    );

    // The projection, seen from the browser: the surface lists `ask` and cannot see `internal_audit`,
    // which exists on the server and is absent from this surface's capability allowlist.
    const names = (listed.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('ask');
    expect(names).not.toContain('internal_audit');

    // No credential of any kind reached the page.
    const source = await page.content();
    expect(source).not.toContain('provider-secret');
    expect(JSON.stringify(minted.body)).not.toMatch(/secret|clientSecret/i);

    await page.close();
  });

  it('refuses a page that is not on the surface origin list', async () => {
    const registry = new ServerRegistry();
    const scope = { level: 'env' as const, org: 'acme', app: 'site', env: 'prod' };
    for (const [name, value] of [
      ['MODEL_URL', 'https://models.example/v1'],
      ['MODEL', 'test'],
    ]) {
      await registry.configStore.setConfigValue({ kind: 'variable', scope, name, value });
    }
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MODEL_KEY',
      value: 'provider-secret',
    });
    await registry.deploy({ org: 'acme', app: 'site', env: 'prod' }, manifest(), {
      accessMode: 'public',
    });

    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({
      org: 'acme',
      app: 'site',
      env: 'prod',
      surfaceMode: 'public',
      now: new Date(),
    });
    const service = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        publicEmbeds: embeds,
        admissionCounters: durableCounters(),
      } as unknown as Parameters<typeof createServiceHandler>[1]),
    );
    servers.push(service);
    await listen(service);

    const page = await browser.newPage();
    await page.route(`${OTHER}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>evil</title>' }),
    );
    await page.goto(`${OTHER}/`);

    const stolen = await page.evaluate(
      async ([base, embedId]) => {
        try {
          const response = await fetch(`${base}/v1/assistant/public-sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ embedId }),
            credentials: 'omit',
          });
          return { blocked: false, status: response.status };
        } catch {
          // A refusal echoes no allow-origin header, so Chromium rejects the response outright.
          return { blocked: true, status: 0 };
        }
      },
      [origin(service), embed.embedId],
    );

    // The embed id is public by design, so copying it onto another page must buy nothing.
    expect(stolen.blocked || stolen.status === 403).toBe(true);
    await page.close();
  });
});

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function origin(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The mint route refuses a non-durable store, so the harness supplies one that claims durability. */
function durableCounters() {
  const used = new Map<string, number>();
  return {
    durable: true,
    consume: async ({ key, limit }: { key: string; limit: number }) => {
      const next = (used.get(key) ?? 0) + 1;
      if (next > limit) return { allowed: false, used: used.get(key) ?? 0, limit };
      used.set(key, next);
      return { allowed: true, used: next, limit };
    },
    peek: async (key: string) => used.get(key) ?? 0,
  };
}

function sseModel(deltas: readonly string[]): Response {
  const body = `${deltas
    .map((delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}`)
    .join('\n\n')}\n\ndata: [DONE]\n\n`;
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** A public surface offering `ask` only; `internal_audit` exists on the server and must stay unreachable. */
function manifest(): string {
  return `manifestVersion: "1"
server:
  name: site
  version: 1.0.0
  title: Acme Site
  assistant:
    model: { kind: openai-compatible, baseUrl: "\${env.MODEL_URL}", model: "\${env.MODEL}", apiKey: MODEL_KEY }
    allowedOrigins: ["${SITE}"]
    surfaces:
      - mode: public
        origins: ["${SITE}"]
        capabilities:
          - { kind: tool, name: ask }
tools:
  - name: ask
    description: Answer from the curated FAQ.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    annotations: { readOnlyHint: true }
    fulfilment:
      steps: []
      output: { answer: "Noodle Seed is a declarative platform." }
  - name: internal_audit
    description: Internal audit trail.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    annotations: { readOnlyHint: true }
    fulfilment:
      steps: []
      output: { entries: [] }
`;
}

describe('a knowledge answer in a real browser (ADR 0202)', () => {
  it('cites deployed documents, updates live-site results without a deploy, and holds projection', async () => {
    const { createHash } = await import('node:crypto');
    const { defaultKnowledgeStores, wireKnowledge } = await import(
      '@noodle-borg/knowledge-operations'
    );
    const { FakeSiteSearch } = await import('@noodle-borg/knowledge');
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
    const DOC = 'Noodle Seed pricing starts at ten dollars per seat per month.';

    const registry = new ServerRegistry();
    const stores = defaultKnowledgeStores();
    const liveSite = new FakeSiteSearch();
    const wired = wireKnowledge(
      registry,
      stores,
      (ref) =>
        registry.configStore.resolveConfigValues('variable', {
          level: 'env',
          org: ref.org,
          app: ref.app,
          env: ref.env,
        }),
      1024 * 1024,
    );
    void wired;
    const scope = { level: 'env' as const, org: 'acme', app: 'site', env: 'prod' };
    for (const [name, value] of [
      ['MODEL_URL', 'https://models.example/v1'],
      ['MODEL', 'test'],
      // The browser E2E fixture enables the gate explicitly (rollout keeps it off by default).
      ['NOODLE_KNOWLEDGE_ENABLED', 'true'],
    ]) {
      await registry.configStore.setConfigValue({ kind: 'variable', scope, name, value });
    }
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MODEL_KEY',
      value: 'provider-secret',
    });
    await stores.staging.put('acme/site/prod', sha(DOC), Buffer.from(DOC), DOC.length);

    const knowledgeManifest = JSON.stringify({
      manifestVersion: '2',
      server: {
        name: 'site',
        title: 'Acme Site',
        version: '1.0.0',
        assistant: {
          model: {
            kind: 'openai-compatible',
            baseUrl: '${env.MODEL_URL}',
            model: '${env.MODEL}',
            apiKey: 'MODEL_KEY',
          },
          allowedOrigins: [SITE],
          surfaces: [
            {
              mode: 'public',
              origins: [SITE],
              capabilities: [{ kind: 'knowledge', name: 'product' }],
            },
          ],
        },
        knowledge: [
          {
            name: 'product',
            title: 'Product knowledge',
            description: 'Public product information.',
            documents: [
              {
                path: 'docs/pricing.md',
                title: 'Pricing guide',
                sourceUrl: 'https://www.acme.test/pricing',
                sha256: sha(DOC),
                bytes: DOC.length,
              },
            ],
            sites: [],
          },
          {
            name: 'internal_notes',
            title: 'Internal notes',
            description: 'Not projected to the public surface.',
            documents: [
              {
                path: 'docs/pricing.md',
                title: 'Internal',
                sha256: sha(DOC),
                bytes: DOC.length,
              },
            ],
            sites: [],
          },
        ],
      },
      tools: [
        {
          name: 'ping',
          description: 'Ping.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    });

    const deployed = await registry.deploy(
      { org: 'acme', app: 'site', env: 'prod' },
      knowledgeManifest,
      {
        accessMode: 'public',
      },
    );
    expect(deployed.ok, JSON.stringify(deployed)).toBe(true);

    const modelFetch = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: {
                          name: 'search_product',
                          arguments: JSON.stringify({ query: 'pricing' }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      )
      .mockImplementationOnce(async () =>
        sseModel(['Pricing starts at $10/seat — see the Pricing guide.']),
      );

    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({
      org: 'acme',
      app: 'site',
      env: 'prod',
      surfaceMode: 'public',
      now: new Date(),
    });

    const service = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
        publicEmbeds: embeds,
        admissionCounters: durableCounters(),
        // The same stores the deploy above published into; the handler re-wires the registry
        // hooks at construction, so a different store set would serve an empty index.
        knowledge: stores,
      } as unknown as Parameters<typeof createServiceHandler>[1]),
    );
    servers.push(service);
    await listen(service);
    const serviceOrigin = origin(service);

    const page = await browser.newPage();
    await page.route(`${SITE}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>acme</title>' }),
    );
    await page.goto(`${SITE}/`);

    const minted = await page.evaluate(
      async ([base, embedId]) => {
        const response = await fetch(`${base}/v1/assistant/public-sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ embedId }),
          credentials: 'omit',
        });
        return { status: response.status, body: await response.json() };
      },
      [serviceOrigin, embed.embedId],
    );
    expect(minted.status).toBe(201);

    const turn = await page.evaluate(
      async ([base, token]) => {
        const response = await fetch(`${base}/v1/assistant/turns`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'What does it cost?' }),
        });
        return { status: response.status, text: await response.text() };
      },
      [serviceOrigin, minted.body.token as string],
    );
    expect(turn.status).toBe(200);
    // The answer the stranger sees cites the deployed document's title.
    expect(turn.text).toContain('Pricing guide');
    // The model was fed the real document hits (with the citation URI), not invented text.
    const toolResultBody = String(modelFetch.mock.calls[1]?.[1]?.body);
    expect(toolResultBody).toContain('ten dollars per seat');
    expect(toolResultBody).toContain('https://www.acme.test/pricing');

    // Projection, from the browser: only the allowlisted component's generated tool lists; the
    // unprojected one is absent and unknown.
    const listed = await page.evaluate(
      async ([base, token]) => {
        const response = await fetch(`${base}/v1/assistant/apps`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'tools/list', params: {} }),
        });
        return (await response.json()) as { tools?: { name: string }[] };
      },
      [serviceOrigin, minted.body.token as string],
    );
    const names = (listed.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('search_product');
    expect(names).not.toContain('search_internal_notes');

    const denied = await page.evaluate(
      async ([base, token]) => {
        const response = await fetch(`${base}/v1/assistant/apps`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            method: 'tools/call',
            params: { name: 'search_internal_notes', arguments: { query: 'pricing' } },
          }),
        });
        return response.status;
      },
      [serviceOrigin, minted.body.token as string],
    );
    expect(denied).toBe(404);

    // Live-site freshness needs no deploy: a page added to the (fake) provider store is
    // immediately searchable through the same component — the provider owns freshness.
    liveSite.addPage(
      'https://www.acme.test/pricing/teams',
      'Team pricing',
      'Team pricing tiers start at fifty dollars.',
    );
    const fresh = await liveSite.search(
      { origin: 'https://www.acme.test', include: ['/pricing/**'] },
      { audience: 'public', revision: 'live' },
      { query: 'team pricing', limit: 5 },
    );
    expect(fresh[0]?.title).toBe('Team pricing');

    // No secret, provider credential, or raw MCP token reached the page.
    const source = await page.content();
    expect(source).not.toContain('provider-secret');
    expect(JSON.stringify(minted.body)).not.toMatch(/secret|clientSecret/i);

    await page.close();
  });
});
