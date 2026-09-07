/**
 * The `noodle devtools` chat playground agent loop. Runs entirely inside the local preview server: it
 * calls an OpenAI-compatible chat-completions endpoint, and whenever the model requests a tool it invokes
 * the caller-supplied `callTool` (which the preview server wires to the loopback `dev` MCP endpoint through
 * its `/rpc` forwarder). The OpenAI API key stays server-side — it is never sent to the browser or logged.
 *
 * This is an extension of `dev`'s local, loopback-only tool exercise, not a general MCP client (ADR 0043):
 * the agent can only reach the tools of the local server the devtools session is already previewing.
 */

import { runAnthropicChatTurn } from './devtools-chat-anthropic.js';
import { runGeminiChatTurn } from './devtools-chat-gemini.js';
import {
  type ChatMessage,
  type ChatProviderId,
  type ChatToolDef,
  type ChatToolInvocation,
  type ChatTurnResult,
  completeTurn,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EMPTY_OBJECT_SCHEMA,
  limitTurn,
  parseToolArguments,
  providerFetch,
  type RunProviderChatTurnInput,
  requireDeclaredTool,
} from './devtools-chat-types.js';

export type {
  ChatMessage,
  ChatProviderId,
  ChatToolDef,
  ChatTurnResult,
  RunProviderChatTurnInput,
} from './devtools-chat-types.js';

export const DEFAULT_CHAT_MODELS: Readonly<Record<ChatProviderId, string>> = {
  openai: 'gpt-5.5',
  anthropic: 'claude-opus-5',
  gemini: 'gemini-3.6-flash',
};

/** Existing CLI option default. Provider-aware routes use {@link DEFAULT_CHAT_MODELS}. */
export const DEFAULT_CHAT_MODEL = DEFAULT_CHAT_MODELS.openai;

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

export interface OpenAiFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** Project MCP tool defs into OpenAI function-tool schema. */
export function toOpenAiTools(tools: readonly ChatToolDef[]): OpenAiFunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.inputSchema ?? EMPTY_OBJECT_SCHEMA,
    },
  }));
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: ChatMessage }>;
}

/**
 * Run one playground turn: call the model, execute any tool calls it requests against `callTool`, feed the
 * results back, and repeat until the model returns a plain answer (or the iteration cap is hit).
 */
export async function runChatTurn(opts: {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ChatToolDef[];
  readonly apiKey: string;
  readonly model: string;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ result: unknown; isError: boolean }>;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
}): Promise<ChatTurnResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  const openAiTools = toOpenAiTools(opts.tools);
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [...opts.messages];
  const toolCalls: ChatToolInvocation[] = [];
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // Bound each request: a hung OpenAI-compatible endpoint (BYO baseUrl/key) must not block the /chat
    // route forever. Abort after timeoutMs and surface it as a clear timeout error, not a raw AbortError.
    const res = await providerFetch(
      'OpenAI',
      doFetch,
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          messages,
          ...(openAiTools.length > 0 ? { tools: openAiTools, tool_choice: 'auto' } : {}),
        }),
      },
      timeoutMs,
    );
    const data = (await res.json()) as ChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('OpenAI returned no message in the completion.');
    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        messages,
        toolCalls,
        text: typeof message.content === 'string' ? message.content : '',
      };
    }

    for (const call of calls) {
      const def = requireDeclaredTool(byName, call.function.name);
      const args = parseToolArguments(call.function.arguments);
      const { result, isError } = await opts.callTool(call.function.name, args);
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        arguments: args,
        result,
        isError,
        ...(def.resourceUri ? { resourceUri: def.resourceUri } : {}),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: typeof result === 'string' ? result : JSON.stringify(result ?? null),
      });
    }
  }

  return limitTurn({ ...opts, provider: 'openai' }, toolCalls);
}

export async function runProviderChatTurn(
  input: RunProviderChatTurnInput,
): Promise<ChatTurnResult> {
  if (input.provider === 'anthropic') return runAnthropicChatTurn(input);
  if (input.provider === 'gemini') return runGeminiChatTurn(input);
  const result = await runChatTurn(input);
  return completeTurn(input, result.text, result.toolCalls);
}
