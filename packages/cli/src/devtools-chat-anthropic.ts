import {
  type ChatToolInvocation,
  completeTurn,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EMPTY_OBJECT_SCHEMA,
  limitTurn,
  providerFetch,
  type RunProviderChatTurnInput,
  requireDeclaredTool,
  resultText,
  validateToolArguments,
  visibleMessages,
} from './devtools-chat-types.js';

const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';

interface AnthropicBlock {
  readonly type: 'text' | 'tool_use';
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface AnthropicResponse {
  readonly content?: readonly AnthropicBlock[];
}

export async function runAnthropicChatTurn(input: RunProviderChatTurnInput) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = (input.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const system = visibleMessages(input.messages)
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .join('\n\n');
  const messages: Array<Record<string, unknown>> = visibleMessages(input.messages)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content ?? '' }));
  const tools = input.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema ?? EMPTY_OBJECT_SCHEMA,
  }));
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const toolCalls: ChatToolInvocation[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await providerFetch(
      'Claude',
      fetchImpl,
      `${base}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': input.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: 4096,
          ...(system ? { system } : {}),
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        }),
      },
      timeoutMs,
    );
    const data = (await response.json()) as AnthropicResponse;
    const content = data.content;
    if (!Array.isArray(content)) throw new Error('Claude returned no content.');
    const calls = content.filter(
      (block): block is AnthropicBlock & { id: string; name: string } =>
        block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string',
    );
    if (calls.length === 0) {
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      return completeTurn(input, text, toolCalls);
    }

    messages.push({ role: 'assistant', content });
    const results: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      const definition = requireDeclaredTool(byName, call.name);
      const args = validateToolArguments(call.input ?? {});
      const executed = await input.callTool(call.name, args);
      toolCalls.push({
        id: call.id,
        name: call.name,
        arguments: args,
        result: executed.result,
        isError: executed.isError,
        ...(definition.resourceUri ? { resourceUri: definition.resourceUri } : {}),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: resultText(executed.result),
        ...(executed.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return limitTurn(input, toolCalls);
}
