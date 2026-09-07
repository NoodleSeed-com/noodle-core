import { nonNegativeInteger, readBoundedText } from './model-response-values.js';

export interface ModelToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
  /**
   * Opaque provider round-trip state, echoed back unread on the follow-up request.
   *
   * Gemini 3.x returns a `thought_signature` here and **rejects the next request** without it, so a
   * client that drops this can call a tool once and never finish the turn. The OpenAI wire format
   * reserves `extra_content` for exactly this, so it is passed through rather than special-cased —
   * nothing here reads it, and no provider is named in the code that carries it.
   */
  readonly extra_content?: unknown;
}

export interface ModelCompletion {
  readonly choices: readonly {
    readonly message: {
      readonly role: 'assistant';
      readonly content?: string | null;
      readonly tool_calls?: readonly ModelToolCall[];
    };
  }[];
  readonly usage?: ModelUsage;
}

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
}

interface ProviderUsage {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown };
}

interface MutableToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  extra_content?: unknown;
}

export async function readModelCompletion(
  response: Response,
  onContent: (delta: string) => void,
  maxBytes = 1 << 20,
): Promise<ModelCompletion> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const text = await readBoundedText(response, maxBytes);
    const parsed = JSON.parse(text) as ModelCompletion & { readonly usage?: ProviderUsage };
    const completion: ModelCompletion = {
      choices: parsed.choices,
      ...normalizeUsage(parsed.usage),
    };
    const message = completion.choices[0]?.message;
    if (!message?.tool_calls?.length && message?.content) onContent(message.content);
    return completion;
  }
  if (!response.body) throw new Error('model stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, MutableToolCall>();
  let pending = '';
  let content = '';
  let usage: ModelUsage | undefined;
  let bytes = 0;
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
      const parsed = JSON.parse(data) as {
        error?: unknown;
        usage?: ProviderUsage;
        choices?: readonly {
          delta?: {
            content?: string | null;
            tool_calls?: readonly {
              index: number;
              id?: string;
              type?: 'function';
              function?: { name?: string; arguments?: string };
              extra_content?: unknown;
            }[];
          };
        }[];
      };
      if (parsed.error !== undefined) throw new Error('model stream returned an error');
      usage = normalizeUsageValue(parsed.usage) ?? usage;
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onContent(delta.content);
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const current = toolCalls.get(fragment.index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        current.id += fragment.id ?? '';
        current.function.name += fragment.function?.name ?? '';
        current.function.arguments += fragment.function?.arguments ?? '';
        // Last writer wins: a provider may attach its state to any fragment of the call, not only the
        // first, and an absent field must not erase what an earlier fragment supplied.
        if (fragment.extra_content !== undefined) current.extra_content = fragment.extra_content;
        toolCalls.set(fragment.index, current);
      }
    }
    if (done) break;
  }
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.size > 0
            ? {
                tool_calls: [...toolCalls.entries()]
                  .sort(([a], [b]) => a - b)
                  // Absent means absent: emitting an empty key would change the request shape for
                  // every provider, including those that reject unknown fields.
                  .map(([, call]) =>
                    call.extra_content === undefined
                      ? { id: call.id, type: call.type, function: call.function }
                      : call,
                  ),
              }
            : {}),
        },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  };
}

function normalizeUsage(usage: ProviderUsage | undefined): { readonly usage?: ModelUsage } {
  const normalized = normalizeUsageValue(usage);
  return normalized === undefined ? {} : { usage: normalized };
}

function normalizeUsageValue(usage: ProviderUsage | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined;
  const promptTokens = nonNegativeInteger(usage.prompt_tokens);
  const completionTokens = nonNegativeInteger(usage.completion_tokens);
  const reportedTotalTokens = nonNegativeInteger(usage.total_tokens);
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }
  const totalTokens = reportedTotalTokens ?? promptTokens + completionTokens;
  const reasoningTokens = nonNegativeInteger(usage.completion_tokens_details?.reasoning_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}
