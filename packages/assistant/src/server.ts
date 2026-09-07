import type { AssistantConfiguration } from './appearance.js';

export {
  type AssistantSessionHandlerOptions,
  type AssistantSessionIdentity,
  createAssistantSessionHandler,
} from './session-handler.js';

interface AssistantSessionExchangeBase {
  readonly serviceUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Browser origin to bind into the short-lived assistant session. */
  readonly origin: string;
  /** The signed-in person your backend vouches for — on both arms: an elevation IS this vouching. */
  readonly user: {
    readonly id: string;
    readonly email?: string;
    readonly name?: string;
    readonly tenant?: string;
    readonly roles?: readonly string[];
    readonly scopes?: readonly string[];
  };
  /** Backend-verified user preferences; these outrank untrusted browser presentation hints. */
  readonly preferences?: {
    readonly locale?: string;
    readonly timeZone?: string;
  };
  /**
   * Verified session claims from your authenticated backend. Only claims the server declares in
   * `embeddedAssistant({ sessionClaims })` reach tools (`\${user.claims.<key>}`) and, when marked
   * `exposeToModel`, the assistant's identity context. Flat scalars only.
   */
  readonly claims?: Readonly<Record<string, string | number | boolean | null>>;
  /** Set false to keep server retention but suppress transcript, view, and interaction replay. Default true. */
  readonly restoreConversation?: boolean;
}

/**
 * Fresh mint XOR mid-conversation sign-in, exclusive rather than merged for the same reason the
 * client's `sessionEndpoint`/`embedId` pair is: the two are different operations, and the wrong
 * combination should fail to typecheck instead of silently picking a meaning.
 *
 * `context` applies only when a session is being created; an elevation keeps the existing
 * conversation, so it is excluded rather than silently ignored. `routing` is allowed on both arms —
 * elevation is the first authenticated moment, so it is the only chance a routed connector's
 * session ever gets its backend-verified customer routes.
 */
export type CreateAssistantSessionInput =
  | (AssistantSessionExchangeBase & {
      readonly signInTicket?: undefined;
      readonly context?: Readonly<Record<string, string | number | boolean | null>>;
      /** Backend-verified connector routes keyed by authored `customerEndpoint` name. */
      readonly routing?: {
        readonly endpoints: Readonly<Record<string, string>>;
      };
      /** Resume applies only when spending a sign-in ticket; a fresh mint has nothing pending. */
      readonly resume?: undefined;
    })
  | (AssistantSessionExchangeBase & {
      /**
       * Single-use sign-in ticket from the widget's `assistant-sign-in-requested` event
       * (ADR 0201, 5.6b). Spending it binds this signed-in user to the visitor's existing
       * anonymous conversation instead of minting a new one. Unrelated to the server-held
       * interaction continuation, which never reaches browser code.
       */
      readonly signInTicket: string;
      readonly context?: undefined;
      /** Backend-verified connector routes keyed by authored `customerEndpoint` name. */
      readonly routing?: {
        readonly endpoints: Readonly<Record<string, string>>;
      };
      /**
       * Whether the service resumes the intercepted tool call as the elevated session's first
       * turn (issue #1177). ON by default — omit it and the visitor's pending question answers
       * itself after sign-in; pass `false` if your application provides its own affordance.
       */
      readonly resume?: boolean;
    });

export interface AssistantSession {
  readonly token: string;
  readonly expiresAt: string;
  readonly endpoints: {
    readonly turns: string;
    readonly toolConfirmations: string;
    readonly interactions?: string;
    readonly apps?: string;
    /** Additive hosted sandbox document for widget frames; absent on older services. */
    readonly sandbox?: string;
    /** Additive bounded visible-transcript endpoint; absent on older services. */
    readonly transcript?: string;
    /** Additive model-generated prompt suggestions; absent on older services. */
    readonly suggestions?: string;
  };
  /**
   * Present only on an elevation that armed the one-shot resume of the intercepted tool. Forward
   * the response body unchanged and the widget answers with one automatic turn.
   */
  readonly resume?: { readonly tool: string };
  /** Present only after a sign-in ticket successfully continued an anonymous session. */
  readonly continuedAfterAuthentication?: true;
  readonly configuration?: AssistantConfiguration;
}

/** The service's refusal codes for a sign-in ticket the exchange would not honour. */
export const ASSISTANT_ELEVATION_REFUSAL_CODES = [
  'elevation_ticket_invalid',
  'elevation_ticket_expired',
  'elevation_tenant_mismatch',
  'elevation_session_unavailable',
  'elevation_already_signed_in',
  'elevation_state_conflict',
] as const;
export type AssistantElevationRefusalCode = (typeof ASSISTANT_ELEVATION_REFUSAL_CODES)[number];

/**
 * Structurally mirrors the browser client's `AssistantErrorDetail` (declared locally: the backend
 * entry must not pull the browser transport module into its graph). `code` is a closed union owned
 * by this package; `serviceCode` passes the service's machine code through additively.
 */
export interface AssistantSessionExchangeErrorDetail {
  readonly code: 'session_exchange_failed';
  readonly status: number;
  /** 5xx infrastructure failures may be retried; a refused exchange must not be — tickets are single-use. */
  readonly retryable: boolean;
  /** The service's machine code when the body carried one, e.g. `elevation_ticket_expired`. */
  readonly serviceCode?: string;
}

export class AssistantSessionExchangeError extends Error {
  readonly detail: AssistantSessionExchangeErrorDetail;

  constructor(detail: AssistantSessionExchangeErrorDetail, message: string) {
    super(message);
    this.name = 'AssistantSessionExchangeError';
    this.detail = detail;
  }

  /**
   * The narrowed sign-in refusal, when this failure is one. `elevation_ticket_expired` means the
   * visitor took too long — re-prompt; `elevation_tenant_mismatch` means a client reached for a
   * conversation it does not own — alert someone, never retry.
   */
  get elevationRefusal(): AssistantElevationRefusalCode | undefined {
    const code = this.detail.serviceCode;
    return code !== undefined &&
      (ASSISTANT_ELEVATION_REFUSAL_CODES as readonly string[]).includes(code)
      ? (code as AssistantElevationRefusalCode)
      : undefined;
  }
}

/** Never throws while reading the body — a proxy can answer with HTML instead of JSON. */
async function exchangeError(response: Response): Promise<AssistantSessionExchangeError> {
  const body = (await response.json().catch(() => undefined)) as
    | { readonly error?: unknown; readonly code?: unknown }
    | undefined;
  const serviceCode = typeof body?.code === 'string' ? body.code : undefined;
  return new AssistantSessionExchangeError(
    {
      code: 'session_exchange_failed',
      status: response.status,
      // `elevation_unavailable` is a 503 an operator has to fix; retrying cannot help.
      retryable: response.status >= 500 && serviceCode !== 'elevation_unavailable',
      ...(serviceCode === undefined ? {} : { serviceCode }),
    },
    `Assistant session exchange failed (${response.status})`,
  );
}

export async function createAssistantSession(
  input: CreateAssistantSessionInput,
  dependencies: { readonly fetch?: typeof fetch } = {},
): Promise<AssistantSession> {
  if (input.signInTicket !== undefined && (input as { context?: unknown }).context !== undefined) {
    // Mirrors resolveSessionSource: silently dropping what the service ignores would pick a
    // meaning the developer did not intend.
    throw new Error('context does not apply when spending a sign-in ticket');
  }
  const request = dependencies.fetch ?? fetch;
  const serviceUrl = input.serviceUrl.replace(/\/$/, '');
  const credentials = Buffer.from(`${input.clientId}:${input.clientSecret}`, 'utf8').toString(
    'base64',
  );
  const response = await request(`${serviceUrl}/v1/assistant/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      origin: input.origin,
      user: input.user,
      ...(input.signInTicket === undefined ? {} : { signInTicket: input.signInTicket }),
      ...(input.signInTicket !== undefined && input.resume !== undefined
        ? { resume: input.resume }
        : {}),
      ...(input.claims ? { claims: input.claims } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.preferences ? { preferences: input.preferences } : {}),
      ...(input.routing ? { routing: input.routing } : {}),
    }),
  });
  // A fresh mint answers 201, an elevation 200; both are the same wire shape (ADR 0151).
  if (!response.ok) throw await exchangeError(response);
  const session = (await response.json()) as AssistantSession;
  if (input.restoreConversation !== false || session.endpoints.transcript === undefined) {
    return session;
  }
  const { transcript: _transcript, ...endpoints } = session.endpoints;
  return { ...session, endpoints };
}
