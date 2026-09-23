/**
 * Backend-only conversation history calls for an embed client (ADR 0241 decision 12). They sign in with
 * the same client credential as `createAssistantSession`, and `user.id` must be the id your backend sent
 * at session exchange: the service stores exactly that id as the conversation's owner.
 */
interface AssistantBackendCredentials {
  readonly serviceUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface ListConversationsInput extends AssistantBackendCredentials {
  /** The signed-in person your backend vouches for; only `id` is sent. */
  readonly user: { readonly id: string };
  /** Page size, 1–50; the service defaults to 20. */
  readonly limit?: number;
  /** The previous page's `nextCursor`, valid only with the same client, user and `limit`. */
  readonly cursor?: string;
}

export interface AssistantConversationSummary {
  readonly id: string;
  readonly channel: string;
  readonly startedAt: string;
  readonly lastMessageAt: string;
  /** The person's first question, at most 120 characters; absent when they asked nothing. */
  readonly preview?: string;
}

/** Newest first; only conversations still inside the business's retention window. */
export interface AssistantConversationPage {
  readonly conversations: readonly AssistantConversationSummary[];
  readonly nextCursor?: string;
}

export interface ForgetUserInput extends AssistantBackendCredentials {
  readonly user: { readonly id: string };
}

/** Rows erased. Forgetting is idempotent: a repeat, or a user with no history, erases nothing. */
export interface AssistantForgetUserResult {
  readonly conversations: number;
  readonly items: number;
}

export interface AssistantConversationsErrorDetail {
  readonly code: 'conversations_request_failed' | 'conversations_response_invalid';
  readonly status: number;
  /** 5xx failures may be retried; forgetting is idempotent, so an account deletion can retry safely. */
  readonly retryable: boolean;
  /** The service's machine code when the body carried one, e.g. `conversation_unavailable`. */
  readonly serviceCode?: string;
}

export class AssistantConversationsError extends Error {
  readonly detail: AssistantConversationsErrorDetail;

  constructor(detail: AssistantConversationsErrorDetail, message: string) {
    super(message);
    this.name = 'AssistantConversationsError';
    this.detail = detail;
  }
}

/** One verified user's website conversations, newest first. */
export async function listConversations(
  input: ListConversationsInput,
  dependencies: { readonly fetch?: typeof fetch } = {},
): Promise<AssistantConversationPage> {
  const data = await post(input, 'list', dependencies, {
    user: { id: input.user.id },
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  const rows = data.value.conversations;
  const nextCursor = data.value.nextCursor;
  if (!Array.isArray(rows) || (nextCursor !== undefined && typeof nextCursor !== 'string'))
    throw invalidResponse(data.status);
  return {
    conversations: rows.map((row: unknown) => summary(row, data.status)),
    ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
  };
}

/**
 * Erases every conversation of this user in the client's application environment. Call it from your
 * own account-deletion flow; it works whether or not the business still records conversations.
 */
export async function forgetUser(
  input: ForgetUserInput,
  dependencies: { readonly fetch?: typeof fetch } = {},
): Promise<AssistantForgetUserResult> {
  const data = await post(input, 'forget-user', dependencies, { user: { id: input.user.id } });
  const forgotten = data.value.forgotten as Record<string, unknown> | undefined;
  if (!Number.isInteger(forgotten?.conversations) || !Number.isInteger(forgotten?.items))
    throw invalidResponse(data.status);
  return { conversations: forgotten?.conversations as number, items: forgotten?.items as number };
}

async function post(
  input: AssistantBackendCredentials,
  action: 'list' | 'forget-user',
  dependencies: { readonly fetch?: typeof fetch },
  body: unknown,
): Promise<{ readonly status: number; readonly value: Record<string, unknown> }> {
  const request = dependencies.fetch ?? fetch;
  const credentials = Buffer.from(`${input.clientId}:${input.clientSecret}`, 'utf8').toString(
    'base64',
  );
  const response = await request(
    `${input.serviceUrl.replace(/\/$/, '')}/v1/assistant/conversations/${action}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  // Never throws while reading the body — a proxy can answer with HTML instead of JSON.
  const parsed = (await response.json().catch(() => undefined)) as
    | { readonly ok?: unknown; readonly data?: unknown; readonly code?: unknown }
    | undefined;
  if (!response.ok) {
    const serviceCode = typeof parsed?.code === 'string' ? parsed.code : undefined;
    throw new AssistantConversationsError(
      {
        code: 'conversations_request_failed',
        status: response.status,
        retryable: response.status >= 500,
        ...(serviceCode === undefined ? {} : { serviceCode }),
      },
      `Assistant conversations ${action} failed (${response.status})`,
    );
  }
  if (parsed?.ok !== true || !isRecord(parsed.data)) throw invalidResponse(response.status);
  return { status: response.status, value: parsed.data };
}

function summary(row: unknown, status: number): AssistantConversationSummary {
  if (
    !isRecord(row) ||
    typeof row.id !== 'string' ||
    typeof row.channel !== 'string' ||
    typeof row.startedAt !== 'string' ||
    typeof row.lastMessageAt !== 'string' ||
    (row.preview !== undefined && typeof row.preview !== 'string')
  )
    throw invalidResponse(status);
  return {
    id: row.id,
    channel: row.channel,
    startedAt: row.startedAt,
    lastMessageAt: row.lastMessageAt,
    ...(typeof row.preview === 'string' ? { preview: row.preview } : {}),
  };
}

function invalidResponse(status: number): AssistantConversationsError {
  return new AssistantConversationsError(
    { code: 'conversations_response_invalid', status, retryable: false },
    'Assistant conversations response was not understood',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
