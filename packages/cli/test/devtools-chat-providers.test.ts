import { describe, expect, it } from 'vitest';
import {
  type ChatProviderId,
  DEFAULT_CHAT_MODELS,
  runProviderChatTurn,
} from '../src/devtools-chat.js';

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeProvider(responses: readonly Record<string, unknown>[]): {
  readonly fetchImpl: typeof fetch;
  readonly requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawHeaders = new Headers(init?.headers);
    requests.push({
      url: String(input),
      headers: Object.fromEntries(rawHeaders.entries()),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const body = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const tool = {
  name: 'open_ordering',
  description: 'Open an ordering session',
  inputSchema: {
    type: 'object',
    properties: { customer: { type: 'string' } },
    required: ['customer'],
  },
  resourceUri: 'ui://ordering/app',
} as const;

async function run(
  provider: ChatProviderId,
  fetchImpl: typeof fetch,
  calls: Array<{ name: string; args: unknown }>,
) {
  return runProviderChatTurn({
    provider,
    messages: [
      { role: 'system', content: 'Use a tool when it helps.' },
      { role: 'user', content: 'Start an order for Sam.' },
    ],
    tools: [tool],
    apiKey: 'provider-secret',
    model: DEFAULT_CHAT_MODELS[provider],
    fetchImpl,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { result: { structuredContent: { orderId: 'ord_1' } }, isError: false };
    },
  });
}

describe('devtools chat providers', () => {
  it('translates an OpenAI function call and returns its tool result', async () => {
    const { fetchImpl, requests } = fakeProvider([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_openai',
                  type: 'function',
                  function: {
                    name: 'open_ordering',
                    arguments: '{"customer":"Sam"}',
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { role: 'assistant', content: 'Order ready.' } }] },
    ]);
    const calls: Array<{ name: string; args: unknown }> = [];

    const result = await run('openai', fetchImpl, calls);

    expect(requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(requests[0].headers.authorization).toBe('Bearer provider-secret');
    expect(requests[0].body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      },
    ]);
    expect(
      (requests[1].body.messages as Array<{ role: string }>).some(
        (message) => message.role === 'tool',
      ),
    ).toBe(true);
    expect(calls).toEqual([{ name: 'open_ordering', args: { customer: 'Sam' } }]);
    expect(result.text).toBe('Order ready.');
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_openai',
      name: 'open_ordering',
      resourceUri: 'ui://ordering/app',
    });
  });

  it('translates a Claude tool_use block and returns a tool_result block', async () => {
    const firstContent = [
      {
        type: 'tool_use',
        id: 'toolu_claude',
        name: 'open_ordering',
        input: { customer: 'Sam' },
      },
    ];
    const { fetchImpl, requests } = fakeProvider([
      { content: firstContent, stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Order ready.' }], stop_reason: 'end_turn' },
    ]);
    const calls: Array<{ name: string; args: unknown }> = [];

    const result = await run('anthropic', fetchImpl, calls);

    expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0].headers['x-api-key']).toBe('provider-secret');
    expect(requests[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(requests[0].body.system).toBe('Use a tool when it helps.');
    expect(requests[0].body.tools).toEqual([
      {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      },
    ]);
    expect(requests[1].body.messages).toEqual(
      expect.arrayContaining([
        { role: 'assistant', content: firstContent },
        {
          role: 'user',
          content: [
            expect.objectContaining({
              type: 'tool_result',
              tool_use_id: 'toolu_claude',
            }),
          ],
        },
      ]),
    );
    expect(calls).toEqual([{ name: 'open_ordering', args: { customer: 'Sam' } }]);
    expect(result.text).toBe('Order ready.');
  });

  it('translates a Gemini functionCall and returns a matching functionResponse', async () => {
    const modelContent = {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call_gemini',
            name: 'open_ordering',
            args: { customer: 'Sam' },
          },
          thoughtSignature: 'signature-1',
        },
      ],
    };
    const { fetchImpl, requests } = fakeProvider([
      { candidates: [{ content: modelContent }] },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Order ready.' }] } }],
      },
    ]);
    const calls: Array<{ name: string; args: unknown }> = [];

    const result = await run('gemini', fetchImpl, calls);

    expect(requests[0].url).toContain('https://generativelanguage.googleapis.com/v1beta/models/');
    expect(requests[0].url).toContain(':generateContent');
    expect(requests[0].headers['x-goog-api-key']).toBe('provider-secret');
    expect(requests[0].body.systemInstruction).toEqual({
      parts: [{ text: 'Use a tool when it helps.' }],
    });
    expect(requests[0].body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        ],
      },
    ]);
    expect(requests[1].body.contents).toEqual(
      expect.arrayContaining([
        modelContent,
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_gemini',
                name: 'open_ordering',
                response: {
                  result: { structuredContent: { orderId: 'ord_1' } },
                  isError: false,
                },
              },
            },
          ],
        },
      ]),
    );
    expect(calls).toEqual([{ name: 'open_ordering', args: { customer: 'Sam' } }]);
    expect(result.text).toBe('Order ready.');
  });

  it('bounds provider tool loops', async () => {
    const { fetchImpl, requests } = fakeProvider([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'loop',
                  type: 'function',
                  function: { name: 'open_ordering', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
    ]);

    const result = await runProviderChatTurn({
      provider: 'openai',
      messages: [{ role: 'user', content: 'loop' }],
      tools: [tool],
      apiKey: 'provider-secret',
      model: DEFAULT_CHAT_MODELS.openai,
      fetchImpl,
      maxIterations: 2,
      callTool: async () => ({ result: { ok: true }, isError: false }),
    });

    expect(requests).toHaveLength(2);
    expect(result.text).toMatch(/tool-call limit/i);
  });

  it('normalizes provider failures without leaking response bodies or credentials', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'provider-secret is invalid' } }),
      text: async () => 'provider-secret is invalid',
    })) as unknown as typeof fetch;

    const error = await runProviderChatTurn({
      provider: 'anthropic',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      apiKey: 'provider-secret',
      model: DEFAULT_CHAT_MODELS.anthropic,
      fetchImpl,
      callTool: async () => ({ result: null, isError: false }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Claude request failed (401).');
    expect((error as Error).message).not.toContain('provider-secret is invalid');
    expect((error as Error).message).not.toContain('provider-secret');
  });

  it.each([
    [
      'openai' as const,
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_unknown',
                  type: 'function',
                  function: { name: 'undeclared_tool', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
    ],
    [
      'anthropic' as const,
      {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_unknown',
            name: 'undeclared_tool',
            input: {},
          },
        ],
      },
    ],
    [
      'gemini' as const,
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call_unknown',
                    name: 'undeclared_tool',
                    args: {},
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  ])('rejects undeclared %s tool calls before MCP execution', async (provider, response) => {
    const { fetchImpl } = fakeProvider([response]);
    const calls: Array<{ name: string; args: unknown }> = [];

    await expect(run(provider, fetchImpl, calls)).rejects.toThrow(
      'Model requested undeclared tool "undeclared_tool".',
    );
    expect(calls).toEqual([]);
  });

  it.each([
    '{not-json',
    '[]',
    'null',
    '"customer"',
  ])('rejects malformed OpenAI tool arguments before MCP execution: %s', async (rawArguments) => {
    const { fetchImpl } = fakeProvider([
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_invalid_args',
                  type: 'function',
                  function: { name: 'open_ordering', arguments: rawArguments },
                },
              ],
            },
          },
        ],
      },
    ]);
    const calls: Array<{ name: string; args: unknown }> = [];

    await expect(run('openai', fetchImpl, calls)).rejects.toThrow(
      /tool arguments must be a JSON object/i,
    );
    expect(calls).toEqual([]);
  });

  it('rejects a Gemini functionCall without an id before MCP execution', async () => {
    const { fetchImpl } = fakeProvider([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'open_ordering',
                    args: { customer: 'Sam' },
                  },
                },
              ],
            },
          },
        ],
      },
    ]);
    const calls: Array<{ name: string; args: unknown }> = [];

    await expect(run('gemini', fetchImpl, calls)).rejects.toThrow(
      'Gemini returned a tool call without an id.',
    );
    expect(calls).toEqual([]);
  });
});
