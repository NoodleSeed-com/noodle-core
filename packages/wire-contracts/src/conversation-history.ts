import { z } from 'zod';

/**
 * Staff projection of durable conversation history (ADR 0241). Server output is strict; the tolerant
 * `*ClientResponseSchema` variants let older clients ignore additive fields.
 */
export const ConversationIdSchema = z.string().regex(/^cv_[A-Za-z0-9_-]{8,64}$/);
export const ConversationChannelSchema = z.enum(['website', 'whatsapp']);

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
  items: z.array(ConversationItemSchema).max(10_000),
});

const NextCursorSchema = z.string().min(1).max(2048);

export const ConversationListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    conversations: z.array(ConversationSummarySchema).max(100),
    nextCursor: NextCursorSchema.optional(),
  }),
});
export const ConversationShowResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ conversation: ConversationDetailSchema }),
});
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
  items: z.array(ClientItemSchema).max(10_000),
});

export const ConversationListClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    conversations: z.array(ClientSummarySchema).max(100),
    nextCursor: NextCursorSchema.optional(),
  }),
});
export const ConversationShowClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ conversation: ClientDetailSchema }),
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
