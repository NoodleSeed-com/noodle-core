import { z } from 'zod';

/**
 * Staff projection of durable conversation history (ADR 0241). Server output is strict; the tolerant
 * `*ClientResponseSchema` variants let older clients ignore additive fields.
 */
export const ConversationIdSchema = z.string().regex(/^cv_[A-Za-z0-9_-]{8,64}$/);
export const ConversationChannelSchema = z.enum(['website', 'whatsapp']);
/** Staff review state; a failed tool outcome sets `needs_attention` automatically. */
export const ConversationReviewStatusSchema = z.enum(['new', 'needs_attention', 'reviewed']);
export type ConversationReviewStatus = z.infer<typeof ConversationReviewStatusSchema>;

const SubjectRefSchema = z.string().min(1).max(256);
/** Anonymous handles never leave the service; verified subjects carry the reference forget uses. */
const ConversationSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('anonymous') }),
  z.strictObject({ kind: z.literal('customer'), ref: SubjectRefSchema }),
  z.strictObject({ kind: z.literal('participant'), ref: SubjectRefSchema }),
]);

export const ConversationSummarySchema = z.strictObject({
  id: ConversationIdSchema,
  channel: ConversationChannelSchema,
  subject: ConversationSubjectSchema,
  startedAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
  itemCount: z.number().int().min(1),
  reviewStatus: ConversationReviewStatusSchema,
});

export const ConversationItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(100_000),
    at: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('outcome'),
    interactionId: z.string().min(1).max(256),
    tool: z.string().min(1).max(128),
    status: z.enum(['succeeded', 'failed', 'declined', 'cancelled']),
    at: z.iso.datetime(),
  }),
]);

export const ConversationDetailSchema = z.strictObject({
  ...ConversationSummarySchema.shape,
  /** When the last visible item is removed automatically under the live retention window. */
  expiresAt: z.iso.datetime(),
  items: z.array(ConversationItemSchema).max(10_000),
});

const NoteTextSchema = z.string().trim().min(1).max(2000);
/** A private staff note: never sent to the customer, never exported, removed with its conversation. */
export const ConversationNoteSchema = z.strictObject({
  author: z.string().min(1).max(500),
  text: NoteTextSchema,
  at: z.iso.datetime(),
});
/** Show adds the private notes that export leaves out. */
export const ConversationShowSchema = z.strictObject({
  ...ConversationDetailSchema.shape,
  notes: z.array(ConversationNoteSchema).max(100),
});

const NextCursorSchema = z.string().min(1).max(2048);
/** Present only for a Preview environment, whose conversations keep a short fixed window. */
const PreviewWindowSchema = z.strictObject({ retentionDays: z.number().int().min(0).max(365) });

export const ConversationListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    conversations: z.array(ConversationSummarySchema).max(100),
    nextCursor: NextCursorSchema.optional(),
    preview: PreviewWindowSchema.optional(),
  }),
});
/** Show and review both answer with the conversation as staff now see it. */
export const ConversationShowResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ conversation: ConversationShowSchema }),
});
/** Review status needs `records:status`, a note `records:note`; at least one is required. */
export const ConversationReviewRequestSchema = z
  .strictObject({
    reviewStatus: ConversationReviewStatusSchema.optional(),
    note: NoteTextSchema.optional(),
  })
  .refine((value) => value.reviewStatus !== undefined || value.note !== undefined, {
    message: 'Set a review status or add a note.',
  });
export type ConversationReviewRequest = z.infer<typeof ConversationReviewRequestSchema>;
export const ConversationExportResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    conversations: z.array(ConversationDetailSchema).max(25),
    nextCursor: NextCursorSchema.optional(),
  }),
});

export const ConversationForgetRequestSchema = z.union([
  z.strictObject({ conversationId: ConversationIdSchema }),
  z.strictObject({
    subject: z.strictObject({
      kind: z.enum(['customer', 'participant']),
      ref: SubjectRefSchema,
    }),
  }),
]);
export type ConversationForgetRequest = z.infer<typeof ConversationForgetRequestSchema>;
export const ConversationForgetResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    forgotten: z.strictObject({
      conversations: z.number().int().nonnegative(),
      items: z.number().int().nonnegative(),
    }),
  }),
});

const ClientSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('anonymous') }),
  z.object({ kind: z.literal('customer'), ref: SubjectRefSchema }),
  z.object({ kind: z.literal('participant'), ref: SubjectRefSchema }),
]);
const ClientSummarySchema = z.object({
  ...ConversationSummarySchema.shape,
  subject: ClientSubjectSchema,
});
const ClientItemSchema = z.discriminatedUnion('kind', [
  z.object(ConversationItemSchema.options[0].shape),
  z.object(ConversationItemSchema.options[1].shape),
]);
const ClientDetailSchema = z.object({
  ...ClientSummarySchema.shape,
  expiresAt: ConversationDetailSchema.shape.expiresAt,
  items: z.array(ClientItemSchema).max(10_000),
});

export const ConversationListClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    conversations: z.array(ClientSummarySchema).max(100),
    nextCursor: NextCursorSchema.optional(),
    preview: z.object(PreviewWindowSchema.shape).optional(),
  }),
});
export const ConversationShowClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    conversation: z.object({
      ...ClientDetailSchema.shape,
      notes: z.array(z.object(ConversationNoteSchema.shape)).max(100),
    }),
  }),
});
export const ConversationExportClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    conversations: z.array(ClientDetailSchema).max(25),
    nextCursor: NextCursorSchema.optional(),
  }),
});
export const ConversationForgetClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    forgotten: z.object(ConversationForgetResponseSchema.shape.data.shape.forgotten.shape),
  }),
});

/**
 * The customer-backend projection (ADR 0241 decision 12): an embed client lists or forgets one of its
 * own verified users, by the same `user.id` its session exchange sent. The tenant comes from the client
 * credential, never the body; rows carry no subject and at most a short preview of the first question.
 */
const CustomerUserSchema = z.strictObject({ id: z.string().min(1).max(240) });
export const ASSISTANT_CONVERSATION_PAGE_MAXIMUM = 50;
export const ASSISTANT_CONVERSATION_PREVIEW_MAXIMUM = 120;
export const AssistantConversationListRequestSchema = z.strictObject({
  user: CustomerUserSchema,
  limit: z.number().int().min(1).max(ASSISTANT_CONVERSATION_PAGE_MAXIMUM).optional(),
  cursor: NextCursorSchema.optional(),
});
export const AssistantConversationForgetUserRequestSchema = z.strictObject({
  user: CustomerUserSchema,
});
const AssistantConversationRowSchema = z.strictObject({
  id: ConversationIdSchema,
  channel: ConversationChannelSchema,
  startedAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
  preview: z.string().min(1).max(ASSISTANT_CONVERSATION_PREVIEW_MAXIMUM).optional(),
});
export const AssistantConversationListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    conversations: z.array(AssistantConversationRowSchema).max(ASSISTANT_CONVERSATION_PAGE_MAXIMUM),
    nextCursor: NextCursorSchema.optional(),
  }),
});
export const AssistantConversationListClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    conversations: z
      .array(z.object(AssistantConversationRowSchema.shape))
      .max(ASSISTANT_CONVERSATION_PAGE_MAXIMUM),
    nextCursor: NextCursorSchema.optional(),
  }),
});
