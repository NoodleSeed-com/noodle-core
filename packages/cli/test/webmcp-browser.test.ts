import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
  ServerRegistry,
} from '@noodle-borg/service';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The WebMCP provider bridge (ADR 0220), in a real browser, through the pasted snippet.
 *
 * `packages/assistant/test/webmcp-bridge.test.ts` proves the decisions; only this can prove the wiring:
 * the shipped `embed.js` bundle, mounted from the one line a customer pastes, discovers the browser's
 * `document.modelContext`, registers the session's projected tools with it, and executes one through the
 * apps bridge against a loopback service with Chromium enforcing CORS the whole way.
 *
 * `document.modelContext` is polyfilled because Chrome serves it only behind the origin trial. The
 * polyfill is pinned to the W3C WebML CG draft of 2026-07-28 — the same draft `webmcp-bridge.ts` is
 * written against, and the one that renamed this from `navigator.modelContext`. If Chrome's shipped
 * shape moves, this polyfill and that module move together.
 */

let browser: Browser;
const servers: Server[] = [];

beforeAll(async () => {
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

/**
 * Records what the page registered, and lets the test drive one registration like an agent would.
 *
 * Shaped to Chrome's documented imperative API rather than to this repository's port: registration is
 * async, returns no handle, and withdrawal happens by aborting the signal it was handed
 * (developer.chrome.com/docs/ai/webmcp/imperative-api). A polyfill that returned a handle would have
 * proved only that the bridge agrees with itself — the gap #1464 was filed for.
 */
const MODEL_CONTEXT_POLYFILL = `
  window.__registered = [];
  document.modelContext = {
    async registerTool(descriptor, options) {
      window.__registered.push(descriptor);
      options?.signal?.addEventListener('abort', () => {
        window.__registered = window.__registered.filter((entry) => entry !== descriptor);
        window.__unregistered = (window.__unregistered ?? 0) + 1;
      });
    },
    getTools() { return window.__registered.map(({ execute, ...rest }) => rest); },
    executeTool(name, args) {
      const tool = window.__registered.find((entry) => entry.name === name);
      return tool ? tool.execute(args ?? {}) : Promise.reject(new Error('unknown tool'));
    },
  };
`;

describe('the WebMCP provider bridge in a real browser', () => {
  it('registers the session projection and executes a tool through the apps bridge', async () => {
    const { serviceOrigin, embedId } = await deployment({ webmcp: true });

    const page = await browser.newPage();
    await page.addInitScript(MODEL_CONTEXT_POLYFILL);
    await servePage(page, serviceOrigin, embedId);
    await page.goto(`${SITE}/`);
    await openAssistant(page);

    // Registration follows the session, and the session is minted lazily on first open.
    await page.waitForFunction('window.__registered.length > 0', undefined, { timeout: 20_000 });

    const registered = (await page.evaluate('window.__registered.map((t) => t.name)')) as string[];
    // `ask` is the surface's one allowlisted capability. `internal_audit` exists on the server and is
    // absent from this surface's projection, so a browser agent never learns it is there.
    expect(registered).toEqual(['ask']);

    const schema = await page.evaluate('window.__registered[0].inputSchema');
    expect(schema).toMatchObject({ type: 'object' });
    expect(await page.evaluate('window.__registered[0].annotations')).toMatchObject({
      readOnlyHint: true,
    });

    // An agent calling the tool: through `document.modelContext`, out over the apps bridge, back with
    // the real result — every hop enforced by the browser and the service, not by the test.
    const result = (await page.evaluate(
      'document.modelContext.executeTool("ask", {})',
    )) as WebMcpResult;
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('declarative platform');

    // Nothing about the bridge put a credential on the page.
    expect(await page.content()).not.toContain('provider-secret');
    await page.close();
  });

  /**
   * Regression: `resetSession()` and `reconnect()` drop the client *and* unsubscribe from its events,
   * so the `session_reset` handler can never run. Without an explicit withdrawal the registrations
   * outlived the session, leaving a browser agent holding a retired authenticated session.
   */
  it('withdraws every registration when the session is reset', async () => {
    const { serviceOrigin, embedId } = await deployment({ webmcp: true });

    const page = await browser.newPage();
    await page.addInitScript(MODEL_CONTEXT_POLYFILL);
    await servePage(page, serviceOrigin, embedId);
    await page.goto(`${SITE}/`);
    await openAssistant(page);
    await page.waitForFunction('window.__registered.length > 0', undefined, { timeout: 20_000 });

    const registered = (await page.evaluate('window.__registered.length')) as number;
    await page.evaluate('document.querySelector("noodle-assistant").resetSession()');

    expect(await page.evaluate('window.__unregistered ?? 0')).toBe(registered);
    // What an agent sees, not only what the bridge did: the same `getTools()` call step 3 of
    // docs/runbooks/webmcp-demo.md makes in real Chrome now answers with nothing.
    expect(await page.evaluate('document.modelContext.getTools().length')).toBe(0);
    await page.close();
  });

  /**
   * The shipped demo page, not a page this test wrote.
   *
   * `examples/acme-discovery/site/index.html` is what a reader copies, and a snippet that has drifted
   * — a stale attribute name, a mangled tag — fails silently: the page renders, the panel never
   * mounts, and only a browser notices. The deployment below is the harness's own; what is under test
   * is the file's markup, with nothing rewritten but the two attributes that have to point somewhere
   * local. Reading `examples/` rather than a copied fixture is the point of this one: a fixture would
   * prove a copy works. This is the browser lane's shipped-surface proof, the case the fixture rule
   * carves out, and `dev.test.ts` already reads `examples/hello` the same way.
   */
  it('mounts and registers from the example demo page as shipped', async () => {
    const { serviceOrigin, embedId } = await deployment({ webmcp: true });

    const page = await browser.newPage();
    await page.addInitScript(MODEL_CONTEXT_POLYFILL);
    await page.route(`${SITE}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: demoPage(serviceOrigin, embedId) }),
    );
    await page.goto(`${SITE}/`);

    // The listings are the page's own markup: without them the harness served the wrong file. Which
    // getaways they name is `examples/acme-discovery/test/site-page.test.ts`'s business, not this
    // test's, so reordering or renaming one does not fail the browser lane.
    expect(await page.locator('.listing-name').count()).toBeGreaterThan(2);

    await openAssistant(page);
    await page.waitForFunction('window.__registered.length > 0', undefined, { timeout: 20_000 });
    expect(await page.evaluate('window.__registered.map((t) => t.name)')).toEqual(['ask']);
    await page.close();
  });

  /**
   * The shape both shipped demos use: the deployment says nothing, the `mixed` marketing surface says
   * yes. The gateway resolves `webmcp` from the surface the session was minted on, and a mixed surface
   * mints `public` sessions — but the resolver matched only the literal `public` mode, so this exact
   * configuration produced an embed that never registered anything. Only a run through the real
   * session route shows that; the manifest looked right and the unit tests used plain `public`.
   */
  it('registers from a mixed surface whose opt-in is per-surface, not per-deployment', async () => {
    const { serviceOrigin, embedId } = await deployment({ webmcp: false, mixedSurfaceOptIn: true });

    const page = await browser.newPage();
    await page.addInitScript(MODEL_CONTEXT_POLYFILL);
    await servePage(page, serviceOrigin, embedId);
    await page.goto(`${SITE}/`);
    await openAssistant(page);
    await page.waitForFunction('window.__registered.length > 0', undefined, { timeout: 20_000 });

    expect(await page.evaluate('window.__registered.map((t) => t.name)')).toEqual(['ask']);
    await page.close();
  });

  it('registers nothing when the deployment has not opted in', async () => {
    const { serviceOrigin, embedId } = await deployment({ webmcp: false });

    const page = await browser.newPage();
    await page.addInitScript(MODEL_CONTEXT_POLYFILL);
    await servePage(page, serviceOrigin, embedId);
    await page.goto(`${SITE}/`);
    await openAssistant(page);
    await page.waitForFunction('window.__sessionStarted === true', undefined, { timeout: 20_000 });

    // The assistant works exactly as before; the API is present and simply never used. This is the
    // no-change proof for every customer already running the embed.
    expect(await page.evaluate('window.__registered.length')).toBe(0);
    await page.close();
  });
});

interface WebMcpResult {
  readonly content?: unknown;
  readonly isError?: boolean;
}

/** The one line a customer pastes, plus a hook so the test can tell when a session exists. */
async function servePage(
  page: Awaited<ReturnType<Browser['newPage']>>,
  serviceOrigin: string,
  embedId: string,
): Promise<void> {
  await page.route(`${SITE}/`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body:
        `<!doctype html><title>acme</title>` +
        `<script>addEventListener('assistant-event', (event) => {` +
        `  if (event.detail?.event === 'session_started') window.__sessionStarted = true;` +
        `}, true);</script>` +
        `<script src="${serviceOrigin}/v1/assistant/embed.js" data-embed-id="${embedId}"></script>`,
    }),
  );
}

/** Public embeds mint on first open, never on mount, so the panel has to be opened. */
async function openAssistant(page: Awaited<ReturnType<Browser['newPage']>>): Promise<void> {
  await page.waitForFunction('document.querySelector("noodle-assistant")?.open !== undefined', {
    timeout: 20_000,
  });
  await page.evaluate('document.querySelector("noodle-assistant").open()');
}

/**
 * `webmcp: true` opts the deployment in, the shape W3 shipped with. `mixedSurfaceOptIn` is the shape
 * the first two real opt-ins actually use — noodleseed.com and acme-discovery — a `mixed`
 * (`signIn: true`) surface saying yes while the deployment says nothing. They are not the same path
 * through the gateway, and only one of them was tested until the other turned out to be inert.
 */
async function deployment(options: {
  readonly webmcp: boolean;
  readonly mixedSurfaceOptIn?: boolean;
}) {
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

  const deployed = await registry.deploy(
    { org: 'acme', app: 'site', env: 'prod' },
    manifest(options.webmcp, options.mixedSurfaceOptIn === true),
    { accessMode: 'public' },
  );
  expect(deployed.ok, JSON.stringify(deployed)).toBe(true);

  const embeds = new InMemoryPublicEmbedStore();
  const embed = await embeds.ensure({
    org: 'acme',
    app: 'site',
    env: 'prod',
    surfaceMode: options.mixedSurfaceOptIn ? 'mixed' : 'public',
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
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  return {
    serviceOrigin: `http://127.0.0.1:${(service.address() as AddressInfo).port}`,
    embedId: embed.embedId,
  };
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

function manifest(webmcp: boolean, mixedSurfaceOptIn = false): string {
  return `manifestVersion: "1"
server:
  name: site
  version: 1.0.0
  title: Acme Site
  assistant:
    model: { kind: openai-compatible, baseUrl: "\${env.MODEL_URL}", model: "\${env.MODEL}", apiKey: MODEL_KEY }
    allowedOrigins: ["${SITE}"]${webmcp ? '\n    webmcp: { enabled: true }' : ''}
    surfaces:
      - mode: ${mixedSurfaceOptIn ? 'mixed' : 'public'}
        origins: ["${SITE}"]${mixedSurfaceOptIn ? '\n        webmcp: { enabled: true }' : ''}
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

/**
 * The example's demo page with its snippet aimed at the loopback deployment. Both replacements are
 * asserted, so a page that stops carrying the published snippet fails here instead of quietly being
 * served with an unreachable embed.
 */
function demoPage(serviceOrigin: string, embedId: string): string {
  const source = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'examples', 'acme-discovery', 'site', 'index.html'),
    'utf8',
  );
  const routed = source
    .replace(
      'https://cloud.noodleseed.dev/v1/assistant/embed.js',
      `${serviceOrigin}/v1/assistant/embed.js`,
    )
    .replace(/data-embed-id="pub_[a-z0-9]{20,64}"/u, `data-embed-id="${embedId}"`);
  expect(routed).toContain(`${serviceOrigin}/v1/assistant/embed.js`);
  expect(routed).toContain(`data-embed-id="${embedId}"`);
  return routed;
}
