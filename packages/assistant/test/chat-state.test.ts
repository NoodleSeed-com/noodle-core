import { describe, expect, it, vi } from 'vitest';
import { AssistantChatStateStore } from '../src/chat-state.js';
import { createAssistantClient } from '../src/client.js';

function sessionResponse(): Response {
  return Response.json({
    token: 'session-token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: {
      turns: 'https://cloud.example/v1/assistant/turns',
      toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
      interactions: 'https://cloud.example/v1/assistant/interactions',
    },
  });
}

function eventStream(...frames: readonly string[]): Response {
  return new Response(`${frames.join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AssistantClient AI SDK chat state', () => {
  it('publishes incremental UIMessage parts and AI SDK chat statuses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: content\ndata: {"delta":"Hello"}',
          'event: content\ndata: {"delta":" there"}',
          'event: done\ndata: {}',
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    const states: ReturnType<typeof client.getChatState>[] = [];
    const unsubscribe = client.subscribeChat((state) => states.push(state));

    await client.sendMessage('Hi');
    unsubscribe();

    expect(states.map((state) => state.status)).toEqual(
      expect.arrayContaining(['ready', 'submitted', 'streaming']),
    );
    expect(client.getChatState()).toMatchObject({
      status: 'ready',
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: 'Hi' }],
        },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hello there', state: 'done' }],
        },
      ],
    });
  });

  it('represents confirmations as typed data parts and resolves them without a fake user message', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: tool_proposed\ndata: {"id":"int_1","tool":"create_leave","title":"Book leave","arguments":{"days":2},"reviewSchema":{"type":"object"}}',
          'event: done\ndata: {}',
        ),
      )
      .mockResolvedValueOnce(
        eventStream(
          'event: interaction_resolved\ndata: {"id":"int_1","action":"decline"}',
          'event: content\ndata: {"delta":"I will not book that leave."}',
          'event: done\ndata: {}',
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.sendMessage('Book two days off');
    await client.respond('int_1', { action: 'decline' });

    const state = client.getChatState();
    expect(state.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ]);
    expect(state.messages[1]?.parts).toContainEqual({
      type: 'data-confirmation',
      id: 'int_1',
      data: {
        id: 'int_1',
        tool: 'create_leave',
        title: 'Book leave',
        arguments: { days: 2 },
        reviewSchema: { type: 'object' },
        status: 'declined',
      },
    });
    expect(state.messages[2]?.parts).toEqual([
      { type: 'text', text: 'I will not book that leave.', state: 'done' },
    ]);
  });

  it('represents an app-initiated confirmation without requiring a message stream', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            interactions: 'https://cloud.example/v1/assistant/interactions',
            apps: 'https://cloud.example/v1/assistant/apps',
          },
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
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.connect();

    void client.requestApp('tools/call', {
      name: 'update_account',
      arguments: { name: 'Widget name' },
    });
    await vi.waitFor(() =>
      expect(client.getChatState().messages[0]?.parts).toContainEqual({
        type: 'data-confirmation',
        id: 'app_int_1',
        data: {
          id: 'app_int_1',
          tool: 'update_account',
          arguments: { name: 'Widget name' },
          requiresConfirmation: true,
          status: 'pending',
        },
      }),
    );
  });

  it('maps elicitation, tool results, and linked views to UIMessage data parts', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: input_requested\ndata: {"id":"input_1","message":"Choose a team","requestedSchema":{"type":"object"},"expiresAt":"2030-01-01T00:00:00Z"}',
          'event: tool_completed\ndata: {"id":"call_1","tool":"list_leave","result":{"remaining":8}}',
          'event: view_available\ndata: {"id":"call_1","tool":"list_leave","resourceUri":"ui://leave/balance","result":{"remaining":8}}',
          'event: done\ndata: {}',
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.sendMessage('Show my leave');

    expect(client.getChatState().messages[1]?.parts).toEqual([
      {
        type: 'data-input-request',
        id: 'input_1',
        data: {
          id: 'input_1',
          message: 'Choose a team',
          requestedSchema: { type: 'object' },
          expiresAt: '2030-01-01T00:00:00Z',
          status: 'pending',
        },
      },
      {
        type: 'data-tool-result',
        id: 'call_1',
        data: { id: 'call_1', tool: 'list_leave', result: { remaining: 8 } },
      },
      {
        type: 'data-view',
        id: 'call_1',
        data: {
          id: 'call_1',
          tool: 'list_leave',
          resourceUri: 'ui://leave/balance',
          result: { remaining: 8 },
        },
      },
    ]);
  });

  it('preserves text and structured-part ordering within one assistant message', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: content\ndata: {"delta":"Before"}',
          'event: tool_completed\ndata: {"id":"call_1","tool":"lookup","result":{"ok":true}}',
          'event: content\ndata: {"delta":"After"}',
          'event: done\ndata: {}',
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.sendMessage('Run it');

    expect(client.getChatState().messages[1]?.parts).toMatchObject([
      { type: 'text', text: 'Before', state: 'done' },
      {
        type: 'data-tool-result',
        id: 'call_1',
        data: { id: 'call_1', tool: 'lookup', result: { ok: true } },
      },
      { type: 'text', text: 'After', state: 'done' },
    ]);
  });

  it('preserves partial assistant output and reports an error for a truncated stream', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: content\ndata: {"delta":"Partial"}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await expect(client.sendMessage('Hello')).rejects.toMatchObject({
      detail: { code: 'invalid_response' },
    });

    expect(client.getChatState()).toMatchObject({
      status: 'error',
      error: { name: 'AssistantClientError', detail: { code: 'invalid_response' } },
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Partial' }] },
      ],
    });
  });

  it('returns detached snapshots and clears transcript state when the session resets', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(eventStream('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.sendMessage('Hello');
    const exposed = client.getChatState();
    const textPart = exposed.messages[0]?.parts[0];
    if (textPart?.type === 'text') textPart.text = 'forged';

    expect(client.getChatState().messages[0]?.parts).toEqual([{ type: 'text', text: 'Hello' }]);

    client.resetSession();
    expect(client.getChatState()).toEqual({ status: 'ready', messages: [] });
  });
});

describe('sign-in moment chat state', () => {
  it('maps a mid-turn auth_requested into the streaming message as a data-sign-in part', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        eventStream(
          'event: content\ndata: {"delta":"One moment."}',
          'event: auth_requested\ndata: {"id":"elev_1","tool":"my_orders","signInTicket":"elv_abc","expiresAt":"2030-01-01T00:10:00.000Z"}',
          'event: done\ndata: {}',
        ),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.sendMessage('Show my orders');

    const state = client.getChatState();
    expect(state.status).toBe('ready');
    const assistant = state.messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    // The part carries no status: it is not respondable through client.respond — resolution is the
    // elevated session and its resume, never a widget reply.
    expect(assistant?.parts).toContainEqual({
      type: 'data-sign-in',
      id: 'elev_1',
      data: {
        id: 'elev_1',
        tool: 'my_orders',
        signInTicket: 'elv_abc',
        expiresAt: '2030-01-01T00:10:00.000Z',
      },
    });
  });

  it('renders a standalone auth_requested as its own part and returns to ready', async () => {
    const store = new AssistantChatStateStore();

    store.handle({
      event: 'auth_requested',
      data: {
        id: 'elev_2',
        tool: 'my_orders',
        signInTicket: 'elv_xyz',
        expiresAt: '2030-01-01T00:10:00.000Z',
      },
    });
    await store.flush();

    const state = store.getState();
    expect(state.status).toBe('ready');
    const parts = state.messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.type === 'data-sign-in')).toHaveLength(1);
  });
});

describe('post-sign-in resume chat state', () => {
  it('renders the auto-resume as an assistant-side operation with no user bubble', async () => {
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
        eventStream('event: content\ndata: {"delta":"You have 12 days."}', 'event: done\ndata: {}'),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    await client.connect();

    const state = client.getChatState();
    expect(state.status).toBe('ready');
    expect(state.messages.some((message) => message.role === 'user')).toBe(false);
    const assistant = state.messages.find((message) => message.role === 'assistant');
    expect(JSON.stringify(assistant?.parts)).toContain('You have 12 days.');
  });
});
