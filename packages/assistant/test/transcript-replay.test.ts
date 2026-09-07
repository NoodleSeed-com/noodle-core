import { describe, expect, it, vi } from 'vitest';
import { createAssistantClient } from '../src/client.js';

function replayResponse(events: readonly { event: string; data: unknown }[]): Response {
  return new Response(
    events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('transcript replay on reattach', () => {
  const session = (transcript: boolean) =>
    Response.json({
      token: 'session-token',
      expiresAt: '2030-01-01T00:00:00Z',
      endpoints: {
        turns: 'https://cloud.example/v1/assistant/turns',
        toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
        ...(transcript ? { transcript: 'https://cloud.example/v1/assistant/transcript' } : {}),
      },
    });

  it('repaints the visible transcript through the standard chat state on connect', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(session(true))
      .mockResolvedValueOnce(
        replayResponse([
          { event: 'message_started', data: { message: 'What can you do?' } },
          { event: 'content', data: { delta: 'I can map your first workflow.' } },
          { event: 'message_completed', data: {} },
          { event: 'done', data: {} },
        ]),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.connect();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/assistant/transcript');
    expect(client.getChatState()).toMatchObject({
      status: 'ready',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'What can you do?' }] },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'I can map your first workflow.', state: 'done' }],
        },
      ],
    });
  });

  it('never fetches a transcript for a public embed page', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(session(true));
    const client = createAssistantClient({
      serviceUrl: 'https://cloud.example',
      embedId: 'pub_aaaaaaaaaaaaaaaaaaaaaaaa',
      fetch: fetchMock,
    });

    await client.connect();

    // A public page holds no token across a navigation, so there is nothing to re-attach.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a failed transcript read as no replay, never a failed connect', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(session(true))
      .mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.connect();

    expect(client.hasSession()).toBe(true);
    expect(client.getChatState().messages).toEqual([]);
  });

  it('still reports a secure continuation when browser replay is disabled', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        continuedAfterAuthentication: true,
        endpoints: {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
        },
      }),
    );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.connect();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getChatState().messages.flatMap((message) => message.parts)).toContainEqual({
      type: 'data-continuation',
      id: 'continued-after-authentication',
      data: { message: 'Continued securely with your account.' },
    });
  });

  it('restores text, continuation status, latest view, then one pending interaction without auto-resume', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          continuedAfterAuthentication: true,
          resume: { tool: 'finish_setup' },
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            transcript: 'https://cloud.example/v1/assistant/transcript',
          },
        }),
      )
      .mockResolvedValueOnce(
        replayResponse([
          { event: 'resume_started', data: { tool: '' } },
          { event: 'content', data: { delta: 'Your blueprint is ready.' } },
          { event: 'message_completed', data: {} },
          {
            event: 'view_available',
            data: {
              id: 'call_1',
              tool: 'preview',
              resourceUri: 'ui://preview/card',
              result: { ok: true },
              html: '<!doctype html><main>Preview</main>',
              replayed: true,
            },
          },
          {
            event: 'tool_proposed',
            data: {
              id: 'interaction_1',
              tool: 'finish_setup',
              arguments: { name: 'Acme' },
              expiresAt: '2030-01-01T00:10:00Z',
              requiresConfirmation: true,
            },
          },
          { event: 'done', data: {} },
        ]),
      );
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    const names: string[] = [];
    client.subscribe((event) => names.push(event.event));

    await client.connect();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(names).toEqual([
      'session_started',
      'resume_started',
      'content',
      'message_completed',
      'session_continued',
      'view_available',
      'tool_proposed',
    ]);
    expect(
      client.getChatState().messages.flatMap((message) => message.parts.map((part) => part.type)),
    ).toEqual(['text', 'data-continuation', 'data-view', 'data-confirmation']);
  });
});
