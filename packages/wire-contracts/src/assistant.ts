/**
 * The Embedded Assistant v1 session-exchange wire contract (ADR 0151): the response the hosted
 * service returns from `POST /v1/assistant/sessions`, consumed by every published
 * `@noodleseed/assistant` widget in the wild. The service parses its response through this schema
 * before sending; the widget's browser graph stays independent of private monorepo contract code, so its
 * side of the drift gate pins the golden fixture `contract/v1/assistant-session-response.json` instead of
 * importing this module. Public rendering dependencies are bundled into the published browser entry.
 *
 * The service must remain wire-compatible with the oldest supported published widget; changing a
 * required field here is a coordinated widget-major event with a new pinned fixture, never a local
 * edit (ADR 0151).
 */
import { z } from 'zod';

const MAX_MODEL_CONTEXT_BYTES = 16 * 1024;
const MAX_MODEL_CONTEXT_DEPTH = 8;
const MAX_MODEL_CONTEXT_ENTRIES = 128;
const SENSITIVE_CONTEXT_KEY =
  /(?:secret|token|api[-_]?key|password|credential|authorization|cookie)/i;
const CREDENTIAL_SHAPED_TEXT =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{20,}\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b)/i;

/**
 * Theming/behavior payload forwarded to the widget. Advisory presentation data: the widget renders
 * safe defaults when it is absent, so only its envelope is pinned — the branding/assistant contents
 * belong to the authoring/appearance layer and may grow additively without a contract event.
 */
const assistantSessionConfigurationSchema = z.object({
  branding: z.record(z.string(), z.unknown()).optional(),
  assistant: z.record(z.string(), z.unknown()).optional(),
});

export const assistantSessionResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().min(1),
  endpoints: z.object({
    turns: z.url(),
    toolConfirmations: z.url(),
    /** Additive interaction endpoint used by headless clients; absent on legacy services. */
    interactions: z.url().optional(),
    /** Additive MCP Apps bridge endpoint used by embedded-host renderers. */
    apps: z.url().optional(),
    /**
     * Additive hosted sandbox document for widget frames. A remote `src` document carries its own
     * CSP, so widgets render on CSP-strict embedder pages where `about:srcdoc` frames (which
     * inherit the embedder's CSP) cannot run their inline bridge. Absent on older services; the
     * published client falls back to the srcdoc proxy.
     */
    sandbox: z.url().optional(),
    /**
     * Additive bounded visible-transcript endpoint (ADR 0141/0201 amendments 2026-08-26): a
     * session-token-authenticated POST replaying standard assistant events after a full-page
     * navigation — the sign-in redirect above all. Absent on older services; the widget then starts
     * visually fresh exactly as before.
     */
    transcript: z.url().optional(),
    /** Additive model-generated prompt suggestions; its presence is the client capability gate. */
    suggestions: z.url().optional(),
  }),
  configuration: assistantSessionConfigurationSchema.optional(),
  /**
   * Additive: present only on an elevation exchange that armed the one-shot resume of the
   * intercepted tool (issue #1177). The widget then requests one `{ resume: true }` turn on the
   * existing turns endpoint; older widgets strip unknown keys and simply never auto-resume.
   */
  resume: z.object({ tool: z.string().min(1) }).optional(),
  /** Additive elevation marker; the client renders one bounded continuation status. */
  continuedAfterAuthentication: z.literal(true).optional(),
});

export type AssistantSessionResponse = z.infer<typeof assistantSessionResponseSchema>;

const recoverableViewSchema = z
  .object({
    id: z.string().min(1),
    tool: z.string().min(1),
    resourceUri: z.string().startsWith('ui://'),
    title: z.string().min(1).optional(),
    result: z.json(),
    arguments: z.json().optional(),
    html: z.string().min(1),
    resourceMeta: z.record(z.string(), z.unknown()).optional(),
    allowedOpenDomains: z.array(z.url().startsWith('https://')).optional(),
    replayed: z.literal(true),
  })
  .strict();

const assistantModelContentPartSchema = z
  .object({ type: z.literal('text'), text: z.string() })
  .strict();

/** MCP-Apps-shaped, author-selected renderer summary included on one assistant turn. */
export const assistantModelContextUpdateSchema = z
  .object({
    content: z.array(assistantModelContentPartSchema).max(MAX_MODEL_CONTEXT_ENTRIES).optional(),
    structuredContent: z.record(z.string(), z.json()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const problem = modelContextProblem(value);
    if (problem) context.addIssue({ code: 'custom', message: problem });
  });

export type AssistantModelContextUpdate = z.infer<typeof assistantModelContextUpdateSchema>;

/** Typed application-owned context included on one turn and always treated as untrusted data. */
export const assistantPageContextSchema = z
  .record(z.string(), z.json())
  .superRefine((value, context) => {
    const problem = modelContextProblem(value);
    if (problem)
      context.addIssue({
        code: 'custom',
        message: problem.replaceAll('model context', 'page context'),
      });
  });

export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;

/**
 * One Embedded Assistant turn request: a visitor message, or `{ resume: true }` — the one-shot
 * trigger for the server-held post-sign-in resume (issue #1177), which carries no user text
 * because the pending intent is server state. Optional fields are additive v1 capabilities.
 */
export const assistantMessageTurnRequestSchema = z
  .object({
    message: z
      .string()
      .min(1)
      .max(16_000)
      .refine((value) => value.trim().length > 0, 'message must contain non-whitespace text'),
    clientContext: z
      .object({ locale: z.string().max(160).optional(), timeZone: z.string().max(160).optional() })
      .strict()
      .optional(),
    modelContext: assistantModelContextUpdateSchema.optional(),
    pageContext: assistantPageContextSchema.optional(),
    suggestions: z.literal(true).optional(),
  })
  .strict();

export const assistantResumeTurnRequestSchema = z
  .object({ resume: z.literal(true), suggestions: z.literal(true).optional() })
  .strict();

export type AssistantMessageTurnRequest = z.infer<typeof assistantMessageTurnRequestSchema>;

export const assistantTurnRequestSchema = z.union([
  assistantMessageTurnRequestSchema,
  assistantResumeTurnRequestSchema,
]);

export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

/** Fresh untrusted context for the optional initial-suggestions request. */
export const assistantSuggestionsRequestSchema = z
  .object({
    clientContext: z
      .object({ locale: z.string().max(160).optional(), timeZone: z.string().max(160).optional() })
      .strict()
      .optional(),
    modelContext: assistantModelContextUpdateSchema.optional(),
    pageContext: assistantPageContextSchema.optional(),
  })
  .strict();

export type AssistantSuggestionsRequest = z.infer<typeof assistantSuggestionsRequestSchema>;

/**
 * Resolve one server-held assistant interaction. The client returns only its decision and optional
 * schema-constrained input; reviewed tool arguments remain server-held and cannot be substituted here.
 */
export const assistantInteractionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      id: z.string().min(1),
      action: z.literal('accept'),
      content: z.json().optional(),
      suggestions: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      action: z.literal('decline'),
      suggestions: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      action: z.literal('cancel'),
      suggestions: z.literal(true).optional(),
    })
    .strict(),
]);

export type AssistantInteractionRequest = z.infer<typeof assistantInteractionRequestSchema>;

const optionalTurnId = z.string().min(1).optional();
const eventEnvelope = <T extends z.ZodType>(event: string, data: T) =>
  z.object({ event: z.literal(event), data });

/**
 * Embedded Assistant v1 named-SSE events. Existing event names stay additive: new services enrich
 * proposal/completion payloads while clients talking to older services tolerate absent new fields.
 */
export const assistantWireEventSchema = z.union([
  eventEnvelope('message_started', z.object({ message: z.string().min(1) })),
  eventEnvelope('resume_started', z.object({ tool: z.string() })),
  eventEnvelope('message_completed', z.object({})),
  eventEnvelope('content', z.object({ turnId: optionalTurnId, delta: z.string() })),
  eventEnvelope(
    'tool_started',
    z.object({
      turnId: optionalTurnId,
      id: z.string().min(1),
      tool: z.string().min(1),
    }),
  ),
  eventEnvelope(
    'tool_proposed',
    z.object({
      turnId: optionalTurnId,
      id: z.string().min(1),
      tool: z.string().min(1),
      title: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      arguments: z.json().optional(),
      reviewSchema: z.record(z.string(), z.unknown()).optional(),
      expiresAt: z.string().min(1).optional(),
      requiresConfirmation: z.literal(true),
    }),
  ),
  eventEnvelope(
    'input_requested',
    z.object({
      turnId: optionalTurnId,
      id: z.string().min(1),
      message: z.string().min(1),
      requestedSchema: z.record(z.string(), z.unknown()),
      expiresAt: z.string().min(1),
    }),
  ),
  eventEnvelope(
    'interaction_resolved',
    z.object({
      turnId: optionalTurnId,
      id: z.string().min(1),
      action: z.enum(['accept', 'decline', 'cancel']),
    }),
  ),
  eventEnvelope(
    'tool_completed',
    z.object({
      turnId: optionalTurnId,
      id: z.string().min(1),
      tool: z.string().min(1),
      result: z.json(),
      arguments: z.json().optional(),
      html: z.string().min(1).optional(),
      resourceMeta: z.record(z.string(), z.unknown()).optional(),
      replayed: z.literal(true).optional(),
    }),
  ),
  eventEnvelope(
    'view_available',
    recoverableViewSchema.omit({ replayed: true }).extend({
      turnId: optionalTurnId,
      html: z.string().min(1).optional(),
      replayed: z.literal(true).optional(),
    }),
  ),
  eventEnvelope(
    'auth_requested',
    z.object({
      turnId: optionalTurnId,
      id: z.string().min(1),
      tool: z.string().min(1),
      signInTicket: z.string().min(1),
      /** Legacy alias of `signInTicket`; widgets published before the rename guard on this key. */
      continuation: z.string().min(1),
      expiresAt: z.string().min(1),
    }),
  ),
  eventEnvelope(
    'suggested_prompts',
    z.object({
      turnId: optionalTurnId,
      phase: z.enum(['initial', 'follow_up']),
      prompts: z.array(z.string().trim().min(1).max(240)).max(3),
    }),
  ),
  eventEnvelope(
    'error',
    z.object({
      turnId: optionalTurnId,
      code: z.string().min(1),
      status: z.number().int().optional(),
      retryable: z.boolean().optional(),
    }),
  ),
  eventEnvelope('done', z.object({ turnId: optionalTurnId })),
]);

export type AssistantWireEvent = z.infer<typeof assistantWireEventSchema>;

function modelContextProblem(value: AssistantModelContextUpdate): string | undefined {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_MODEL_CONTEXT_BYTES) {
    return 'model context must not exceed 16 KiB';
  }
  return jsonContextProblem(value, '$', 0);
}

function jsonContextProblem(value: unknown, path: string, depth: number): string | undefined {
  if (depth > MAX_MODEL_CONTEXT_DEPTH) return `model context exceeds maximum depth at ${path}`;
  if (typeof value === 'string') {
    return CREDENTIAL_SHAPED_TEXT.test(value)
      ? `model context contains credential-shaped text at ${path}`
      : undefined;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return undefined;
  if (typeof value !== 'object') return `model context contains a non-JSON value at ${path}`;
  const entries: readonly (readonly [string, unknown])[] = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);
  if (entries.length > MAX_MODEL_CONTEXT_ENTRIES) {
    return `model context has more than 128 entries at ${path}`;
  }
  for (const [key, entry] of entries) {
    if (!Array.isArray(value) && SENSITIVE_CONTEXT_KEY.test(key)) {
      return `model context contains sensitive key ${path}.${key}`;
    }
    const problem = jsonContextProblem(entry, `${path}.${key}`, depth + 1);
    if (problem) return problem;
  }
  return undefined;
}
