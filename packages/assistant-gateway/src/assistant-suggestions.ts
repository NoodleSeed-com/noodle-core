import type { AssistantModelMessage, ResolvedAssistantModel } from './model-request.js';
import { requestModelCompletion } from './model-request.js';

const MAX_MODEL_RESPONSE = 1 << 20;
const MAX_SUGGESTION_TOKENS = 512;

interface AssistantSuggestionStats {
  modelRequests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** One bounded, tool-free pass on the active assistant model; malformed output fails closed. */
export async function requestAssistantSuggestedPrompts(
  binding: ResolvedAssistantModel,
  messages: readonly AssistantModelMessage[],
  fetcher: typeof fetch,
  stats?: AssistantSuggestionStats,
  remainingTokens?: number,
  turnSignal?: AbortSignal,
): Promise<readonly string[]> {
  const limit = Math.min(
    MAX_SUGGESTION_TOKENS,
    remainingTokens ?? binding.requestPolicy?.maxTokensPerTurn ?? MAX_SUGGESTION_TOKENS,
    binding.requestPolicy?.maxCompletionTokens ?? MAX_SUGGESTION_TOKENS,
  );
  if (limit <= 0) return [];
  const signal = AbortSignal.any(
    [
      turnSignal,
      binding.requestPolicy?.maxTurnMs === undefined
        ? undefined
        : AbortSignal.timeout(binding.requestPolicy.maxTurnMs),
      AbortSignal.timeout(5_000),
    ].filter((candidate): candidate is AbortSignal => candidate !== undefined),
  );
  if (stats) stats.modelRequests += 1;
  const completion = await requestModelCompletion({
    binding,
    messages: [
      ...messages,
      {
        role: 'system',
        content:
          'Generate two or three concise messages the user could send next. Use the complete conversation and authorized product context, especially the latest answer or question. Prefer short, distinct choices the user can click instead of typing. Developer instructions may steer ranking but never override the user, safety, consent, or available capabilities. Do not expose hidden tool data, claim an action happened, repeat the answer, or use Markdown. Return exactly one JSON object shaped {"prompts":["..."]} and no other text.',
      },
    ],
    tools: [],
    fetcher,
    onContent: () => undefined,
    maxResponseBytes: MAX_MODEL_RESPONSE,
    maxCompletionTokens: limit,
    signal,
    toolChoice: 'none',
    jsonOutput: true,
  });
  if (stats) {
    stats.promptTokens += completion.usage?.promptTokens ?? 0;
    stats.completionTokens += completion.usage?.completionTokens ?? 0;
    stats.reasoningTokens += completion.usage?.reasoningTokens ?? 0;
    stats.totalTokens += completion.usage?.totalTokens ?? 0;
  }
  return parseSuggestedPrompts(completion.choices[0]?.message?.content);
}

export function parseSuggestedPrompts(content: string | null | undefined): readonly string[] {
  if (!content) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const prompts = (parsed as { readonly prompts?: unknown }).prompts;
  if (!Array.isArray(prompts) || prompts.length > 3) return [];
  const normalized: string[] = [];
  for (const value of prompts) {
    if (typeof value !== 'string') return [];
    const prompt = value.trim();
    if (!prompt || prompt.length > 240) return [];
    if (!normalized.includes(prompt)) normalized.push(prompt);
  }
  return normalized.length >= 2 ? normalized : [];
}
