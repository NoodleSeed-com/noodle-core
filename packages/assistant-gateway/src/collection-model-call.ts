import type { z } from 'zod';
import { type ResolvedAssistantModel, requestModelCompletion } from './model-request.js';

/** Every collection model call is bounded the same way and reserves spend through the binding. */
export interface CollectionModelDeps {
  readonly binding: ResolvedAssistantModel;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}
export const COLLECTION_MODEL_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1 << 16;
const MAX_COMPLETION_TOKENS = 512;

/**
 * One tool-free JSON-mode request with exactly two messages: the task and the user's text. Transport
 * and admission errors propagate to the caller; output that fails the schema reads as `undefined`.
 */
export async function boundedJsonCall<T>(
  deps: CollectionModelDeps,
  system: string,
  user: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const signal = AbortSignal.any(
    [deps.signal, AbortSignal.timeout(COLLECTION_MODEL_TIMEOUT_MS)].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    ),
  );
  const completion = await requestModelCompletion({
    binding: deps.binding,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [],
    toolChoice: 'none',
    jsonOutput: true,
    fetcher: deps.fetcher,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
    signal,
  });
  const content = completion.choices[0]?.message.content;
  if (typeof content !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
