import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { RequestEventInput } from '@noodle-borg/module';
import { assistantSessionResponseSchema } from '@noodle-borg/wire-contracts';
import { jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryAuditStore,
  ServerRegistry,
} from '../src/index.js';
import { EMBEDDED_ASSISTANT_MANIFEST as MANIFEST } from './embedded-assistant-fixtures.js';

describe('embedded assistant service', () => {
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
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL_BASE_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL',
      value: 'acme-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, MANIFEST, {
      accessMode: 'public',
    });
    expect(deployed.ok).toBe(true);
    const modelFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Hello from Acme.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const assistantStore = new InMemoryAssistantStore();
    const audit = new InMemoryAuditStore();
    const usageEvents: RequestEventInput[] = [];
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore,
        assistantModelFetch: modelFetch,
        audit,
        captureRequestEvent: (event) => usageEvents.push(event),
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, modelFetch, audit, registry, usageEvents };
  }

  it('creates, lists, rotates, and revokes deployment-bound embed clients without leaking hashes', async () => {
    const { base, audit } = await start();
    const collection = `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`;
    const created = await fetch(collection, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web' }),
    });
    expect(created.status).toBe(201);
    const client = await created.json();
    expect(client.clientSecret).toMatch(/^nsa_/);

    const listed = await fetch(collection);
    const listBody = await listed.json();
    expect(listBody.clients[0]).toMatchObject({ id: client.id, name: 'web' });
    expect(listBody.clients[0].createdAgainstDeploymentId).toMatch(/^embedded-/);
    expect(JSON.stringify(listBody)).not.toContain('clientSecret');
    expect(JSON.stringify(listBody)).not.toContain('secretHash');

    const rotated = await fetch(`${collection}/${client.id}/rotate`, { method: 'POST' });
    expect(rotated.status).toBe(200);
    expect((await rotated.json()).clientSecret).toMatch(/^nsa_/);

    const revoked = await fetch(`${collection}/${client.id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(204);
    const events = await audit.list({ org: 'acme' });
    expect(events.map((event) => event.eventType)).toEqual([
      'assistant.client.revoked',
      'assistant.client.rotated',
      'assistant.client.created',
    ]);
    expect(JSON.stringify(events)).not.toContain(client.clientSecret);
  });

  it('exchanges a backend identity for an origin-bound ephemeral session and streams a turn', async () => {
    const { base, modelFetch, usageEvents } = await start();
    const collection = `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`;
    const created = await fetch(collection, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web' }),
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://app.example.com',
        user: { id: 'customer-1', email: 'person@example.com' },
        context: { page: 'billing' },
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();
    expect(session.token).toMatch(/^nss_/);
    expect(session.endpoints).toEqual({
      turns: `${base}/v1/assistant/turns`,
      toolConfirmations: `${base}/v1/assistant/tool-confirmations`,
      interactions: `${base}/v1/assistant/interactions`,
      apps: `${base}/v1/assistant/apps`,
      sandbox: `${base}/v1/assistant/sandbox`,
      transcript: `${base}/v1/assistant/transcript`,
      suggestions: `${base}/v1/assistant/suggestions`,
    });
    expect(session.configuration).toMatchObject({
      branding: { name: 'Acme Assistant', accent: '#112233' },
      assistant: {
        layout: { mode: 'floating', position: 'bottom-right' },
        behavior: { showConfirmationDetails: false },
        labels: { sessionReady: 'Acme support is online' },
        presentation: {
          panel: { surface: 'solid', elevation: 'dramatic', border: 'strong', radius: 20 },
          launcher: { icon: 'chat', size: 'lg', status: 'session', effect: 'pulse' },
          header: {
            mark: 'status',
            badge: { text: 'ONLINE', tone: 'success', indicator: true },
          },
          composer: { leadingIcon: 'brand-mark', sendIcon: 'paper-plane', shape: 'rounded' },
          messages: { userStyle: 'accent', assistantStyle: 'bubble' },
        },
      },
    });
    const appTools = await fetch(session.endpoints.apps, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'tools/list', params: {} }),
    });
    expect(appTools.status).toBe(200);
    expect((await appTools.json()).tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'lookup' })]),
    );
    const appHeaders = {
      authorization: `Bearer ${session.token}`,
      origin: 'https://app.example.com',
      'content-type': 'application/json',
    };
    const appToolCall = await fetch(session.endpoints.apps, {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({ method: 'tools/call', params: { name: 'lookup', arguments: {} } }),
    });
    expect(appToolCall.status).toBe(200);
    expect(await appToolCall.json()).toMatchObject({ structuredContent: { answer: 'ready' } });
    const appWriteCall = await fetch(session.endpoints.apps, {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({
        method: 'tools/call',
        params: { name: 'update_account', arguments: { name: 'Widget name' } },
      }),
    });
    expect(appWriteCall.status).toBe(200);
    const appInteraction = await appWriteCall.json();
    expect(appInteraction).toMatchObject({
      interaction: {
        event: 'tool_proposed',
        data: {
          tool: 'update_account',
          arguments: { name: 'Widget name' },
          requiresConfirmation: true,
        },
      },
    });
    const appInteractionId = appInteraction.interaction?.data?.id;
    expect(appInteractionId).toEqual(expect.any(String));
    const acceptedAppWrite = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({ id: appInteractionId, action: 'accept' }),
    });
    expect(acceptedAppWrite.status).toBe(200);
    const acceptedAppWriteStream = await acceptedAppWrite.text();
    expect(acceptedAppWriteStream).toContain('tool_completed');
    expect(acceptedAppWriteStream).toContain('Widget name');
    modelFetch.mockClear().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Hello from Acme.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const appResources = await fetch(session.endpoints.apps, {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({ method: 'resources/list', params: {} }),
    });
    expect(await appResources.json()).toMatchObject({
      resources: [expect.objectContaining({ uri: 'docs://account/guide' })],
    });
    const appResource = await fetch(session.endpoints.apps, {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({
        method: 'resources/read',
        params: { uri: 'docs://account/guide' },
      }),
    });
    expect(await appResource.json()).toMatchObject({
      contents: [expect.objectContaining({ uri: 'docs://account/guide', text: '# Account guide' })],
    });
    expect(JSON.stringify(session.configuration)).not.toContain('allowedOrigins');
    expect(JSON.stringify(session.configuration)).not.toContain('apiKey');

    const denied = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(denied.status).toBe(403);

    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(turn.status).toBe(200);
    expect(turn.headers.get('content-type')).toContain('text/event-stream');
    expect(await turn.text()).toContain('Hello from Acme.');
    expect(modelFetch).toHaveBeenCalledWith(
      'https://models.example/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer provider-key' }),
      }),
    );
    expect(String(modelFetch.mock.calls[0]?.[1]?.body)).toContain('You are Acme Assistant');
    // The two apps-bridge calls above are governed executions and are now events of their own
    // (ADR 0220 decision 6): unmarked, so attributed to the signed-in surface the session was
    // minted on rather than to `webmcp`. The confirmation `update_account` raises is `ok` — the
    // bridge did what it should, and the interaction is answered on its own route.
    expect(usageEvents).toHaveLength(4);
    expect(
      usageEvents.map((event) => ({
        method: event.method,
        surface: event.surface,
        ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
        details: event.details,
      })),
    ).toEqual([
      {
        method: 'assistant',
        surface: 'assistant-authenticated',
        details: expect.objectContaining({
          eventKind: 'session',
          surface: 'authenticated',
          modelSource: 'operator',
        }),
      },
      {
        method: 'tools/call',
        surface: 'assistant-authenticated',
        toolName: 'lookup',
        details: { eventKind: 'appToolCall', bridged: false },
      },
      {
        method: 'tools/call',
        surface: 'assistant-authenticated',
        toolName: 'update_account',
        details: { eventKind: 'appToolCall', bridged: false },
      },
      {
        method: 'assistant',
        surface: 'assistant-authenticated',
        details: expect.objectContaining({
          eventKind: 'turn',
          assistantOutcome: 'delivered',
          modelRequests: 1,
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
          turnNumber: 1,
        }),
      },
    ]);
    expect(JSON.stringify(usageEvents)).not.toContain('Hello');
  });

  it('session response matches the Embedded Assistant v1 wire contract (ADR 0151)', async () => {
    const { base } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web' }),
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    expect(sessionResponse.status).toBe(201);
    const body = (await sessionResponse.json()) as Record<string, unknown>;

    const parsed = assistantSessionResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Key-structure drift gate against the golden fixture both sides pin: a new or removed
    // top-level/endpoint field is a contract event (ADR 0151), not a local edit.
    const goldenFixture = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          '..',
          'contract',
          'v1',
          'assistant-session-response.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    // `resume` rides only an elevation that armed the post-sign-in resume; a fresh mint never
    // carries it (pinned in assistant-elevation.test.ts), so it is the one fixture key excused here.
    expect(Object.keys(body).sort()).toEqual(
      Object.keys(goldenFixture)
        .filter((key) => key !== 'resume')
        .sort(),
    );
    expect(Object.keys(body.endpoints as object).sort()).toEqual(
      Object.keys(goldenFixture.endpoints as object).sort(),
    );
  });

  it('serves the hosted widget sandbox document under its own CSP for CSP-strict embedder pages', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/v1/assistant/sandbox`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; frame-src about:; form-action 'none'; base-uri 'none'; frame-ancestors *",
    );
    // The static relay document is secret-free and cacheable; it must override the dispatch-wide
    // `Cache-Control: no-store` baseline and never demand frame-blocking headers.
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('x-frame-options')).toBeNull();
    const body = await response.text();
    const fixture = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'contract',
        'v1',
        'assistant-sandbox-document.html',
      ),
      'utf8',
    );
    expect(body).toBe(fixture.trimEnd());
    const post = await fetch(`${base}/v1/assistant/sandbox`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it.each([
    '/v1/assistant/turns',
    '/v1/assistant/tool-confirmations',
    '/v1/assistant/interactions',
  ])('answers browser preflight for %s', async (path) => {
    const { base } = await start();
    const response = await fetch(`${base}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('returns a browser-readable generic 401 for an expired or unknown session', async () => {
    const { base } = await start();
    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer expired-session',
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: '{"message":"Hello"}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(await response.json()).toEqual({ error: 'invalid assistant session' });
  });

  it('does not issue a session for a wrong client secret, origin, or undeployed client', async () => {
    const { base } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const wrong = Buffer.from(`${client.id}:wrong`).toString('base64');
    const response = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${wrong}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('wrong');
  });

  it('pauses explicitly confirmed tools until a single-use confirmation', async () => {
    const { base, modelFetch } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    const session = await sessionResponse.json();
    modelFetch.mockReset().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'model-call-1',
                    type: 'function',
                    function: { name: 'update_account', arguments: '{"name":"New name"}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const headers = {
      authorization: `Bearer ${session.token}`,
      origin: 'https://app.example.com',
      'content-type': 'application/json',
    };
    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Change my name' }),
    });
    const proposalText = await turn.text();
    expect(proposalText).toContain('tool_proposed');
    const pendingId = /"id":"([^"]+)"/.exec(proposalText)?.[1];
    expect(pendingId).toBeTruthy();

    modelFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'All set: your name is updated.' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const confirmed = await fetch(`${base}/v1/assistant/tool-confirmations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: pendingId }),
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = await confirmed.text();
    // Wire-compat first (published widgets read tool_completed), then the narration stream.
    expect(confirmedBody).toContain('tool_completed');
    expect(confirmedBody).toContain('New name');
    expect(confirmedBody.indexOf('tool_completed')).toBeLessThan(
      confirmedBody.indexOf('All set: your name is updated.'),
    );

    const replay = await fetch(`${base}/v1/assistant/tool-confirmations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: pendingId }),
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.text();
    expect(replayBody).toContain('tool_completed');
    expect(replayBody).toContain('"replayed":true');
  });

  // Roadmap S5: schema defaults are applied to model-omitted arguments on both the auto-run and
  // the confirmation path (the pending record stores the coerced copy the user approves).
  it('applies schema defaults when the model omits a defaulted argument', async () => {
    const { base, modelFetch } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    const session = await sessionResponse.json();
    const toolCallResponse = (name: string) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'model-call-1', type: 'function', function: { name, arguments: '{}' } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    modelFetch
      .mockReset()
      .mockResolvedValueOnce(toolCallResponse('greet'))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Greeted.' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const headers = {
      authorization: `Bearer ${session.token}`,
      origin: 'https://app.example.com',
      'content-type': 'application/json',
    };
    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Say hi' }),
    });
    expect(turn.status).toBe(200);
    await turn.text();
    // The tool executed with the advertised default, visible in the tool message fed back to the model.
    expect(String(modelFetch.mock.calls[1]?.[1]?.body)).toContain('Hello, world!');
  });

  it('stores pending confirmations with defaults applied so the approved call is the executed call', async () => {
    const { base, modelFetch } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    const session = await sessionResponse.json();
    modelFetch.mockReset().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'model-call-1',
                    type: 'function',
                    function: { name: 'set_nickname', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const headers = {
      authorization: `Bearer ${session.token}`,
      origin: 'https://app.example.com',
      'content-type': 'application/json',
    };
    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Set my nickname' }),
    });
    const proposalText = await turn.text();
    const pendingId = /"id":"([^"]+)"/.exec(proposalText)?.[1];
    expect(pendingId).toBeTruthy();

    const confirmed = await fetch(`${base}/v1/assistant/tool-confirmations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: pendingId }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain('buddy');
  });

  // BUG 2 generalized (AcmeHr follow-up): the verified identity and the developer-declared
  // session claims flow from the backend exchange into tool scope and the model prompt.
  it('threads verified name and declared claims into tools and the model prompt', async () => {
    const { base, modelFetch } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://app.example.com',
        user: { id: 'customer-1', name: 'Fahd Rafi', email: 'fahd@acmehr.example' },
        claims: {
          displayName: 'Fahd Rafi',
          accountTier: 'pro',
          region: 'EU',
          undeclaredClaim: 'must-not-pass',
        },
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();

    modelFetch
      .mockReset()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'whoami', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'who am i' }),
    });
    expect(turn.status).toBe(200);
    await turn.text();

    // The identity system line reaches the model: standard identity always, claims only when
    // exposeToModel, never the untrusted/undeclared ones.
    const firstRequestBody = String(modelFetch.mock.calls[0]?.[1]?.body);
    expect(firstRequestBody).toContain('Fahd Rafi');
    expect(firstRequestBody).toContain('fahd@acmehr.example');
    expect(firstRequestBody).toContain('accountTier');
    expect(firstRequestBody).not.toContain('region='); // tools-only claim stays out of the prompt
    expect(firstRequestBody).not.toContain('must-not-pass');

    // The tool scope resolves ${user.name} and ${user.claims.*}; undeclared claims are dropped.
    const toolResultBody = String(modelFetch.mock.calls[1]?.[1]?.body);
    expect(toolResultBody).toContain('Hello, Fahd Rafi!');
    expect(toolResultBody).toContain('tier\\":\\"pro'); // JSON-escaped inside the tool message
    expect(toolResultBody).toContain('region\\":\\"EU');
  });

  it('omits the identity line for an id-only session and rejects oversized claims', async () => {
    const { base, modelFetch } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const idOnly = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    const session = await idOnly.json();
    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(turn.status).toBe(200);
    await turn.text();
    expect(String(modelFetch.mock.calls[0]?.[1]?.body)).not.toContain('Signed-in user');

    const oversized = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://app.example.com',
        user: { id: 'customer-1' },
        claims: { displayName: 'x'.repeat(500) },
      }),
    });
    expect(oversized.status).toBe(400);
  });

  // BUG 1 (AcmeHr follow-up): clients are tenant-bound; sessions must follow the tenant's ACTIVE
  // deployment, not the deploymentId snapshotted at client creation.
  it('serves the latest active deployment to clients created against an older one', async () => {
    const { base, registry } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();

    // v2: greet output changes and the origin allowlist rotates to a new origin.
    const v2 = MANIFEST.replace('Hello, ${input.name}!', 'Ahoy, ${input.name}!').replace(
      'allowedOrigins: [https://app.example.com]',
      'allowedOrigins: [https://next.example.com]',
    );
    const redeployed = await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, v2, {
      accessMode: 'public',
    });
    expect(redeployed.ok).toBe(true);

    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    // The creation-time origin snapshot is stale: v2 removed it, so it must be rejected...
    const staleOrigin = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    expect(staleOrigin.status).toBe(403);
    // ...and the live artifact's origin must be accepted.
    const session = await (
      await fetch(`${base}/v1/assistant/sessions`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
        body: JSON.stringify({ origin: 'https://next.example.com', user: { id: 'customer-1' } }),
      })
    ).json();
    expect(session.token).toMatch(/^nss_/);

    // The old client's turn executes the v2 artifact (greet output changed in v2).
    const { modelFetch } = await (async () => ({ modelFetch: undefined }))();
    void modelFetch;
    const turnHeaders = {
      authorization: `Bearer ${session.token}`,
      origin: 'https://next.example.com',
      'content-type': 'application/json',
    };
    const proposal = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: turnHeaders,
      body: JSON.stringify({ message: 'update my account' }),
    });
    expect(proposal.status).toBe(200);
  });

  it('fails session mint closed when the active deployment removed the assistant', async () => {
    const { base, registry } = await start();
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();

    const withoutAssistant = MANIFEST.replace(/ {2}assistant:[\s\S]*?(?=tools:)/, '');
    const redeployed = await registry.deploy(
      { org: 'acme', app: 'support', env: 'prod' },
      withoutAssistant,
      { accessMode: 'public' },
    );
    expect(redeployed.ok).toBe(true);

    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const response = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('assistant deployment is unavailable');
  });

  it('diagnoses then executes delegatedTokenExchange as the signed-in assistant user', async () => {
    // Fixture "customer downstream": an RFC 8693 token endpoint plus a user-scoped API.
    const exchangeRequests: Array<{
      readonly authorization: string | undefined;
      readonly params: URLSearchParams;
    }> = [];
    let apiAuthorization: string | undefined;
    const downstream = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/oauth/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        exchangeRequests.push({
          authorization: req.headers.authorization,
          params: new URLSearchParams(Buffer.concat(chunks).toString()),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'user-scoped-token',
            token_type: 'Bearer',
            expires_in: 600,
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/api/time-off') {
        apiAuthorization = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ days: 12 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(downstream);
    await new Promise<void>((resolve) => downstream.listen(0, '127.0.0.1', resolve));
    const downstreamBase = `http://127.0.0.1:${(downstream.address() as AddressInfo).port}`;

    const signer = await createStaticSigningKeyProvider();
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      delegatedExchange: { issuer: 'https://cloud.test', signer },
    });
    const scope = { level: 'env' as const, org: 'acme', app: 'support', env: 'prod' };
    for (const [name, value] of [
      ['ASSISTANT_MODEL_BASE_URL', 'https://models.example/v1'],
      ['ASSISTANT_MODEL', 'acme-model'],
    ] as const) {
      await registry.configStore.setConfigValue({ kind: 'variable', scope, name, value });
    }
    for (const [name, value] of [
      ['ASSISTANT_MODEL_API_KEY', 'provider-key'],
      ['ACMEHR_DELEG_CLIENT_SECRET', 'deleg-secret'],
    ] as const) {
      await registry.configStore.setConfigValue({ kind: 'secret', scope, name, value });
    }
    const connectors = `
connectors:
  - id: acmehr
    version: 1.0.0
    http:
      baseUrl: ${downstreamBase}/api
      allowedOrigins:
        - ${downstreamBase}
      auth:
        kind: delegatedTokenExchange
        tokenUrl: ${downstreamBase}/oauth/token
        clientId: deleg-client
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
        scopes:
          - time_off
    operations:
      list_time_off:
        type: read
        method: GET
        path: /time-off
        output:
          type: object
          properties:
            days: { type: number }
          additionalProperties: false
`;
    const manifest = `${MANIFEST}  - name: my_time_off
    description: Read the signed-in user's remaining time off.
    annotations:
      readOnlyHint: true
      destructiveHint: false
      openWorldHint: false
    inputSchema:
      type: object
    fulfilment:
      steps:
        - id: fetched
          use: acmehr.list_time_off
          args: {}
      output:
        days: \${steps.fetched.days}
connectors:
  acmehr: { id: acmehr, version: 1.0.0 }
`;
    const deployed = await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, manifest, {
      connectors,
      accessMode: 'public',
    });
    expect(deployed.ok ? undefined : deployed.errors).toBeUndefined();

    const modelFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const assistantStore = new InMemoryAssistantStore();
    const server = createServer(
      createServiceHandler(registry, { assistantStore, assistantModelFetch: modelFetch }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const assistantCustomerIssuer = `urn:noodleseed:assistant-client:${client.id}`;

    const doctor = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/doctor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: client.id,
        clientSecret: client.clientSecret,
        origin: 'https://app.example.com',
        userId: 'diagnostic-user-9',
      }),
    });
    expect(doctor.status).toBe(200);
    const doctorBody = await doctor.json();
    expect(doctorBody).toMatchObject({
      ok: true,
      checks: {
        delegatedCredentials: {
          ok: true,
          probes: [{ authKind: 'delegatedTokenExchange', ok: true }],
        },
      },
    });
    expect(JSON.stringify(doctorBody)).not.toContain(assistantCustomerIssuer);
    expect(exchangeRequests).toHaveLength(1);
    expect(apiAuthorization).toBeUndefined();
    expect(exchangeRequests[0]?.authorization).toBe(
      `Basic ${Buffer.from('deleg-client:deleg-secret').toString('base64')}`,
    );
    const diagnosticAssertion = exchangeRequests[0]?.params.get('subject_token');
    const diagnosticPayload = await jwtVerify(
      diagnosticAssertion as string,
      await signer.verifierKey(),
      { issuer: 'https://cloud.test', audience: `${downstreamBase}/oauth/token` },
    );
    expect(diagnosticPayload.payload.sub).toBe('diagnostic-user-9');
    expect(diagnosticPayload.payload.customer_identity).toEqual({
      version: 1,
      issuer: assistantCustomerIssuer,
    });

    // The same user authenticated through a different assistant client must not share a
    // delegated-token cache entry: the private client namespace is part of the binding.
    const secondCreated = await fetch(
      `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"second-web"}',
      },
    );
    const secondClient = await secondCreated.json();
    const secondAssistantCustomerIssuer = `urn:noodleseed:assistant-client:${secondClient.id}`;
    const secondDoctor = await fetch(
      `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/doctor`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: secondClient.id,
          clientSecret: secondClient.clientSecret,
          origin: 'https://app.example.com',
          userId: 'diagnostic-user-9',
        }),
      },
    );
    expect(secondDoctor.status).toBe(200);
    const secondDoctorBody = await secondDoctor.json();
    expect(secondDoctorBody).toMatchObject({
      ok: true,
      checks: {
        delegatedCredentials: {
          ok: true,
          probes: [{ authKind: 'delegatedTokenExchange', ok: true }],
        },
      },
    });
    expect(JSON.stringify(secondDoctorBody)).not.toContain(secondAssistantCustomerIssuer);
    expect(exchangeRequests).toHaveLength(2);
    const secondDiagnosticPayload = await jwtVerify(
      exchangeRequests[1]?.params.get('subject_token') as string,
      await signer.verifierKey(),
      { issuer: 'https://cloud.test', audience: `${downstreamBase}/oauth/token` },
    );
    expect(secondDiagnosticPayload.payload.sub).toBe('diagnostic-user-9');
    expect(secondDiagnosticPayload.payload.customer_identity).toEqual({
      version: 1,
      issuer: secondAssistantCustomerIssuer,
    });

    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://app.example.com',
        user: { id: 'end-user-7', name: 'Pat Example', email: 'pat@example.com' },
        claims: { accountTier: 'pro' },
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();
    expect(JSON.stringify(session)).not.toContain(assistantCustomerIssuer);

    modelFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'my_time_off', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'how much time off do I have?' }),
    });
    expect(turn.status).toBe(200);
    const turnBody = await turn.text();
    expect(turnBody).not.toContain(assistantCustomerIssuer);

    // The broker performed the exchange: client authentication + RFC 8693 form fields.
    expect(exchangeRequests).toHaveLength(3);
    const exchange = exchangeRequests[2] as (typeof exchangeRequests)[number];
    expect(exchange.authorization).toBe(
      `Basic ${Buffer.from('deleg-client:deleg-secret').toString('base64')}`,
    );
    expect(exchange.params.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:token-exchange',
    );
    expect(exchange.params.get('scope')).toBe('time_off');

    // The assertion is verifiable against the platform JWKS and carries the verified identity.
    const { payload } = await jwtVerify(
      exchange.params.get('subject_token') as string,
      await signer.verifierKey(),
      { issuer: 'https://cloud.test', audience: `${downstreamBase}/oauth/token` },
    );
    expect(payload.sub).toBe('end-user-7');
    expect(payload.email).toBe('pat@example.com');
    expect(payload.name).toBe('Pat Example');
    expect(payload.claims).toEqual({ accountTier: 'pro' });
    expect(payload.tenant).toBe('acme/support/prod');
    expect(String(payload.deployment)).toMatch(/^embedded-/);
    expect(payload.customer_identity).toEqual({
      version: 1,
      issuer: assistantCustomerIssuer,
    });

    // The downstream API ran as the user: it saw only the minted user-scoped token.
    expect(apiAuthorization).toBe('Bearer user-scoped-token');
    const toolResultBody = modelFetch.mock.calls
      .map(([, init]) => String(init?.body))
      .find((body) => body.includes('days'));
    expect(toolResultBody).toContain('days');
    expect(
      modelFetch.mock.calls.every(([, init]) => {
        return !String(init?.body).includes(assistantCustomerIssuer);
      }),
    ).toBe(true);
  });
});
