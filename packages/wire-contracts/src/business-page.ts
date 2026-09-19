import { z } from 'zod';
import { BusinessNoticeSchema } from './solution-onboarding.js';

const revision = z.number().int().min(0).max(2_147_483_647);
const positiveRevision = revision.positive();
const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        !Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
        }),
    );
const section = z.strictObject({ title: text(120), text: text(4000) });
export const BusinessPageContentSchema = z.strictObject({
  introduction: text(1200),
  sections: z.array(section).max(8),
});
export type BusinessPageContent = z.infer<typeof BusinessPageContentSchema>;
const contentClient = BusinessPageContentSchema.extend({
  sections: z.array(section.strip()).max(8),
}).strip();

export const BusinessPageSaveRequestSchema = z.strictObject({
  expectedRevision: revision,
  content: BusinessPageContentSchema,
});
export const BusinessPagePublishRequestSchema = z.strictObject({
  expectedRevision: positiveRevision,
});
export const BusinessPageUnpublishRequestSchema = BusinessPagePublishRequestSchema;

/** A snapshot approved by a business administrator, not current mutable business settings. */
export const BusinessPagePublicationSchema = z.strictObject({
  content: BusinessPageContentSchema,
  notice: BusinessNoticeSchema,
  noticeRevision: positiveRevision,
  sourceRevision: positiveRevision,
  deploymentId: z.string().min(1).max(128),
  publishedAt: z.iso.datetime(),
});
export type BusinessPagePublication = z.infer<typeof BusinessPagePublicationSchema>;
const publicationClient = BusinessPagePublicationSchema.extend({
  content: contentClient,
  notice: BusinessNoticeSchema.strip(),
}).strip();
const pageState = z.strictObject({
  revision,
  draft: BusinessPageContentSchema.nullable(),
  published: BusinessPagePublicationSchema.nullable(),
  canEdit: z.boolean(),
});
export const BusinessPageResponseSchema = z.strictObject({ ok: z.literal(true), data: pageState });
export const BusinessPageClientResponseSchema = z
  .object({
    ok: z.literal(true),
    data: pageState
      .extend({
        draft: contentClient.nullable(),
        published: publicationClient.nullable(),
      })
      .strip(),
  })
  .strip();

const assistantUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.hash &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
const publicAssistant = z.strictObject({
  embedId: z.string().min(1).max(128),
  serviceUrl: assistantUrl,
  scriptUrl: assistantUrl,
});
const publicPage = z.strictObject({
  publicId: z.string().regex(/^sol_[a-f0-9]{32}$/),
  content: BusinessPageContentSchema,
  notice: BusinessNoticeSchema,
  assistant: publicAssistant.nullable(),
});
/** Intentionally excludes draft, subjects, scope, configuration, and records. */
export const PublicBusinessPageResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: publicPage,
});
export const PublicBusinessPageClientResponseSchema = z
  .object({
    ok: z.literal(true),
    data: publicPage
      .extend({
        content: contentClient,
        notice: BusinessNoticeSchema.strip(),
        assistant: publicAssistant.strip().nullable(),
      })
      .strip(),
  })
  .strip();
