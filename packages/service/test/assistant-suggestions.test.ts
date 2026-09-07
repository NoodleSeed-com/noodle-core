import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';
import { readAssistantEvents } from './assistant-sse-test-helpers.js';
import { EMBEDDED_ASSISTANT_MANIFEST } from './embedded-assistant-fixtures.js';

const ORIGIN = 'https://app.example.com';

describe('assistant suggested prompts', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(manifest = EMBEDDED_ASSISTANT_MANIFEST) {
    const registry = new ServerRegistry();
    const scope = { level: 'env' as const, org: 'acme', app: 'support', env: 'prod' };
    for (const [kind, name, value] of [
      ['variable', 'ASSISTANT_MODEL_BASE_URL', 'https://models.example/v1'],
      ['variable', 'ASSISTANT_MODEL', 'acme-model'],
      ['secret', 'ASSISTANT_MODEL_API_KEY', 'provider-key'],
    ] as const) {
      await registry.configStore.setConfigValue({ kind, scope, name, value });
    }
    const deployed = await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, manifest, {
      accessMode: 'public',
    });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    const modelFetch = vi.fn<typeof fetch>();
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, modelFetch };
  }

  async function mint(base: string) {
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const response = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: ORIGIN,
        user: { id: 'user-1' },
        context: { page: 'billing' },
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      readonly token: string;
      readonly endpoints: Readonly<Record<string, string>>;
    };
  }

  function headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    };
  }

  function modelResponse(content: string): Response {
    return Response.json({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
  }

  it('generates one initial set from fresh context and replays it without another model call', async () => {
    const { base, modelFetch } = await start();
    modelFetch.mockResolvedValue(
      modelResponse('{"prompts":["Review my billing options","Show account limits"]}'),
    );
    const session = await mint(base);
    expect(session.endpoints.suggestions).toBe(`${base}/v1/assistant/suggestions`);

    const requestBody = {
      clientContext: { locale: 'en-GB', timeZone: 'Europe/London' },
      pageContext: { selectedPlan: 'growth' },
      modelContext: { structuredContent: { panel: 'billing' } },
    };
    const first = await fetch(session.endpoints.suggestions ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify(requestBody),
    });
    const firstStream = await first.text();
    expect(first.status).toBe(200);
    expect(firstStream).toContain('event: suggested_prompts');
    expect(firstStream).toContain('Review my billing options');

    const replay = await fetch(session.endpoints.suggestions ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify(requestBody),
    });
    expect(await replay.text()).toBe(firstStream);
    expect(modelFetch).toHaveBeenCalledOnce();
    const modelRequest = String(modelFetch.mock.calls[0]?.[1]?.body);
    expect(modelRequest).toContain('Help the signed-in customer use Acme.');
    expect(modelRequest).toContain('billing');
    expect(modelRequest).toContain('growth');
    expect(modelRequest).toContain('Europe/London');
    expect(modelRequest).toContain('Generate two or three concise messages');
  });

  it.each([
    ['a configured list', '[Ask me]'],
    ['an explicit empty list', '[]'],
  ])('does not generate initial prompts for %s', async (_label, yamlValue) => {
    const manifest = EMBEDDED_ASSISTANT_MANIFEST.replace(
      '    layout: { mode: floating, position: bottom-right }',
      `    suggestedPrompts: ${yamlValue}\n    layout: { mode: floating, position: bottom-right }`,
    );
    const { base, modelFetch } = await start(manifest);
    const session = await mint(base);
    const response = await fetch(session.endpoints.suggestions ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: '{}',
    });
    expect(await response.text()).toBe('event: done\ndata: {}\n\n');
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it('emits and replays model-generated follow-ups without adding them to transcript history', async () => {
    const { base, modelFetch } = await start();
    modelFetch
      .mockResolvedValueOnce(modelResponse('Your Growth plan includes ten seats.'))
      .mockResolvedValueOnce(
        modelResponse('{"prompts":["Compare seat limits","Show upgrade options"]}'),
      );
    const session = await mint(base);
    const turn = await fetch(session.endpoints.turns ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ message: 'What is included?', suggestions: true }),
    });
    const stream = await turn.text();
    expect(stream).toContain('Your Growth plan includes ten seats.');
    expect(stream).toContain('event: suggested_prompts');
    expect(stream).toContain('Compare seat limits');
    expect(modelFetch).toHaveBeenCalledTimes(2);
    const suggestionRequest = JSON.parse(String(modelFetch.mock.calls[1]?.[1]?.body)) as {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly tools?: readonly unknown[];
      readonly tool_choice?: string;
    };
    expect(suggestionRequest.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'What is included?' }),
        expect.objectContaining({
          role: 'assistant',
          content: 'Your Growth plan includes ten seats.',
        }),
      ]),
    );
    expect(suggestionRequest.tools).toEqual([]);
    expect(suggestionRequest.tool_choice).toBe('none');

    const transcript = await fetch(session.endpoints.transcript ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: '{}',
    });
    const events = await readAssistantEvents(transcript);
    expect(events).toEqual([
      { event: 'message_started', data: { message: 'What is included?' } },
      { event: 'content', data: { delta: 'Your Growth plan includes ten seats.' } },
      { event: 'message_completed', data: {} },
      {
        event: 'suggested_prompts',
        data: {
          phase: 'follow_up',
          prompts: ['Compare seat limits', 'Show upgrade options'],
        },
      },
      { event: 'done', data: {} },
    ]);
  });

  it('does no hidden suggestion work for a legacy request and fails malformed opt-in output softly', async () => {
    const { base, modelFetch } = await start();
    const session = await mint(base);
    modelFetch.mockResolvedValueOnce(modelResponse('First answer.'));
    const legacy = await fetch(session.endpoints.turns ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: '{"message":"Legacy client"}',
    });
    expect(await legacy.text()).not.toContain('suggested_prompts');
    expect(modelFetch).toHaveBeenCalledOnce();

    modelFetch
      .mockResolvedValueOnce(modelResponse('Second answer.'))
      .mockResolvedValueOnce(modelResponse('not json'));
    const optedIn = await fetch(session.endpoints.turns ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: '{"message":"New client","suggestions":true}',
    });
    const stream = await optedIn.text();
    expect(stream).toContain('Second answer.');
    expect(stream).not.toContain('suggested_prompts');
    expect(stream).not.toContain('event: error');

    const tooLate = await fetch(session.endpoints.suggestions ?? '', {
      method: 'POST',
      headers: headers(session.token),
      body: '{}',
    });
    expect(await tooLate.text()).toBe('event: done\ndata: {}\n\n');
    expect(modelFetch).toHaveBeenCalledTimes(3);
  });
});
