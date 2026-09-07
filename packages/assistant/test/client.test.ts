import { describe, expect, it, vi } from 'vitest';
import {
  AssistantClientError,
  type AssistantClientEvent,
  createAssistantClient,
} from '../src/client.js';

function sessionResponse(
  token = 'session-token',
  endpoints: Readonly<Record<string, string>> = {
    turns: 'https://cloud.example/v1/assistant/turns',
    toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
    interactions: 'https://cloud.example/v1/assistant/interactions',
  },
): Response {
  return Response.json({
    token,
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints,
    configuration: { branding: { name: 'Acme Assistant' } },
  });
}

function eventStream(...frames: readonly string[]): Response {
  return new Response(`${frames.join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('createAssistantClient', () => {
  it('eagerly exchanges a session and publishes its server configuration', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(sessionResponse());
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
      context: { page: 'time-off' },
    });
    client.subscribe((event) => events.push(event));

    await client.connect();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/assistant/session',
      expect.objectContaining({
        credentials: 'same-origin',
        body: JSON.stringify({ context: { page: 'time-off' } }),
      }),
    );
    expect(events).toContainEqual({
      event: 'session_started',
      data: {
        expiresAt: '2030-01-01T00:00:00Z',
        configuration: { branding: { name: 'Acme Assistant' } },
      },
    });
  });

  it('drops malformed authenticated presentation configuration', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
        },
        configuration: {
          assistant: { behavior: { showConfirmationDetails: 'sometimes' } },
        },
      }),
    );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));

    await client.connect();

    expect(events).toContainEqual({
      event: 'session_started',
      data: { expiresAt: '2030-01-01T00:00:00Z' },
    });
  });

  it('auto-runs an advertised post-sign-in resume: one POST, streamed, exactly one attempt', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'elevated-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          },
          resume: { tool: 'time_off_balance' },
        }),
      )
      .mockResolvedValueOnce(
        eventStream(
          'event: content\ndata: {"delta":"You have 12 days left."}',
          'event: done\ndata: {}',
        ),
      );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));

    await client.connect();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, turnRequest] = fetchMock.mock.calls[1] ?? [];
    expect(JSON.parse(String((turnRequest as RequestInit).body))).toEqual({ resume: true });
    expect((turnRequest as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer elevated-token',
    });
    expect(events).toContainEqual({ event: 'resume_started', data: { tool: 'time_off_balance' } });
    expect(events).toContainEqual({
      event: 'content',
      data: { delta: 'You have 12 days left.' },
    });
    expect(events).toContainEqual({ event: 'message_completed', data: {} });
    // No user bubble opened the operation: nothing echoed a message the visitor never typed.
    expect(events.some((event) => event.event === 'message_started')).toBe(false);

    // Exactly one attempt: a later reconnect with a live session never re-fires it.
    await client.connect();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders a 409 nothing_to_resume as silence and keeps the session', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'elevated-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          },
          resume: { tool: 'time_off_balance' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'nothing to resume', code: 'nothing_to_resume' }, { status: 409 }),
      );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));

    await client.connect();

    expect(client.hasSession()).toBe(true);
    expect(events.some((event) => event.event === 'resume_started')).toBe(false);
    expect(events.some((event) => event.event === 'error')).toBe(false);
  });

  it('surfaces a resume stream failure as an error event without failing connect', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'elevated-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          },
          resume: { tool: 'time_off_balance' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ error: 'service unavailable' }, { status: 503 }));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.hasSession()).toBe(true);
  });

  it('a session without the hint makes no extra request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(sessionResponse());
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.connect();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exposes the additive hosted sandbox endpoint and returns undefined on legacy services', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse('session-token', {
        turns: 'https://cloud.example/v1/assistant/turns',
        toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
        sandbox: 'https://cloud.example/v1/assistant/sandbox',
      }),
    );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.connect();
    expect(client.appSandboxUrl?.()).toBe('https://cloud.example/v1/assistant/sandbox');

    const legacyFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(sessionResponse());
    const legacy = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: legacyFetch,
    });
    await legacy.connect();
    expect(legacy.appSandboxUrl?.()).toBeUndefined();
  });

  it('keeps an app tool call pending through confirmation and resolves it as an MCP result', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse('session-token', {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          interactions: 'https://cloud.example/v1/assistant/interactions',
          apps: 'https://cloud.example/v1/assistant/apps',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          interaction: {
            event: 'tool_proposed',
            data: {
              id: 'app_int_1',
              tool: 'update_account',
              arguments: { name: 'Widget name' },
              requiresConfirmation: true,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        eventStream(
          'event: interaction_resolved\ndata: {"id":"app_int_1","action":"accept"}',
          'event: tool_completed\ndata: {"id":"app_int_1","tool":"update_account","result":{"updated":"Widget name"}}',
          'event: done\ndata: {}',
        ),
      );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));
    await client.connect();

    let settled = false;
    const appCall = client
      .requestApp('tools/call', {
        name: 'update_account',
        arguments: { name: 'Widget name' },
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        event: 'tool_proposed',
        data: {
          id: 'app_int_1',
          tool: 'update_account',
          arguments: { name: 'Widget name' },
          requiresConfirmation: true,
        },
      }),
    );
    expect(settled).toBe(false);

    await client.respond('app_int_1', { action: 'accept' });

    await expect(appCall).resolves.toEqual({
      content: [{ type: 'text', text: '{"updated":"Widget name"}' }],
      structuredContent: { updated: 'Widget name' },
      isError: false,
    });
    expect(settled).toBe(true);
  });

  it.each([
    'decline',
    'cancel',
  ] as const)('settles an app tool call as an MCP error when the user chooses %s', async (action) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse('session-token', {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          interactions: 'https://cloud.example/v1/assistant/interactions',
          apps: 'https://cloud.example/v1/assistant/apps',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          interaction: {
            event: 'tool_proposed',
            data: { id: 'app_int_1', tool: 'update_account', requiresConfirmation: true },
          },
        }),
      )
      .mockResolvedValueOnce(
        eventStream(
          `event: interaction_resolved\ndata: {"id":"app_int_1","action":"${action}"}`,
          'event: done\ndata: {}',
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    const events: AssistantClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();

    const appCall = client.requestApp('tools/call', {
      name: 'update_account',
      arguments: { name: 'Widget name' },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'tool_proposed',
          data: expect.objectContaining({ id: 'app_int_1' }),
        }),
      ),
    );
    await client.respond('app_int_1', { action });

    await expect(appCall).resolves.toEqual({
      content: [{ type: 'text', text: `interaction_${action}` }],
      isError: true,
    });
  });

  it('keeps one app call pending while elicitation advances to confirmation', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse('session-token', {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          interactions: 'https://cloud.example/v1/assistant/interactions',
          apps: 'https://cloud.example/v1/assistant/apps',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          interaction: {
            event: 'input_requested',
            data: {
              id: 'app_input_1',
              message: 'Choose a team',
              requestedSchema: { type: 'object' },
              expiresAt: '2030-01-01T00:00:00Z',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        eventStream(
          'event: interaction_resolved\ndata: {"id":"app_input_1","action":"accept"}',
          'event: tool_proposed\ndata: {"id":"app_confirm_2","tool":"create_job","arguments":{"teamId":"team_1"},"requiresConfirmation":true}',
          'event: done\ndata: {}',
        ),
      )
      .mockResolvedValueOnce(
        eventStream(
          'event: interaction_resolved\ndata: {"id":"app_confirm_2","action":"accept"}',
          'event: tool_completed\ndata: {"id":"app_confirm_2","tool":"create_job","result":{"jobId":"job_1"}}',
          'event: done\ndata: {}',
        ),
      );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));
    await client.connect();

    let settled = false;
    const appCall = client
      .requestApp('tools/call', { name: 'create_job', arguments: {} })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'input_requested',
          data: expect.objectContaining({ id: 'app_input_1' }),
        }),
      ),
    );
    await client.respond('app_input_1', {
      action: 'accept',
      content: { teamId: 'team_1' },
    });
    expect(settled).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'tool_proposed',
        data: expect.objectContaining({ id: 'app_confirm_2' }),
      }),
    );

    await client.respond('app_confirm_2', { action: 'accept' });

    await expect(appCall).resolves.toMatchObject({
      structuredContent: { jobId: 'job_1' },
      isError: false,
    });
  });

  it('does not re-exchange an existing eagerly connected session', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.connect();
    await client.connect();
    await client.sendMessage('Hello');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => input === '/api/assistant/session'),
    ).toHaveLength(1);
  });

  it('runs headlessly, exchanges context, and publishes session and streamed events', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream('event: content\ndata: {"delta":"Hello"}', 'event: done\ndata: {}'),
      );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
      context: { page: 'time-off' },
      clientContext: { locale: 'en-GB', timeZone: 'Europe/London' },
    });
    const unsubscribe = client.subscribe((event) => events.push(event));

    await client.sendMessage('  Hello  ');
    unsubscribe();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/assistant/session',
      expect.objectContaining({
        credentials: 'same-origin',
        body: JSON.stringify({ context: { page: 'time-off' } }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cloud.example/v1/assistant/turns',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
        body: JSON.stringify({
          message: 'Hello',
          clientContext: { locale: 'en-GB', timeZone: 'Europe/London' },
        }),
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'session_started' }),
        { event: 'content', data: { delta: 'Hello' } },
        { event: 'done', data: {} },
      ]),
    );
    expect(JSON.stringify(client)).not.toContain('session-token');
  });

  it('isolates subscriber failures from request outcomes and other subscribers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const observed: string[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe(() => {
      throw new Error('renderer bug');
    });
    client.subscribe((event) => observed.push(event.event));

    await expect(client.sendMessage('Hello')).resolves.toBeUndefined();
    expect(observed).toContain('done');
    expect(observed).toContain('message_completed');
  });

  it('rejects a successful HTTP turn that ends with a structured assistant error', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: error\ndata: {"code":"model_unavailable","status":503,"retryable":true}',
          'event: done\ndata: {}',
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await expect(client.sendMessage('Hello')).rejects.toMatchObject({
      detail: { code: 'model_unavailable', status: 503, retryable: true },
    });
  });

  it('rejects a truncated ordinary turn without publishing message completion', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: content\ndata: {"delta":"Partial"}'));
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));

    await expect(client.sendMessage('Hello')).rejects.toMatchObject({
      detail: { code: 'invalid_response', retryable: false },
    });
    expect(events).toContainEqual({ event: 'content', data: { delta: 'Partial' } });
    expect(events.some((event) => event.event === 'done')).toBe(false);
    expect(events.some((event) => event.event === 'message_completed')).toBe(false);
  });

  it('evaluates clientContext for every turn without adding it to session context', async () => {
    let timeZone = 'Europe/London';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
      context: { page: 'calendar' },
      clientContext: () => ({ locale: 'en-GB', timeZone }),
    });

    await client.sendMessage('First');
    timeZone = 'Asia/Karachi';
    await client.sendMessage('Second');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/assistant/session',
      expect.objectContaining({ body: JSON.stringify({ context: { page: 'calendar' } }) }),
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        message: 'First',
        clientContext: { locale: 'en-GB', timeZone: 'Europe/London' },
      }),
    );
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        message: 'Second',
        clientContext: { locale: 'en-GB', timeZone: 'Asia/Karachi' },
      }),
    );
  });

  it('evaluates typed pageContext for every turn without freezing it into the session exchange', async () => {
    let selectedAccountId = 'account-1';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient<{ selectedAccountId: string }>({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
      pageContext: () => ({ selectedAccountId }),
    });

    await client.sendMessage('First');
    selectedAccountId = 'account-2';
    await client.sendMessage('Second');

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({}));
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ message: 'First', pageContext: { selectedAccountId: 'account-1' } }),
    );
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ message: 'Second', pageContext: { selectedAccountId: 'account-2' } }),
    );
  });

  it('replaces renderer model context locally and includes only the latest update on each turn', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    client.updateModelContext({
      structuredContent: { widget: { name: 'time-off', lifecycle: 'mounted' } },
    });
    client.updateModelContext({
      content: [{ type: 'text', text: 'The time-off form was submitted.' }],
      structuredContent: { widget: { name: 'time-off', lifecycle: 'submitted' } },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await client.sendMessage('Did that work?');
    await client.sendMessage('What is next?');

    const expected = {
      content: [{ type: 'text', text: 'The time-off form was submitted.' }],
      structuredContent: { widget: { name: 'time-off', lifecycle: 'submitted' } },
    };
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ message: 'Did that work?', modelContext: expected }),
    );
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ message: 'What is next?', modelContext: expected }),
    );
  });

  it('copies model context and rejects credential-shaped or unbounded updates before transport', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    const structuredContent = { widget: { lifecycle: 'mounted' } };
    client.updateModelContext({ structuredContent });
    structuredContent.widget.lifecycle = 'forged-after-update';
    await client.sendMessage('What is mounted?');

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      modelContext: { structuredContent: { widget: { lifecycle: 'mounted' } } },
    });

    expect(() =>
      client.updateModelContext({ structuredContent: { credential: 'must-not-cross' } }),
    ).toThrow(/sensitive|credential/i);
    expect(() =>
      client.updateModelContext({ structuredContent: { summary: 'x'.repeat(17 * 1024) } }),
    ).toThrow(/16 KiB/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    'own',
    'inherited',
  ] as const)('rejects nested credential-bearing %s toJSON hooks before retaining model context', (kind) => {
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: vi.fn<typeof fetch>(),
    });
    const widget = { lifecycle: 'mounted' };
    const toJSON = () => ({ lifecycle: 'mounted', apiKey: 'must-not-enter-the-next-turn' });
    if (kind === 'own') {
      Object.defineProperty(widget, 'toJSON', { value: toJSON });
    } else {
      Object.setPrototypeOf(widget, { toJSON });
    }

    expect(() => client.updateModelContext({ structuredContent: { widget } })).toThrow(
      /toJSON|non-JSON/i,
    );
  });

  it('projects getter-backed model context once before retaining it', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    let reads = 0;
    const widget = Object.defineProperty({}, 'lifecycle', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'mounted' : `Bearer ${'a'.repeat(24)}`;
      },
    });

    client.updateModelContext({ structuredContent: { widget } });
    await client.sendMessage('What is mounted?');

    expect(reads).toBe(1);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      modelContext: { structuredContent: { widget: { lifecycle: 'mounted' } } },
    });
  });

  it('updates context for the next session and resetSession never persists the token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse('first-token'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(sessionResponse('second-token'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.sendMessage('First');
    client.updateContext({ timeZone: 'Asia/Karachi' });
    client.resetSession();
    await client.sendMessage('Second');

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/assistant/session',
      expect.objectContaining({
        body: JSON.stringify({ context: { timeZone: 'Asia/Karachi' } }),
      }),
    );
  });

  it('re-exchanges and retries a message once after 401', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse('expired-token'))
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(sessionResponse('fresh-token'))
      .mockResolvedValueOnce(
        eventStream('event: content\ndata: {"delta":"Recovered"}', 'event: done\ndata: {}'),
      );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));

    await client.sendMessage('Hello');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(events.filter((event) => event.event === 'session_expired')).toHaveLength(1);
    expect(events).toContainEqual({ event: 'content', data: { delta: 'Recovered' } });
  });

  it('allows only one in-flight send or response and aborts the active request', async () => {
    let rejectFetch: ((reason: unknown) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    const first = client.sendMessage('First');

    await expect(client.sendMessage('Second')).rejects.toMatchObject({
      detail: { code: 'request_in_progress' },
    });
    client.abort();
    await expect(first).rejects.toMatchObject({ detail: { code: 'request_aborted' } });
    rejectFetch?.(new Error('cleanup'));
  });

  it.each([
    'accept',
    'decline',
    'cancel',
  ] as const)('resolves a modern interaction with action %s and never retries it', async (action) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(
        eventStream('event: interaction_resolved\ndata: {"id":"int_1"}', 'event: done\ndata: {}'),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.sendMessage('Prepare it');

    await client.respond('int_1', { action });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://cloud.example/v1/assistant/interactions',
      expect.objectContaining({ body: JSON.stringify({ id: 'int_1', action }) }),
    );
  });

  it('rejects a truncated interaction decision without publishing interaction completion', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(
        eventStream('event: interaction_resolved\ndata: {"id":"int_1","action":"accept"}'),
      );
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));
    await client.sendMessage('Prepare it');

    await expect(client.respond('int_1', { action: 'accept' })).rejects.toMatchObject({
      detail: { code: 'invalid_response', retryable: false },
    });
    expect(events).toContainEqual({
      event: 'interaction_resolved',
      data: { id: 'int_1', action: 'accept' },
    });
    expect(events.filter((event) => event.event === 'interaction_completed')).toHaveLength(0);
  });

  it('sends accepted structured input only on accept', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.sendMessage('Prepare it');

    await client.respond('int_1', {
      action: 'accept',
      content: { teamId: 'team_123' },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://cloud.example/v1/assistant/interactions',
      expect.objectContaining({
        body: JSON.stringify({ id: 'int_1', action: 'accept', content: { teamId: 'team_123' } }),
      }),
    );
  });

  it('falls back to the legacy confirmation route only for accept', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse('session-token', {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
        }),
      )
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.sendMessage('Prepare it');

    await client.respond('confirm_1', { action: 'accept' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://cloud.example/v1/assistant/tool-confirmations',
      expect.objectContaining({ body: JSON.stringify({ id: 'confirm_1' }) }),
    );

    await expect(client.respond('confirm_2', { action: 'decline' })).rejects.toBeInstanceOf(
      AssistantClientError,
    );
    await expect(client.respond('confirm_2', { action: 'decline' })).rejects.toMatchObject({
      detail: { code: 'unsupported_service' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never retries an interaction after 401', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }));
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => events.push(event));
    await client.sendMessage('Prepare it');

    await expect(client.respond('int_1', { action: 'accept' })).rejects.toMatchObject({
      detail: { code: 'confirmation_expired', status: 401 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.event === 'session_expired')).toHaveLength(1);
  });

  it('preserves a stable service error code for a failed interaction response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: 'interaction execution is already in progress',
            code: 'interaction_outcome_unknown',
          },
          { status: 409 },
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.sendMessage('Prepare it');

    await expect(client.respond('int_1', { action: 'accept' })).rejects.toMatchObject({
      detail: { code: 'interaction_outcome_unknown', status: 409, retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
