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
  validateToolArguments,
  visibleMessages,
} from './devtools-chat-types.js';

const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiFunctionCall {
  readonly id?: string;
  readonly name?: string;
  readonly args?: unknown;
}

interface GeminiPart {
  readonly text?: string;
  readonly functionCall?: GeminiFunctionCall;
  readonly thoughtSignature?: string;
}

interface GeminiContent {
  readonly role?: string;
  readonly parts?: readonly GeminiPart[];
}

interface GeminiResponse {
  readonly candidates?: readonly { readonly content?: GeminiContent }[];
}

export async function runGeminiChatTurn(input: RunProviderChatTurnInput) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = (input.baseUrl ?? GEMINI_DEFAULT_BASE).replace(/\/+$/, '');
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const systemText = visibleMessages(input.messages)
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .join('\n\n');
  const contents: Array<Record<string, unknown>> = visibleMessages(input.messages)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content ?? '' }],
    }));
  const tools =
    input.tools.length > 0
      ? [
          {
            functionDeclarations: input.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parameters: tool.inputSchema ?? EMPTY_OBJECT_SCHEMA,
            })),
          },
        ]
      : [];
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const toolCalls: ChatToolInvocation[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const response = await providerFetch(
      'Gemini',
      fetchImpl,
      `${base}/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': input.apiKey },
        body: JSON.stringify({
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          contents,
          ...(tools.length > 0 ? { tools } : {}),
        }),
      },
      timeoutMs,
    );
    const data = (await response.json()) as GeminiResponse;
    const content = data.candidates?.[0]?.content;
    const parts = content?.parts;
    if (!content || !Array.isArray(parts)) throw new Error('Gemini returned no content.');
    const calls = parts
      .map((part) => part.functionCall)
      .filter(
        (call): call is GeminiFunctionCall & { name: string } =>
          call !== undefined && typeof call.name === 'string',
      );
    if (calls.length === 0) {
      const text = parts.map((part) => part.text ?? '').join('');
      return completeTurn(input, text, toolCalls);
    }

    contents.push(content as Record<string, unknown>);
    const resultParts: Array<Record<string, unknown>> = [];
    for (const call of calls) {
      if (typeof call.id !== 'string' || call.id === '') {
        throw new Error('Gemini returned a tool call without an id.');
      }
      const definition = requireDeclaredTool(byName, call.name);
      const args = validateToolArguments(call.args ?? {});
      const executed = await input.callTool(call.name, args);
      toolCalls.push({
        id: call.id,
        name: call.name,
        arguments: args,
        result: executed.result,
        isError: executed.isError,
        ...(definition.resourceUri ? { resourceUri: definition.resourceUri } : {}),
      });
      resultParts.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          response: { result: executed.result, isError: executed.isError },
        },
      });
    }
    contents.push({ role: 'user', parts: resultParts });
  }

  return limitTurn(input, toolCalls);
}
