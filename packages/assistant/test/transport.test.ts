import { describe, expect, it } from 'vitest';
import { consumeAssistantEvents } from '../src/transport.js';

describe('assistant event transport', () => {
  it('parses chunk-split and multiline SSE frames incrementally', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: content\ndata: {"del',
      'ta":"Hel"}\n\nevent: content\n',
      'data: {"delta":"lo"}\n\nevent: done\ndata: {}\n\n',
    ];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const deltas: string[] = [];
    await consumeAssistantEvents(response, (event) => {
      if (event.event === 'content') deltas.push(String(event.data.delta));
    });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('normalizes scalar JSON payloads instead of exposing an invalid record shape', async () => {
    const response = new Response('event: future\ndata: null\n\nevent: done\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    const events: unknown[] = [];

    await consumeAssistantEvents(response, (event) => events.push(event));

    expect(events).toEqual([
      { event: 'future', data: { value: null } },
      { event: 'done', data: {} },
    ]);
  });

  it.each([
    ['invalid JSON', 'event: content\ndata: {"delta":\n\n'],
    ['missing data', 'event: content\n\n'],
    ['unnamed data', 'data: {"delta":"Hello"}\n\n'],
    ['unterminated frame', 'event: done\ndata: {}'],
    ['invalid done payload', 'event: done\ndata: {"turnId":42}\n\n'],
    ['invalid empty done turn id', 'event: done\ndata: {"turnId":""}\n\n'],
  ])('rejects malformed %s frames', async (_label, body) => {
    const events: unknown[] = [];

    await expect(
      consumeAssistantEvents(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(events).toEqual([]);
  });

  it('rejects an otherwise valid stream that ends before done', async () => {
    const events: unknown[] = [];

    await expect(
      consumeAssistantEvents(
        new Response('event: content\ndata: {"delta":"partial"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(events).toEqual([{ event: 'content', data: { delta: 'partial' } }]);
  });

  it.each([
    ['a duplicate done event', 'event: done\ndata: {}\n\nevent: done\ndata: {}\n\n'],
    [
      'an event after done',
      'event: done\ndata: {}\n\nevent: content\ndata: {"delta":"too late"}\n\n',
    ],
  ])('rejects %s without publishing a terminal event', async (_label, body) => {
    const events: unknown[] = [];

    await expect(
      consumeAssistantEvents(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(events).toEqual([]);
  });
});

describe('non-SSE responses fail loudly (invalid_response)', () => {
  it('rejects an HTML body that claims 200 without emitting events', async () => {
    const response = new Response('<!doctype html><html><body>Sign in</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const events: unknown[] = [];
    await expect(
      consumeAssistantEvents(response, (event) => events.push(event)),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(events).toEqual([]);
  });

  it('rejects a non-SSE body even when no content-type header is set', async () => {
    const response = new Response('<!doctype html><html></html>', { status: 200 });
    await expect(consumeAssistantEvents(response, () => {})).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('still accepts a valid SSE body with a lax content-type', async () => {
    const response = new Response('event: done\ndata: {}\n\n', { status: 200 });
    const events: string[] = [];
    await consumeAssistantEvents(response, (event) => events.push(event.event));
    expect(events).toEqual(['done']);
  });
});
