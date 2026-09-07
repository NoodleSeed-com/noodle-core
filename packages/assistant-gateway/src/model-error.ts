export type AssistantModelErrorCode =
  | 'daily_turn_budget_exhausted'
  | 'model_auth_failed'
  | 'model_request_rejected'
  | 'model_rate_limited'
  | 'model_timeout'
  | 'model_unavailable'
  | 'model_response_invalid';

export class AssistantModelError extends Error {
  readonly code: AssistantModelErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    code: AssistantModelErrorCode,
    options: {
      readonly status?: number;
      readonly retryable: boolean;
      readonly cause?: unknown;
      readonly message?: string;
    },
  ) {
    super(
      options.message ?? (options.status === undefined ? code : `${code} (${options.status})`),
      {
        ...(options.cause === undefined ? {} : { cause: options.cause }),
      },
    );
    this.name = 'AssistantModelError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export interface AssistantModelFailureDetails {
  readonly [key: string]: unknown;
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
}

export function assistantModelFailure(
  error: unknown,
  fallbackCode = 'model_transport_failed',
): AssistantModelFailureDetails {
  if (!(error instanceof AssistantModelError)) {
    return { code: fallbackCode, retryable: true };
  }
  return {
    code: error.code,
    ...(error.status === undefined ? {} : { status: error.status }),
    retryable: error.retryable,
  };
}

export function assistantModelSource(model: { readonly kind: string } | undefined): string {
  return model?.kind === 'noodle-managed' ? 'noodle-managed' : 'operator';
}

export function assistantModelTransport(
  model:
    | { readonly kind: string; readonly transport?: 'chat-completions' | 'responses' | undefined }
    | undefined,
): string {
  return model?.kind === 'openai-compatible' ? (model.transport ?? 'chat-completions') : 'managed';
}

export function modelHttpError(status: number): AssistantModelError {
  if (status === 401 || status === 403) {
    return new AssistantModelError('model_auth_failed', { status, retryable: false });
  }
  if (status === 429) {
    return new AssistantModelError('model_rate_limited', { status, retryable: true });
  }
  if (status === 408 || status >= 500) {
    return new AssistantModelError('model_unavailable', { status, retryable: true });
  }
  return new AssistantModelError('model_request_rejected', { status, retryable: false });
}

export function modelRequestError(message: string, cause?: unknown): AssistantModelError {
  return new AssistantModelError('model_request_rejected', { retryable: false, cause, message });
}

export function modelFetchError(cause: unknown): AssistantModelError {
  return new AssistantModelError(isTimeoutError(cause) ? 'model_timeout' : 'model_unavailable', {
    retryable: true,
    cause,
  });
}

export function modelResponseError(cause: unknown): AssistantModelError {
  return new AssistantModelError('model_response_invalid', { retryable: false, cause });
}

export function managedSponsorshipExhausted(): AssistantModelError {
  return new AssistantModelError('daily_turn_budget_exhausted', { retryable: false });
}

export function managedSponsorshipUnavailable(cause: unknown): AssistantModelError {
  return new AssistantModelError('model_unavailable', { retryable: true, cause });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}
