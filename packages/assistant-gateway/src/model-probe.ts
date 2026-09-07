import { assistantModelFailure } from './model-error.js';
import { type ResolvedAssistantModel, requestModelCompletion } from './model-request.js';

export type AssistantModelProbeResult =
  | { readonly ok: true; readonly transport: string }
  | {
      readonly ok: false;
      readonly transport: string;
      readonly code: string;
      readonly status?: number;
      readonly retryable: boolean;
    };

export type AssistantModelBoundaryProbeResult =
  | AssistantModelProbeResult
  | {
      readonly ok: false;
      readonly skipped: true;
      readonly reason: string;
    };

export async function probeAssistantModel(input: {
  readonly binding: ResolvedAssistantModel | undefined;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<AssistantModelProbeResult> {
  const transport = input.binding?.transport ?? 'chat-completions';
  if (input.binding === undefined) {
    return { ok: false, transport, code: 'model_not_configured', retryable: false };
  }
  try {
    await requestModelCompletion({
      binding: input.binding,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      tools: [],
      toolChoice: 'none',
      maxCompletionTokens: 16,
      maxResponseBytes: 64 * 1024,
      fetcher: input.fetcher,
    });
    return { ok: true, transport };
  } catch (error) {
    return { ok: false, transport, ...assistantModelFailure(error, 'model_probe_failed') };
  }
}

export async function probeAssistantModelBoundary(input: {
  readonly ready: boolean;
  readonly resolveBinding: () => Promise<ResolvedAssistantModel | undefined>;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  readonly onFailure?: (
    result: Exclude<AssistantModelProbeResult, { readonly ok: true }>,
    binding: ResolvedAssistantModel | undefined,
  ) => void;
}): Promise<AssistantModelBoundaryProbeResult> {
  if (!input.ready) {
    return {
      ok: false,
      skipped: true,
      reason: 'deployment, client, and origin checks must pass first',
    };
  }
  const binding = await input.resolveBinding();
  const result = await probeAssistantModel({ binding, fetcher: input.fetcher });
  if (!result.ok) input.onFailure?.(result, binding);
  return result;
}
