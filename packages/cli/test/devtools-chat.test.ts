import { describe, expect, it } from 'vitest';
import {
  type ChatMessage,
  DEFAULT_CHAT_MODEL,
  runChatTurn,
  toOpenAiTools,
} from '../src/devtools-chat.js';

/** Build a fake `fetch` that returns each queued OpenAI response body in order. */
function fakeOpenAi(responses: Array<Record<string, unknown>>): {
  fetchImpl: typeof fetch;
  requests: Array<Record<string, unknown>>;
} {
  const requests: Array<Record<string, unknown>> = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    requests.push(JSON.parse(init?.body ?? '{}'));
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const assistant = (content: string): Record<string, unknown> => ({
  choices: [{ message: { role: 'assistant', content } }],
});

const wantsTool = (name: string, args: unknown, id = 'call_1'): Record<string, unknown> => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});

describe('devtools chat — toOpenAiTools', () => {
  it('maps MCP tool defs into OpenAI function tools', () => {
    const out = toOpenAiTools([
      {
        name: 'new_strong',
        description: 'Make a strong password',
        inputSchema: { type: 'object', properties: { length: { type: 'number' } } },
      },
    ]);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'new_strong',
          description: 'Make a strong password',
          parameters: { type: 'object', properties: { length: { type: 'number' } } },
        },
      },
    ]);
  });

  it('defaults missing schemas to an empty object schema', () => {
    const out = toOpenAiTools([{ name: 'ping' }]);
    expect(out[0].function.parameters).toEqual({ type: 'object', properties: {} });
    expect('description' in out[0].function).toBe(false);
  });
});

describe('devtools chat — runChatTurn', () => {
  it('returns the assistant text directly when the model calls no tools', async () => {
    const { fetchImpl } = fakeOpenAi([assistant('Hello there.')]);
    const result = await runChatTurn({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      apiKey: 'sk-test',
      model: DEFAULT_CHAT_MODEL,
      fetchImpl,
      callTool: async () => ({ result: null, isError: false }),
    });
    expect(result.text).toBe('Hello there.');
    expect(result.toolCalls).toEqual([]);
  });

  it('executes a tool call, feeds the result back, and records the transcript', async () => {
    const { fetchImpl, requests } = fakeOpenAi([
      wantsTool('new_strong', { length: 12 }),
      assistant('Here is your password.'),
    ]);
    const calls: Array<{ name: string; args: unknown }> = [];
    const result = await runChatTurn({
      messages: [{ role: 'user', content: 'make a password' }],
      tools: [{ name: 'new_strong', resourceUri: 'ui://app/pw' }],
      apiKey: 'sk-test',
      model: DEFAULT_CHAT_MODEL,
      fetchImpl,
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { result: { structuredContent: { password: 'xyz' } }, isError: false };
      },
    });
    // The tool was invoked with the model's parsed arguments.
    expect(calls).toEqual([{ name: 'new_strong', args: { length: 12 } }]);
    // The transcript carries the widget resourceUri for inline rendering.
    expect(result.toolCalls[0]).toMatchObject({
      name: 'new_strong',
      arguments: { length: 12 },
      resourceUri: 'ui://app/pw',
      isError: false,
    });
    // The final answer is returned, and a tool-result message was fed back to the model.
    expect(result.text).toBe('Here is your password.');
    const secondRequest = requests[1].messages as ChatMessage[];
    expect(secondRequest.some((m) => m.role === 'tool')).toBe(true);
  });

  it('stops after the iteration cap instead of looping forever', async () => {
    // Model always asks for another tool call; the cap must bound it.
    const { fetchImpl, requests } = fakeOpenAi([wantsTool('loop', {})]);
    const result = await runChatTurn({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'loop' }],
      apiKey: 'sk-test',
      model: DEFAULT_CHAT_MODEL,
      fetchImpl,
      maxIterations: 3,
      callTool: async () => ({ result: { ok: true }, isError: false }),
    });
    expect(requests.length).toBe(3);
    expect(result.text).toMatch(/limit/i);
  });

  it('aborts and surfaces a timeout error when the endpoint hangs', async () => {
    // A fetch that never resolves on its own — it only settles when the AbortController fires.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    await expect(
      runChatTurn({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        apiKey: 'sk-test',
        model: DEFAULT_CHAT_MODEL,
        fetchImpl: hangingFetch,
        timeoutMs: 20,
        callTool: async () => ({ result: null, isError: false }),
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it('throws a helpful error when OpenAI returns a non-2xx response', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '{"error":{"message":"bad key"}}',
    })) as unknown as typeof fetch;
    await expect(
      runChatTurn({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        apiKey: 'sk-bad',
        model: DEFAULT_CHAT_MODEL,
        fetchImpl,
        callTool: async () => ({ result: null, isError: false }),
      }),
    ).rejects.toThrow(/401/);
  });
});
