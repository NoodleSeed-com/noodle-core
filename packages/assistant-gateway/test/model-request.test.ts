import { describe, expect, it, vi } from 'vitest';
import { requestModelCompletion } from '../src/model-request.js';

describe('bounded assistant model requests', () => {
  it('admits sponsored managed egress before resolving credentials or calling the provider', async () => {
    const admit = vi.fn(async () => false);
    const bearerToken = vi.fn(async () => 'vertex-access-token');
    const fetcher = vi.fn();

    await expect(
      requestModelCompletion({
        binding: {
          source: 'noodle-managed',
          baseUrl:
            'https://aiplatform.googleapis.com/v1/projects/noodle-borg/locations/global/endpoints/openapi',
          model: 'google/gemini-flash-latest',
          bearerToken,
          sponsorship: {
            accountKey: 'managed:account:ba_1',
            allowance: 100,
            units: 1,
            admit,
          },
        },
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
        fetcher,
      }),
    ).rejects.toMatchObject({ code: 'daily_turn_budget_exhausted', retryable: false });
    expect(admit).toHaveBeenCalledOnce();
    expect(bearerToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reuses one sponsorship admission across every model step sharing a resolved binding', async () => {
    const admit = vi.fn(async () => true);
    const fetcher = vi.fn(async () =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }),
    );
    const binding = {
      source: 'noodle-managed' as const,
      baseUrl: 'https://models.example/v1',
      model: 'assistant-model',
      apiKey: 'secret',
      sponsorship: {
        accountKey: 'managed:account:ba_1',
        allowance: 100,
        units: 1,
        admit,
      },
    };

    await requestModelCompletion({
      binding,
      messages: [{ role: 'user', content: 'First step' }],
      tools: [],
      fetcher,
    });
    await requestModelCompletion({
      binding,
      messages: [{ role: 'user', content: 'Second step' }],
      tools: [],
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(admit).toHaveBeenCalledOnce();
  });
  it('uses the explicit Responses transport and maps its stream into the shared completion', async () => {
    const deltas: string[] = [];
    const fetcher = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          [
            'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
            'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
            'data: {"type":"response.completed","response":{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]},{"type":"function_call","call_id":"call_2","name":"lookup","arguments":"{\\"id\\":2}"}],"usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17,"output_tokens_details":{"reasoning_tokens":2}}}}\n\n',
          ].join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );

    const completion = await requestModelCompletion({
      binding: {
        source: 'operator',
        transport: 'responses',
        baseUrl: 'https://models.example/v1',
        model: 'responses-model',
        apiKey: 'operator-secret',
      },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Look up one.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"id":1}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"name":"One"}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up a record.',
            parameters: { type: 'object' },
          },
        },
      ],
      toolChoice: 'required',
      maxCompletionTokens: 64,
      fetcher,
      onContent: (delta) => deltas.push(delta),
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://models.example/v1/responses');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'responses-model',
      stream: true,
      store: false,
      input: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Look up one.' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"id":1}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: '{"name":"One"}' },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up a record.',
          parameters: { type: 'object' },
        },
      ],
      tool_choice: 'required',
      max_output_tokens: 64,
    });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(completion).toEqual({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Hello',
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":2}' },
              },
            ],
          },
        },
      ],
      usage: {
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
        reasoningTokens: 2,
      },
    });
  });

  it.each([
    [400, 'model_request_rejected', false],
    [401, 'model_auth_failed', false],
    [403, 'model_auth_failed', false],
    [404, 'model_request_rejected', false],
    [429, 'model_rate_limited', true],
    [500, 'model_unavailable', true],
  ] as const)('classifies an upstream %s without exposing its response body', async (status, code, retryable) => {
    const fetcher = vi.fn(async () => new Response('provider secret detail', { status }));
    const request = requestModelCompletion({
      binding: {
        source: 'operator',
        baseUrl: 'https://models.example/v1',
        model: 'assistant-model',
        apiKey: 'operator-secret',
      },
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      fetcher,
    });

    await expect(request).rejects.toMatchObject({ code, status, retryable });
    await expect(request).rejects.not.toThrow(/provider secret detail|operator-secret|Hello/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts an ordinary Responses JSON result without replaying the request', async () => {
    const deltas: string[] = [];
    const fetcher = vi.fn(async () =>
      Response.json({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Fallback' }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
    );
    const completion = await requestModelCompletion({
      binding: {
        source: 'operator',
        transport: 'responses',
        baseUrl: 'https://models.example/v1',
        model: 'responses-model',
        apiKey: 'operator-secret',
      },
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      fetcher,
      onContent: (delta) => deltas.push(delta),
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(deltas).toEqual(['Fallback']);
    expect(completion.choices[0]?.message.content).toBe('Fallback');
    expect(completion.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it('rejects a successful HTTP response that is not a complete Responses result', async () => {
    const request = requestModelCompletion({
      binding: {
        source: 'operator',
        transport: 'responses',
        baseUrl: 'https://models.example/v1',
        model: 'responses-model',
        apiKey: 'operator-secret',
      },
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      fetcher: async () => Response.json({}),
    });

    await expect(request).rejects.toMatchObject({
      code: 'model_response_invalid',
      retryable: false,
    });
  });

  it.each([
    [new DOMException('timed out', 'TimeoutError'), 'model_timeout'],
    [new TypeError('fetch failed for https://secret-host.example'), 'model_unavailable'],
  ] as const)('classifies fetch failures without echoing their message', async (failure, code) => {
    const request = requestModelCompletion({
      binding: {
        source: 'operator',
        baseUrl: 'https://models.example/v1',
        model: 'assistant-model',
        apiKey: 'operator-secret',
      },
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      fetcher: async () => Promise.reject(failure),
    });

    await expect(request).rejects.toMatchObject({ code, retryable: true });
    await expect(request).rejects.not.toThrow(/secret-host|Hello|operator-secret/);
  });

  it('applies trusted hosted request policy without exposing it in authored data', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }),
    );
    await requestModelCompletion({
      binding: {
        source: 'noodle-managed',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'qwen/example',
        apiKey: 'operator-secret',
        requestPolicy: {
          maxCompletionTokens: 1_500,
          maxRequestBytes: 96 * 1_024,
          timeoutMs: 30_000,
          extraBody: {
            provider: {
              data_collection: 'deny',
              zdr: true,
              allow_fallbacks: false,
              require_parameters: true,
            },
          },
        },
      },
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer operator-secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'qwen/example',
      stream: true,
      max_completion_tokens: 1_500,
      provider: {
        data_collection: 'deny',
        zdr: true,
        allow_fallbacks: false,
        require_parameters: true,
      },
    });
  });

  it('refuses an oversized managed request before provider egress', async () => {
    const fetcher = vi.fn();
    await expect(
      requestModelCompletion({
        binding: {
          source: 'noodle-managed',
          baseUrl: 'https://models.example/v1',
          model: 'small',
          apiKey: 'secret',
          requestPolicy: { maxRequestBytes: 128, timeoutMs: 30_000 },
        },
        messages: [{ role: 'user', content: 'x'.repeat(500) }],
        tools: [],
        fetcher,
      }),
    ).rejects.toThrow(/request too large/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes the standard required tool-choice mode without making it operator state', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [] } }] }),
    );

    await requestModelCompletion({
      binding: {
        source: 'noodle-managed',
        baseUrl: 'https://models.example/v1',
        model: 'assistant-model',
        apiKey: 'operator-secret',
      },
      messages: [{ role: 'user', content: 'Show me visually.' }],
      tools: [],
      toolChoice: 'required',
      fetcher,
    });

    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request.tool_choice).toBe('required');
  });

  it('resolves a short-lived hosted bearer token only after request breakers pass', async () => {
    const bearerToken = vi.fn(async () => 'vertex-access-token');
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }),
    );

    await requestModelCompletion({
      binding: {
        source: 'noodle-managed',
        baseUrl:
          'https://aiplatform.googleapis.com/v1/projects/noodle-borg/locations/global/endpoints/openapi',
        model: 'google/gemini-flash-latest',
        bearerToken,
        requestPolicy: { maxRequestBytes: 96 * 1_024 },
      },
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      fetcher,
    });

    expect(bearerToken).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      'https://aiplatform.googleapis.com/v1/projects/noodle-borg/locations/global/endpoints/openapi/chat/completions',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer vertex-access-token',
          'content-type': 'application/json',
        },
      }),
    );
  });

  it('never resolves a hosted bearer token for an oversized request', async () => {
    const bearerToken = vi.fn(async () => 'vertex-access-token');
    const fetcher = vi.fn();

    await expect(
      requestModelCompletion({
        binding: {
          source: 'noodle-managed',
          baseUrl:
            'https://aiplatform.googleapis.com/v1/projects/noodle-borg/locations/global/endpoints/openapi',
          model: 'google/gemini-flash-latest',
          bearerToken,
          requestPolicy: { maxRequestBytes: 128 },
        },
        messages: [{ role: 'user', content: 'x'.repeat(500) }],
        tools: [],
        fetcher,
      }),
    ).rejects.toThrow(/request too large/i);
    expect(bearerToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
