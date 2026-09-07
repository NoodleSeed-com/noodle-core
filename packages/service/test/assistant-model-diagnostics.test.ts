import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestEventInput } from '@noodle-borg/module';
import { createLogger, type Logger } from '@noodle-borg/transport-http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';
import { EMBEDDED_ASSISTANT_MANIFEST as MANIFEST } from './embedded-assistant-fixtures.js';

describe('embedded assistant model diagnostics', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(
    options: {
      readonly modelResponse?: () => Promise<Response>;
      readonly assistantStore?: InMemoryAssistantStore;
      readonly logger?: Logger;
    } = {},
  ) {
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
    expect(
      (
        await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, MANIFEST, {
          accessMode: 'public',
        })
      ).ok,
    ).toBe(true);
    const modelFetch = vi.fn<typeof fetch>(
      options.modelResponse ??
        (async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: 'Hello from Acme.' } }],
              usage: { prompt_tokens: 10, completion_tokens: 4 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )),
    );
    const usageEvents: RequestEventInput[] = [];
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: options.assistantStore ?? new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
        captureRequestEvent: (event) => usageEvents.push(event),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, modelFetch, usageEvents };
  }

  async function createClient(base: string) {
    const response = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    return response.json();
  }

  async function exchangeSession(base: string) {
    const client = await createClient(base);
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const response = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'https://app.example.com', user: { id: 'customer-1' } }),
    });
    return response.json();
  }

  it('returns and logs a redacted non-retryable model authentication failure', async () => {
    const logLines: string[] = [];
    const { base, modelFetch, usageEvents } = await start({
      modelResponse: async () => new Response('provider secret detail', { status: 401 }),
      logger: createLogger({ sink: (line) => logLines.push(line) }),
    });
    const session = await exchangeSession(base);
    const response = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'customer prompt must stay private' }),
    });
    const body = await response.text();

    expect(body).toContain(
      'event: error\ndata: {"code":"model_auth_failed","status":401,"retryable":false}',
    );
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(usageEvents.at(-1)).toMatchObject({
      errorKind: 'model_auth_failed',
      details: { assistantOutcome: 'failed', modelRequests: 1 },
    });
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: 'assistant.model.failed',
        code: 'model_auth_failed',
        upstreamStatus: 401,
        retryable: false,
        modelSource: 'operator',
        transport: 'chat-completions',
      }),
    );
    expect(`${body}\n${logLines.join('\n')}`).not.toMatch(
      /provider secret detail|customer prompt must stay private|provider-key/,
    );
  });

  it('reports history persistence separately without calling the model a second time', async () => {
    class FailingHistoryStore extends InMemoryAssistantStore {
      override async appendHistory(): Promise<void> {
        throw new Error('private database failure');
      }
    }
    const logLines: string[] = [];
    const { base, modelFetch, usageEvents } = await start({
      assistantStore: new FailingHistoryStore(),
      logger: createLogger({ sink: (line) => logLines.push(line) }),
    });
    const session = await exchangeSession(base);
    const response = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello' }),
    });
    const body = await response.text();

    expect(body).toContain('Hello from Acme.');
    expect(body).toContain(
      'event: error\ndata: {"code":"conversation_state_failed","retryable":false}',
    );
    expect(body).not.toContain('model_transport_failed');
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(usageEvents.at(-1)).toMatchObject({
      errorKind: 'conversation_state_failed',
      details: { assistantOutcome: 'failed', modelRequests: 1 },
    });
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: 'assistant.history.failed' }),
    );
    expect(logLines.join('\n')).not.toContain('private database failure');
  });

  it('diagnoses the active deployment, client credential, origin, and model binding', async () => {
    const { base, modelFetch } = await start();
    const client = await createClient(base);
    const endpoint = `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/doctor`;
    const healthy = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: client.id,
        clientSecret: client.clientSecret,
        origin: 'https://app.example.com',
        userId: 'doctor-user',
      }),
    });

    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({
      ok: true,
      checks: {
        deployment: { ok: true },
        client: { ok: true },
        origin: { ok: true },
        model: { ok: true, transport: 'chat-completions' },
        delegatedCredentials: { ok: true, probes: [] },
      },
    });
    expect(modelFetch).toHaveBeenCalledOnce();

    const broken = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: client.id,
        clientSecret: 'wrong-secret',
        origin: 'https://wrong.example.com',
      }),
    });
    const body = await broken.json();
    expect(body).toMatchObject({
      ok: false,
      checks: { client: { ok: false }, origin: { ok: false } },
    });
    expect(JSON.stringify(body)).not.toMatch(/wrong-secret|nsa_/);
  });

  it('fails doctor with a redacted model category when the provider rejects the probe', async () => {
    const { base, modelFetch } = await start({
      modelResponse: async () => new Response('private provider explanation', { status: 401 }),
    });
    const client = await createClient(base);
    const response = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/doctor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: client.id,
        clientSecret: client.clientSecret,
        origin: 'https://app.example.com',
      }),
    });
    const body = await response.json();

    expect(body).toMatchObject({
      ok: false,
      checks: {
        model: {
          ok: false,
          transport: 'chat-completions',
          code: 'model_auth_failed',
          status: 401,
          retryable: false,
        },
      },
    });
    expect(modelFetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toMatch(
      /private provider explanation|provider-key|acme-model/,
    );
  });
});
