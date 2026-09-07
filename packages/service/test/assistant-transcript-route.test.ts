import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';
import { readAssistantEvents } from './assistant-sse-test-helpers.js';
import { EMBEDDED_ASSISTANT_MANIFEST } from './embedded-assistant-fixtures.js';

/**
 * The bounded visible-transcript endpoint (ADR 0141/0201 amendments 2026-08-26): what a widget may
 * repaint after a navigation. Auth is the shared session gate — current token, pinned origin.
 */
describe('assistant transcript route', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start() {
    const registry = new ServerRegistry();
    const scope = { level: 'env' as const, org: 'acme', app: 'support', env: 'prod' };
    for (const [kind, name, value] of [
      ['variable', 'ASSISTANT_MODEL_BASE_URL', 'https://models.example/v1'],
      ['variable', 'ASSISTANT_MODEL', 'acme-model'],
      ['secret', 'ASSISTANT_MODEL_API_KEY', 'provider-key'],
    ] as const) {
      await registry.configStore.setConfigValue({ kind, scope, name, value });
    }
    const deployed = await registry.deploy(
      { org: 'acme', app: 'support', env: 'prod' },
      `${EMBEDDED_ASSISTANT_MANIFEST}
widgets:
  - name: lookup_card
    tool: lookup
    title: Account preview
    html: '<!doctype html><main data-noodle-widget>Account preview</main>'
`,
      { accessMode: 'public' },
    );
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    const modelFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'Hello from Acme.' } }],
      }),
    );
    const assistantStore = new InMemoryAssistantStore();
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore,
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, assistantStore };
  }

  async function mint(base: string) {
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web' }),
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const minted = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://app.example.com',
        user: { id: 'user-1' },
      }),
    });
    expect(minted.status).toBe(201);
    return (await minted.json()) as {
      readonly token: string;
      readonly endpoints: Readonly<Record<string, string>>;
    };
  }

  async function replayEvents(response: Response) {
    return readAssistantEvents(response);
  }

  it('advertises the endpoint and returns exactly the visible rows', async () => {
    const { base } = await start();
    const session = await mint(base);
    expect(session.endpoints.transcript).toContain('/v1/assistant/transcript');

    const before = await fetch(session.endpoints.transcript, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(before.status).toBe(200);
    expect(await replayEvents(before)).toEqual([{ event: 'done', data: {} }]);

    const turn = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello there' }),
    });
    expect(turn.status).toBe(200);
    await turn.text();

    const after = await fetch(session.endpoints.transcript, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(await replayEvents(after)).toEqual([
      { event: 'message_started', data: { message: 'Hello there' } },
      { event: 'content', data: { delta: 'Hello from Acme.' } },
      { event: 'message_completed', data: {} },
      { event: 'done', data: {} },
    ]);
  });

  it('refuses a missing token and a wrong origin', async () => {
    const { base } = await start();
    const session = await mint(base);

    const anonymous = await fetch(session.endpoints.transcript, {
      method: 'POST',
      headers: { origin: 'https://app.example.com', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(anonymous.status).toBe(401);

    const crossOrigin = await fetch(session.endpoints.transcript, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://evil.example.com',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('re-resolves only the latest view and returns one still-pending interaction', async () => {
    const { base, assistantStore } = await start();
    const minted = await mint(base);
    const now = new Date();
    const session = await assistantStore.getSession(minted.token, now);
    if (!session) throw new Error('expected session');
    await assistantStore.replaceLatestView(session.id, {
      id: 'call_1',
      tool: 'lookup',
      result: { answer: 'ready' },
    });
    await assistantStore.createInteraction({
      kind: 'confirmation',
      sessionId: session.id,
      deploymentId: session.deploymentId,
      tool: 'update_account',
      arguments: { name: 'Acme' },
      review: { name: 'Acme' },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    const response = await fetch(minted.endpoints.transcript, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${minted.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    const events = await replayEvents(response);
    expect(events.find((event) => event.event === 'view_available')?.data).toMatchObject({
      id: 'call_1',
      tool: 'lookup',
      resourceUri: expect.stringMatching(/^ui:\/\//),
      result: { answer: 'ready' },
      replayed: true,
      html: expect.stringContaining('Account preview'),
    });
    expect(events.find((event) => event.event === 'tool_proposed')).toMatchObject({
      data: { tool: 'update_account', arguments: { name: 'Acme' }, requiresConfirmation: true },
    });
  });
});
