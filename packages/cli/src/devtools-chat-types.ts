export type ChatProviderId = 'openai' | 'anthropic' | 'gemini';

/** Browser-facing conversation message plus the OpenAI-only fields used inside its adapter. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | null;
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly tool_call_id?: string;
}

/** A tool projected from MCP `tools/list`. */
export interface ChatToolDef {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly resourceUri?: string;
}

export type ChatToolArguments = Record<string, unknown>;

/** A tool call executed during one provider turn. */
export interface ChatToolInvocation {
  readonly id: string;
  readonly name: string;
  readonly arguments: ChatToolArguments;
  readonly result: unknown;
  readonly isError: boolean;
  readonly resourceUri?: string;
}

export interface ChatTurnResult {
  readonly messages: ChatMessage[];
  readonly toolCalls: ChatToolInvocation[];
  readonly text: string;
}

export interface RunProviderChatTurnInput {
  readonly provider: ChatProviderId;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ChatToolDef[];
  readonly apiKey: string;
  readonly model: string;
  readonly callTool: (
    name: string,
    args: ChatToolArguments,
  ) => Promise<{ result: unknown; isError: boolean }>;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly maxIterations?: number;
  readonly timeoutMs?: number;
}

export const DEFAULT_MAX_ITERATIONS = 8;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export function visibleMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages
    .filter(
      (message) =>
        message.role !== 'tool' &&
        (message.role === 'system' || message.role === 'user' || message.role === 'assistant'),
    )
    .map((message) => ({ role: message.role, content: message.content ?? '' }));
}

export function resultText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

export function validateToolArguments(value: unknown): ChatToolArguments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object.');
  }
  return value as ChatToolArguments;
}

export function parseToolArguments(value: string): ChatToolArguments {
  let parsed: unknown;
  try {
    parsed = value ? JSON.parse(value) : {};
  } catch {
    throw new Error('Tool arguments must be a JSON object.');
  }
  return validateToolArguments(parsed);
}

export function requireDeclaredTool(
  byName: ReadonlyMap<string, ChatToolDef>,
  name: string,
): ChatToolDef {
  const definition = byName.get(name);
  if (!definition) throw new Error(`Model requested undeclared tool "${name}".`);
  return definition;
}

export function completeTurn(
  input: RunProviderChatTurnInput,
  text: string,
  toolCalls: ChatToolInvocation[],
): ChatTurnResult {
  return {
    messages: [...visibleMessages(input.messages), { role: 'assistant', content: text }],
    toolCalls,
    text,
  };
}

export function limitTurn(
  input: RunProviderChatTurnInput,
  toolCalls: ChatToolInvocation[],
): ChatTurnResult {
  return completeTurn(
    input,
    'Stopped after reaching the tool-call limit for this turn. Ask a follow-up to continue.',
    toolCalls,
  );
}

export async function providerFetch(
  providerName: string,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${providerName} request failed (${response.status}).`);
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${providerName} request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
