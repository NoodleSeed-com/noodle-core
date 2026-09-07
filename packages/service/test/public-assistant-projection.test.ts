import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryAssistantStore } from '@noodle-borg/assistant-gateway';
import { MCP_APP_MIME_TYPE, type RuntimeArtifact } from '@noodle-borg/compiler';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantRouteDeps } from '../src/routes/assistant.js';
import { handleAssistantAppRequest } from '../src/routes/assistant.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ORIGIN = 'https://www.acme.test';
const APP_ORIGIN = 'https://app.acme.test';
const TENANT = { org: 'acme', app: 'site', env: 'prod' };
const EMBED = 'pub_aaaaaaaaaaaaaaaaaaaaaaaa';

const tool = (name: string, resourceUri?: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object' as const },
  fulfilment: { kind: 'flow' as const, steps: [] },
  ...(resourceUri ? { _meta: { ui: { resourceUri } } } : {}),
});

const ARTIFACT = {
  artifactSchemaVersion: '0.15.0',
  resolution: 'resolved',
  source: { manifestName: 'acme', manifestVersion: '2', coreVersion: '2' },
  server: {
    name: 'acme',
    title: 'Acme',
    version: '1.0.0',
    assistant: {
      model: { kind: 'openai-compatible', baseUrl: 'https://m.test', model: 'm', apiKey: 'K' },
      allowedOrigins: [ORIGIN, APP_ORIGIN],
      surfaces: [
        {
          mode: 'public',
          origins: [ORIGIN],
          capabilities: [{ kind: 'tool', name: 'ask_product' }],
        },
        // No capability list: the authored whole-server intent for the in-app embed.
        { mode: 'authenticated', origins: [APP_ORIGIN] },
      ],
    },
  },
  capabilities: { tools: [] },
  tools: [tool('ask_product', 'ui://acme/card'), tool('internal_audit', 'ui://acme/audit')],
  resources: [
    { uri: 'ui://acme/card', mimeType: MCP_APP_MIME_TYPE, fulfilment: { kind: 'flow' } },
    { uri: 'ui://acme/audit', mimeType: MCP_APP_MIME_TYPE, fulfilment: { kind: 'flow' } },
  ],
} as unknown as RuntimeArtifact;

/**
 * The runtime half of ADR 0201's boundary. The compiler already refuses to *compile* a public surface
 * that selects an identity-touching capability; this proves the surface cannot reach past its selection
 * at request time either — the backstop for anything the compiler could not close over.
 *
 * It also closes a live defect: `resources/list` and `resources/read` applied no caller filter at all,
 * so any artifact URI was readable by any session.
 */
describe('public session artifact projection', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(kind: 'public' | 'authenticated') {
    const store = new InMemoryAssistantStore();
    const created = await store.createClient({
      name: 'web',
      tenant: TENANT,
      deploymentId: 'dep_1',
      allowedOrigins: [ORIGIN],
      now: NOW,
    });
    const { token } = await store.createSession({
      clientId: created.client.id,
      tenant: TENANT,
      deploymentId: 'dep_1',
      origin: kind === 'public' ? ORIGIN : APP_ORIGIN,
      boundSurface: kind === 'public' ? 'public' : 'authenticated',
      ...(kind === 'public' ? { publicEmbedId: EMBED } : {}),
      caller:
        kind === 'public'
          ? { subject: 'anon_1', identityKind: 'anonymous' }
          : { subject: 'user_1', identityKind: 'customer' },
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      absoluteExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    });

    let serviceBase = '';
    const deps = {
      store,
      registry: { get: () => Promise.resolve({ served: { artifact: ARTIFACT, deps: {} } }) },
      serviceBase: () => serviceBase,
      clock: () => NOW,
      maxBody: 64 * 1024,
    } as unknown as AssistantRouteDeps;

    const server = createServer((req, res) => {
      void handleAssistantAppRequest(req, res, deps).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'unknown test handler failure');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serviceBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base: serviceBase, token };
  }

  const app = (
    base: string,
    token: string,
    method: string,
    params: unknown = {},
    origin = ORIGIN,
  ) =>
    fetch(`${base}/v1/assistant/apps`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        origin,
      },
      body: JSON.stringify({ method, params }),
    });

  it('hides an unselected tool from the model', async () => {
    const { base, token } = await start('public');
    const body = await (await app(base, token, 'tools/list')).json();
    const names = (body.tools ?? []).map((t: { name: string }) => t.name);

    expect(names).toContain('ask_product');
    expect(names).not.toContain('internal_audit');
  });

  it('hides an unselected tool’s widget from resources/list', async () => {
    const { base, token } = await start('public');
    const body = await (await app(base, token, 'resources/list')).json();
    const uris = (body.resources ?? []).map((r: { uri: string }) => r.uri);

    expect(uris).toContain('ui://acme/card');
    expect(uris).not.toContain('ui://acme/audit');
  });

  it('404s a resources/read for a widget outside the surface', async () => {
    const { base, token } = await start('public');
    // Before projection this returned the resource: any URI was readable by any session.
    const response = await app(base, token, 'resources/read', { uri: 'ui://acme/audit' });
    expect(response.status).toBe(404);
  });

  it('still serves a resource inside the surface', async () => {
    const { base, token } = await start('public');
    expect((await app(base, token, 'resources/read', { uri: 'ui://acme/card' })).status).not.toBe(
      404,
    );
  });

  it('leaves an authenticated session the whole artifact when its surface declares no allowlist', async () => {
    const { base, token } = await start('authenticated');
    const body = await (await app(base, token, 'tools/list', {}, APP_ORIGIN)).json();
    const names = (body.tools ?? []).map((t: { name: string }) => t.name);

    // The session binds the authenticated surface exactly; an omitted capability list there is the
    // authored whole-server intent, so the in-app embed keeps its reach — by binding, not by union.
    expect(names).toContain('internal_audit');
    expect(
      (await app(base, token, 'resources/read', { uri: 'ui://acme/audit' }, APP_ORIGIN)).status,
    ).not.toBe(404);
  });
});
