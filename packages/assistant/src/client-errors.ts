/**
 * Response parsing and error shaping for the assistant client, extracted verbatim from client.ts
 * (size gate): the typed error class and factory, service refusal-code readers, and the session
 * response parser. Type-only imports back into client.ts are erased at runtime — no cycle.
 */
import { parseAssistantConfiguration } from './assistant-configuration-schema.js';
import type { AssistantSessionResponse } from './client.js';
import type { AssistantErrorDetail } from './transport.js';

/**
 * The service's refusal code, when the body carries one.
 *
 * Not every failure body is JSON — a proxy or gateway between the page and the service can return HTML —
 * so this never throws and never blocks the error it is decorating.
 */
export async function refusalCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    const code = (body as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A spent or switched-off daily budget is a capacity decision, not a fault. Retrying it is exactly the
 * load the cap was set to refuse, so the client marks it unretryable and the renderer drops the retry
 * affordance rather than merely softening the words.
 */
export const UNRETRYABLE_SERVICE_CODES = new Set([
  'daily_turn_budget_exhausted',
  'daily_session_budget_exhausted',
]);

export class AssistantClientError extends Error {
  readonly detail: AssistantErrorDetail;

  constructor(detail: AssistantErrorDetail, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AssistantClientError';
    this.detail = detail;
  }
}

export function parseSession(value: unknown): AssistantSessionResponse {
  if (!isRecord(value) || !isRecord(value.endpoints)) {
    throw clientError('session_failed', 'Assistant session response is invalid', true);
  }
  const interactions = value.endpoints.interactions;
  const apps = value.endpoints.apps;
  const sandbox = value.endpoints.sandbox;
  const transcript = value.endpoints.transcript;
  const suggestions = value.endpoints.suggestions;
  if (
    typeof value.token !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.endpoints.turns !== 'string' ||
    typeof value.endpoints.toolConfirmations !== 'string' ||
    (interactions !== undefined && typeof interactions !== 'string') ||
    (apps !== undefined && typeof apps !== 'string') ||
    (sandbox !== undefined && typeof sandbox !== 'string') ||
    (transcript !== undefined && typeof transcript !== 'string') ||
    (suggestions !== undefined && typeof suggestions !== 'string')
  ) {
    throw clientError('session_failed', 'Assistant session response is invalid', true);
  }
  const configuration = parseAssistantConfiguration(value.configuration);
  return {
    token: value.token,
    expiresAt: value.expiresAt,
    endpoints: {
      turns: value.endpoints.turns,
      toolConfirmations: value.endpoints.toolConfirmations,
      ...(typeof interactions === 'string' ? { interactions } : {}),
      ...(typeof apps === 'string' ? { apps } : {}),
      ...(typeof sandbox === 'string' ? { sandbox } : {}),
      ...(typeof transcript === 'string' ? { transcript } : {}),
      ...(typeof suggestions === 'string' ? { suggestions } : {}),
    },
    ...(configuration === undefined ? {} : { configuration }),
    ...(isRecord(value.resume) && typeof value.resume.tool === 'string'
      ? { resume: { tool: value.resume.tool } }
      : {}),
    ...(value.continuedAfterAuthentication === true
      ? { continuedAfterAuthentication: true as const }
      : {}),
  };
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readStableErrorCode(response: Response): Promise<string | undefined> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.code !== 'string') return undefined;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value.code) ? value.code : undefined;
}

export function clientError(
  code: string,
  message: string,
  retryable: boolean,
  status?: number,
  options?: ErrorOptions,
  serviceCode?: string,
): AssistantClientError {
  return new AssistantClientError(
    {
      code,
      ...(status === undefined ? {} : { status }),
      retryable,
      ...(serviceCode === undefined ? {} : { serviceCode }),
    },
    message,
    options,
  );
}
