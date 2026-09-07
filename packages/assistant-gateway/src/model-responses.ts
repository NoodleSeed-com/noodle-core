import type { AssistantModelMessage, AssistantModelTool } from './model-request.js';
import { nonNegativeInteger, readBoundedText } from './model-response-values.js';
import type { ModelCompletion, ModelToolCall, ModelUsage } from './model-stream.js';

interface ResponsesUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly output_tokens_details?: { readonly reasoning_tokens?: unknown };
}

interface ResponsesResult {
  readonly output?: readonly unknown[];
  readonly usage?: ResponsesUsage;
}

export function responsesInput(messages: readonly AssistantModelMessage[]): readonly unknown[] {
  return messages.flatMap((message): readonly unknown[] => {
    if (message.role === 'tool') {
      return [
        {
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: message.content,
        },
      ];
    }
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      return [{ role: message.role, content: message.content }];
    }
    return [
      ...(message.content ? [{ role: 'assistant', content: message.content }] : []),
      ...message.tool_calls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    ];
  });
}

export function responsesTools(tools: readonly AssistantModelTool[]): readonly unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    parameters: tool.function.parameters,
  }));
}

export async function readResponsesCompletion(
  response: Response,
  onContent: (delta: string) => void,
  maxBytes = 1 << 20,
): Promise<ModelCompletion> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const result = parseResult(JSON.parse(await readBoundedText(response, maxBytes)));
    const completion = completionFromResult(result);
    const message = completion.choices[0]?.message;
    if (!message?.tool_calls?.length && message?.content) onContent(message.content);
    return completion;
  }
  if (!response.body) throw new Error('responses stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let bytes = 0;
  let completed: ResponsesResult | undefined;
  while (true) {
    const { done, value } = await reader.read();
    bytes += value?.byteLength ?? 0;
    if (bytes > maxBytes) throw new Error('model response too large');
    pending += decoder.decode(value, { stream: !done });
    pending = pending.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const frames = pending.split('\n\n');
    pending = done ? '' : (frames.pop() ?? '');
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data || data === '[DONE]') continue;
      const event = parseRecord(JSON.parse(data));
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        onContent(event.delta);
      } else if (event.type === 'response.completed') {
        completed = parseResult(event.response);
      } else if (event.type === 'error' || event.type === 'response.failed') {
        throw new Error('responses stream returned an error');
      }
    }
    if (done) break;
  }
  if (completed === undefined) throw new Error('responses stream did not complete');
  return completionFromResult(completed);
}

function completionFromResult(result: ResponsesResult): ModelCompletion {
  const content: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const rawItem of result.output ?? []) {
    const item = parseRecord(rawItem);
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = parseRecord(rawPart);
        if (part.type === 'output_text' && typeof part.text === 'string') content.push(part.text);
        if (part.type === 'refusal' && typeof part.refusal === 'string') content.push(part.refusal);
      }
    }
    if (
      item.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.arguments === 'string'
    ) {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    }
  }
  const usage = normalizeUsage(result.usage);
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: content.join(''),
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function normalizeUsage(usage: ResponsesUsage | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined;
  const promptTokens = nonNegativeInteger(usage.input_tokens);
  const completionTokens = nonNegativeInteger(usage.output_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  const totalTokens = nonNegativeInteger(usage.total_tokens) ?? promptTokens + completionTokens;
  const reasoningTokens = nonNegativeInteger(usage.output_tokens_details?.reasoning_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function parseResult(value: unknown): ResponsesResult {
  const result = parseRecord(value);
  if (!Array.isArray(result.output)) throw new Error('invalid Responses result');
  return result as ResponsesResult;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid Responses payload');
  }
  return value as Record<string, unknown>;
}
