import { describe, expect, it } from 'vitest';
import { readModelCompletion } from '../src/model-stream.js';

describe('assistant model streaming', () => {
  it('emits content deltas and aggregates streamed tool calls', async () => {
    const encoder = new TextEncoder();
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"update_","arguments":"{\\"name\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"account","arguments":"\\"New\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const deltas: string[] = [];
    const completion = await readModelCompletion(response, (delta) => deltas.push(delta));
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(completion.choices[0]?.message).toEqual({
      role: 'assistant',
      content: 'Hello',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'update_account', arguments: '{"name":"New"}' },
        },
      ],
    });
  });

  it('accepts a normal JSON completion as a one-shot fallback', async () => {
    const deltas: string[] = [];
    const completion = await readModelCompletion(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'Fallback' } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }),
      (delta) => deltas.push(delta),
    );
    expect(deltas).toEqual(['Fallback']);
    expect(completion.choices[0]?.message.content).toBe('Fallback');
    expect(completion.usage).toEqual({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      reasoningTokens: 2,
    });
  });

  it('keeps usage from the final streamed provider frame', async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n' +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const completion = await readModelCompletion(response, () => undefined);
    expect(completion.usage).toEqual({
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
    });
  });

  it('derives total usage when a compatible provider omits the redundant total', async () => {
    const completion = await readModelCompletion(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'Done' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
      () => undefined,
    );
    expect(completion.usage).toEqual({
      promptTokens: 10,
      completionTokens: 3,
      totalTokens: 13,
    });
  });
});

/**
 * Provider extras on a tool call.
 *
 * Gemini 3.x returns a `thought_signature` alongside each function call and **rejects the follow-up
 * request** if it is not echoed back — so a client that drops it can call a tool once and then never
 * complete the turn. That is not a Google quirk to special-case: the OpenAI wire format reserves
 * `extra_content` precisely for provider round-trip state, so the rule is to give back whatever we were
 * given, unread.
 */
describe('provider extra_content on tool calls', () => {
  const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  const stream = (body: string) =>
    new Response(`${body}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });

  it('carries extra_content back out on the assembled tool call', async () => {
    const completion = await readModelCompletion(
      stream(
        frame({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'ask', arguments: '{}' },
              extra_content: { google: { thought_signature: 'sig-abc' } },
            },
          ],
        }),
      ),
      () => undefined,
    );

    expect(completion.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      id: 'call_1',
      extra_content: { google: { thought_signature: 'sig-abc' } },
    });
  });

  it('keeps extras that arrive in a later fragment than the call they belong to', async () => {
    // Providers split a tool call across deltas; the signature need not ride the first fragment.
    const completion = await readModelCompletion(
      stream(
        frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'a' } }] }) +
          frame({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{}' },
                extra_content: { google: { thought_signature: 'sig-late' } },
              },
            ],
          }),
      ),
      () => undefined,
    );

    expect(completion.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      function: { name: 'a', arguments: '{}' },
      extra_content: { google: { thought_signature: 'sig-late' } },
    });
  });

  it('omits extra_content entirely when the provider sent none', async () => {
    const completion = await readModelCompletion(
      stream(
        frame({ tool_calls: [{ index: 0, id: 'c', function: { name: 'a', arguments: '{}' } }] }),
      ),
      () => undefined,
    );

    // An empty key would be a shape change every provider sees; absent means absent.
    expect(completion.choices[0]?.message.tool_calls?.[0]).not.toHaveProperty('extra_content');
  });
});
