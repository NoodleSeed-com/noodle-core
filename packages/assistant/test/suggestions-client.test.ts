import { describe, expect, it, vi } from 'vitest';
import { type AssistantClientEvent, createAssistantClient } from '../src/client.js';

const TURNS = 'https://cloud.example/v1/assistant/turns';
const SUGGESTIONS = 'https://cloud.example/v1/assistant/suggestions';

function sessionResponse(advertiseSuggestions = true): Response {
  return Response.json({
    token: 'session-token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: {
      turns: TURNS,
      toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
      ...(advertiseSuggestions ? { suggestions: SUGGESTIONS } : {}),
    },
  });
}

function events(...frames: readonly string[]): Response {
  return new Response(`${frames.join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('assistant client suggested prompts', () => {
  it('requests initial prompts with fresh context and exposes later follow-ups in headless state', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        events(
          'event: suggested_prompts\ndata: {"phase":"initial","prompts":["Review billing","Show limits"]}',
          'event: done\ndata: {}',
        ),
      )
      .mockResolvedValueOnce(
        events(
          'event: content\ndata: {"delta":"Your plan is active."}',
          'event: suggested_prompts\ndata: {"phase":"follow_up","prompts":["Compare plans","Add seats"]}',
          'event: done\ndata: {}',
        ),
      );
    const observed: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
      clientContext: { locale: 'en-GB', timeZone: 'Europe/London' },
      pageContext: { selectedPlan: 'growth' },
      modelContext: { structuredContent: { panel: 'billing' } },
    });
    client.subscribe((event) => observed.push(event));

    await client.loadInitialSuggestions?.();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(SUGGESTIONS);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      clientContext: { locale: 'en-GB', timeZone: 'Europe/London' },
      pageContext: { selectedPlan: 'growth' },
      modelContext: { structuredContent: { panel: 'billing' } },
    });
    expect(client.getChatState().suggestions).toEqual({
      phase: 'initial',
      prompts: ['Review billing', 'Show limits'],
    });

    await client.sendMessage('What is included?');
    expect(fetchMock.mock.calls[2]?.[0]).toBe(TURNS);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      message: 'What is included?',
      suggestions: true,
    });
    expect(client.getChatState().suggestions).toEqual({
      phase: 'follow_up',
      prompts: ['Compare plans', 'Add seats'],
    });
    expect(observed).toContainEqual({
      event: 'suggested_prompts',
      data: { phase: 'follow_up', prompts: ['Compare plans', 'Add seats'] },
    });
  });

  it('does no initial or follow-up work when an older service omits the capability', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse(false))
      .mockResolvedValueOnce(events('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.connect();
    await client.loadInitialSuggestions?.();
    await client.sendMessage('Hello');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ message: 'Hello' });
  });

  it('cancels background initial generation when the user sends without occupying single-flight', async () => {
    let initialAborted = false;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockImplementationOnce(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              initialAborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      )
      .mockResolvedValueOnce(events('event: done\ndata: {}'));
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });

    await client.connect();
    const loading = client.loadInitialSuggestions?.();
    await Promise.resolve();
    await expect(client.sendMessage('I will type instead')).resolves.toBeUndefined();
    await expect(loading).rejects.toBeInstanceOf(DOMException);
    expect(initialAborted).toBe(true);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(TURNS);
  });

  it('normalizes an oversized suggested-prompt frame to unrecognized without poisoning the stream', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(
        events(
          'event: suggested_prompts\ndata: {"phase":"follow_up","prompts":["one","two","three","four"]}',
          'event: done\ndata: {}',
        ),
      );
    const observed: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: fetchMock,
    });
    client.subscribe((event) => observed.push(event));

    await client.sendMessage('Hello');

    expect(observed).toContainEqual({
      event: 'unrecognized',
      data: {
        name: 'suggested_prompts',
        payload: { phase: 'follow_up', prompts: ['one', 'two', 'three', 'four'] },
      },
    });
  });
});
