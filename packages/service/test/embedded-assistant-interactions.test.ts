import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryAuditStore,
  ServerRegistry,
} from '../src/index.js';

const ORIGIN = 'https://app.example.com';
const MANIFEST = `
manifestVersion: "1"
server:
  name: assistant_interactions
  version: 1.0.0
  title: Assistant interactions
  context:
    defaults:
      locale: en-GB
      timeZone: Asia/Karachi
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    allowedOrigins: [${ORIGIN}]
tools:
  - name: set_nickname
    description: Set the customer nickname.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: true
    inputSchema:
      type: object
      properties:
        nickname: { type: string, default: buddy }
        privateNote: { type: string, writeOnly: true }
    fulfilment:
      steps: []
      output:
        nickname: \${input.nickname}
        proposedLocalDate: \${context.temporal.localDate}
        apiToken: server-only-result
        __noodleResultMeta:
          opaque: must-stay-widget-only
  - name: set_theme
    description: Set the display theme without a platform confirmation.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: false
    inputSchema:
      type: object
      properties:
        theme: { type: string }
      required: [theme]
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        theme: \${input.theme}
        __noodleResultMeta:
          opaque: must-stay-widget-only
  - name: widget_only_theme
    description: A widget-owned theme control that the model must never invoke.
    visibility: [app]
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: false
    inputSchema:
      type: object
      properties:
        theme: { type: string }
      required: [theme]
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        forbiddenExecutionMarker: \${input.theme}
widgets:
  - name: nickname_card
    tool: set_nickname
    title: Nickname
    html: '<!doctype html><main data-bind="nickname"></main>'
  - name: theme_card
    tool: set_theme
    title: Theme
    html: '<!doctype html><main data-bind="theme"></main>'
`;

describe('embedded assistant interactions', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(initialNow = new Date('2030-01-01T00:00:00.000Z')) {
    let currentNow = initialNow;
    const registry = new ServerRegistry();
    const tenant = { org: 'acme', app: 'support', env: 'prod' };
    const scope = { level: 'env' as const, ...tenant };
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
      value: 'assistant-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy(tenant, MANIFEST, { accessMode: 'public' });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    const modelFetch = vi.fn<typeof fetch>();
    const audit = new InMemoryAuditStore({ now: () => currentNow });
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
        audit,
        clock: () => currentNow,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const clientResponse = await fetch(
      `${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"web"}',
      },
    );
    const client = await clientResponse.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const createSession = async (subject: string) => {
      const response = await fetch(`${base}/v1/assistant/sessions`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
        body: JSON.stringify({ origin: ORIGIN, user: { id: subject } }),
      });
      expect(response.status).toBe(201);
      return response.json();
    };

    return {
      base,
      audit,
      modelFetch,
      registry,
      createSession,
      setNow(value: Date) {
        currentNow = value;
      },
    };
  }

  function toolCallResponse(argumentsJson = '{}', tool = 'set_nickname'): Response {
    return new Response(
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
                  function: { name: tool, arguments: argumentsJson },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  function narrationResponse(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  async function propose(
    base: string,
    token: string,
    modelFetch: ReturnType<typeof vi.fn<typeof fetch>>,
    argumentsJson = '{}',
  ) {
    modelFetch.mockReset().mockResolvedValue(toolCallResponse(argumentsJson));
    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ message: 'Set my nickname' }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('event: tool_started');
    const payload = /event: tool_proposed\ndata: ([^\n]+)/.exec(text)?.[1];
    expect(payload).toBeTruthy();
    return JSON.parse(payload ?? '{}') as {
      id: string;
      arguments: { nickname: string; privateNote?: string };
      expiresAt: string;
    };
  }

  function headers(token: string) {
    return {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    };
  }

  it('advertises and preflights the additive interactions endpoint', async () => {
    const { base, createSession } = await start();
    const session = await createSession('customer-1');
    expect(session.endpoints.interactions).toBe(`${base}/v1/assistant/interactions`);

    const response = await fetch(session.endpoints.interactions, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('honors an explicit confirm false action while confirmed writes still fail closed', async () => {
    const { base, createSession, modelFetch } = await start();
    const session = await createSession('customer-1');
    modelFetch
      .mockResolvedValueOnce(toolCallResponse('{"theme":"dark"}', 'set_theme'))
      .mockResolvedValueOnce(narrationResponse('Dark theme enabled.'));

    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ message: 'Use dark mode' }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain('event: tool_proposed');
    expect(text).toContain('event: tool_started');
    expect(text).toContain('event: view_available');
    expect(text.indexOf('event: tool_started')).toBeLessThan(text.indexOf('event: view_available'));
    expect(text).toContain('"id":"model-call-1"');
    expect(text).toContain('"tool":"set_theme"');
    expect(text).toContain('"resourceUri":"ui://assistant_interactions/theme_card"');
    expect(text).toContain('"title":"Theme"');
    expect(text).toContain('"result":{"theme":"dark"}');
    expect(text).not.toContain('must-stay-widget-only');
    expect(text).not.toContain('__noodleResultMeta');
    expect(modelFetch).toHaveBeenCalledTimes(2);
    const followUp = JSON.parse(String(modelFetch.mock.calls[1]?.[1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    expect(followUp.messages.find((message) => message.role === 'tool')?.content).toBe(
      '{"theme":"dark"}',
    );
  });

  it('rejects a hallucinated app-only tool before validation or execution', async () => {
    const { base, createSession, modelFetch } = await start();
    const session = await createSession('customer-1');
    // A fresh Response per call: the model is told once that the tool is unavailable, and this one
    // insists, so the turn ends on the refusal rather than an honest answer.
    modelFetch.mockImplementation(async () =>
      toolCallResponse('{"theme":"forbidden"}', 'widget_only_theme'),
    );

    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ message: 'Use the hidden widget tool' }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('event: error');
    expect(text).toContain('"code":"invalid_model_tool_call"');
    expect(text).not.toContain('forbiddenExecutionMarker');
    expect(modelFetch).toHaveBeenCalledTimes(2);
    const modelRequest = JSON.parse(String(modelFetch.mock.calls[0]?.[1]?.body)) as {
      tools: { function: { name: string } }[];
    };
    expect(modelRequest.tools.map((tool) => tool.function.name)).not.toContain('widget_only_theme');
  });

  it('fails closed before creating a confirmation when its exact arguments cannot be reviewed', async () => {
    const { audit, base, createSession, modelFetch } = await start();
    const session = await createSession('customer-1');
    modelFetch.mockResolvedValue(toolCallResponse(JSON.stringify({ nickname: 'x'.repeat(2_049) })));

    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ message: 'Set a very long nickname' }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('event: error');
    expect(text).toContain('"code":"arguments_not_presentable"');
    expect(text).not.toContain('event: tool_proposed');
    await expect(
      audit.list({ org: 'acme', eventType: 'assistant.interaction.proposed' }),
    ).resolves.toEqual([]);
  });

  it('reviews exact defaulted arguments and accepts them once without client replacement', async () => {
    const { audit, base, createSession, modelFetch } = await start();
    const session = await createSession('customer-1');
    const proposal = await propose(base, session.token, modelFetch);
    expect(proposal.arguments).toEqual({ nickname: 'buddy' });
    expect(proposal.expiresAt).toBe('2030-01-01T00:10:00.000Z');

    const tampered = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({
        id: proposal.id,
        action: 'accept',
        arguments: { nickname: 'client-tampering-is-ignored' },
      }),
    });
    expect(tampered.status).toBe(400);

    modelFetch
      .mockResolvedValueOnce(narrationResponse('Your nickname is now buddy.'))
      .mockResolvedValueOnce(
        narrationResponse('{"prompts":["Review my profile","Change another setting"]}'),
      );
    const response = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action: 'accept', suggestions: true }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: interaction_resolved');
    expect(text).toContain('"action":"accept"');
    expect(text).toContain('event: tool_completed');
    expect(text).toContain('event: view_available');
    expect(text).toContain(`"id":"${proposal.id}"`);
    expect(text).toContain('"resourceUri":"ui://assistant_interactions/nickname_card"');
    expect(text).toContain('"title":"Nickname"');
    expect(text).toContain('"nickname":"buddy"');
    expect(text).not.toContain('client-tampering-is-ignored');
    expect(text).toContain('Your nickname is now buddy.');
    expect(text).toContain('event: suggested_prompts');
    expect(text).toContain('Review my profile');
    expect(modelFetch).toHaveBeenCalledTimes(3);

    await expect(
      audit.list({ org: 'acme', eventType: 'assistant.interaction.resolved' }),
    ).resolves.toEqual([
      expect.objectContaining({
        app: 'support',
        env: 'prod',
        deploymentId: expect.any(String),
        actorSubject: 'customer-1',
        decision: 'allow',
        status: '200',
        details: {
          interactionId: proposal.id,
          kind: 'confirmation',
          tool: 'set_nickname',
          action: 'accept',
          status: 'accepted',
        },
      }),
    ]);
    expect(JSON.stringify(await audit.list({ org: 'acme' }))).not.toContain('buddy');

    const replay = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action: 'accept' }),
    });
    expect(replay.status).toBe(200);
    const replayText = await replay.text();
    expect(replayText).toContain('event: interaction_resolved');
    expect(replayText).toContain('event: tool_completed');
    expect(replayText).toContain('event: view_available');
    expect(replayText).toContain('"replayed":true');
    expect(replayText).toContain('"nickname":"buddy"');
  });

  it('presents a bounded redacted review and never sends sensitive output to the browser or narrator', async () => {
    const { base, createSession, modelFetch } = await start();
    const session = await createSession('customer-1');
    const proposal = await propose(
      base,
      session.token,
      modelFetch,
      '{"nickname":"Noodle","privateNote":"keep-this-server-side"}',
    );

    expect(proposal.arguments).toEqual({ nickname: 'Noodle', privateNote: '[REDACTED]' });

    modelFetch.mockResolvedValue(narrationResponse('The nickname was saved.'));
    const response = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action: 'accept' }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('"apiToken":"[REDACTED]"');
    expect(text).not.toContain('server-only-result');
    expect(text).not.toContain('keep-this-server-side');
    expect(text).not.toContain('must-stay-widget-only');
    expect(text).not.toContain('__noodleResultMeta');
    expect(String(modelFetch.mock.calls.at(-1)?.[1]?.body)).not.toContain('server-only-result');
    expect(String(modelFetch.mock.calls.at(-1)?.[1]?.body)).not.toContain('keep-this-server-side');
    expect(String(modelFetch.mock.calls.at(-1)?.[1]?.body)).not.toContain('must-stay-widget-only');

    const replay = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action: 'accept' }),
    });
    const replayText = await replay.text();
    expect(replayText).toContain('"apiToken":"[redacted]"');
    expect(replayText).not.toContain('server-only-result');
    expect(replayText).not.toContain('keep-this-server-side');
    expect(replayText).not.toContain('must-stay-widget-only');
    expect(replayText).not.toContain('__noodleResultMeta');
  });

  it.each([
    'decline',
    'cancel',
  ] as const)('%s resolves the interaction, executes nothing, and safely replays', async (action) => {
    const { base, createSession, modelFetch } = await start();
    const session = await createSession('customer-1');
    const proposal = await propose(base, session.token, modelFetch, '{"nickname":"Noodle"}');
    modelFetch.mockResolvedValue(narrationResponse(`The change was ${action}d.`));

    const response = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: interaction_resolved');
    expect(text).toContain(`"action":"${action}"`);
    expect(text).not.toContain('event: tool_completed');
    expect(text).toContain(`The change was ${action}d.`);
    expect(String(modelFetch.mock.calls.at(-1)?.[1]?.body)).toContain('was not executed');

    const replay = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('event: interaction_resolved');
  });

  it('rejects a cross-session resolution without consuming the original interaction', async () => {
    const { base, createSession, modelFetch } = await start();
    const owner = await createSession('customer-1');
    const other = await createSession('customer-2');
    const proposal = await propose(base, owner.token, modelFetch);

    const wrongSession = await fetch(other.endpoints.interactions, {
      method: 'POST',
      headers: headers(other.token),
      body: JSON.stringify({ id: proposal.id, action: 'decline' }),
    });
    expect(wrongSession.status).toBe(409);

    modelFetch.mockResolvedValue(narrationResponse('No changes were made.'));
    const ownerResponse = await fetch(owner.endpoints.interactions, {
      method: 'POST',
      headers: headers(owner.token),
      body: JSON.stringify({ id: proposal.id, action: 'decline' }),
    });
    expect(ownerResponse.status).toBe(200);
  });

  it('fails closed when an interaction has expired', async () => {
    const startAt = new Date('2030-01-01T00:00:00.000Z');
    const { base, createSession, modelFetch, setNow } = await start(startAt);
    const session = await createSession('customer-1');
    const proposal = await propose(base, session.token, modelFetch);
    setNow(new Date(startAt.getTime() + 11 * 60_000));

    const response = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action: 'accept' }),
    });
    expect(response.status).toBe(409);
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it('can decline a pending write after its deployment becomes unavailable', async () => {
    const { base, createSession, modelFetch, registry } = await start();
    const session = await createSession('customer-1');
    const proposal = await propose(base, session.token, modelFetch);
    await registry.archiveApp('acme', 'support', '2030-01-01T00:01:00.000Z');

    const response = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action: 'decline' }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: interaction_resolved');
  });

  it('executes and narrates against the immutable context snapshot used for proposal', async () => {
    const proposedAt = new Date('2030-01-01T18:59:00.000Z');
    const { base, createSession, modelFetch, setNow } = await start(proposedAt);
    const session = await createSession('customer-1');
    const proposal = await propose(base, session.token, modelFetch, '{"nickname":"Noodle"}');

    setNow(new Date('2030-01-01T19:01:00.000Z'));
    modelFetch.mockResolvedValue(narrationResponse('Saved using the reviewed date.'));
    const response = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ id: proposal.id, action: 'accept' }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"proposedLocalDate":"2030-01-01"');
    const narrationBody = String(modelFetch.mock.calls.at(-1)?.[1]?.body);
    expect(narrationBody).toContain('User-local date and time: 2030-01-01');
    expect(narrationBody).not.toContain('User-local date and time: 2030-01-02');
  });
});
