import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
function safeHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !Array.from(value).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    );
  } catch {
    return false;
  }
}
const https = z.string().max(2048).refine(safeHttps);
const support = z
  .string()
  .max(512)
  .refine(
    (value) =>
      safeHttps(value) ||
      /^mailto:[A-Za-z0-9._+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(
        value,
      ),
  );

export const BusinessNoticeSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(
        (value) =>
          !Array.from(value).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      ),
    privacyUrl: https,
    supportUrl: support,
  })
  .strict();
export type BusinessNotice = z.infer<typeof BusinessNoticeSchema>;
export const BusinessNoticeSaveRequestSchema = z
  .object({ expectedRevision: z.number().int().nonnegative(), notice: BusinessNoticeSchema })
  .strict();
const noticeState = z
  .object({
    revision: z.number().int().nonnegative(),
    notice: BusinessNoticeSchema.nullable(),
    canEdit: z.boolean(),
  })
  .strict();
export const BusinessNoticeResponseSchema = z
  .object({ ok: z.literal(true), data: noticeState })
  .strict();
export const BusinessNoticeClientResponseSchema = z
  .object({
    ok: z.literal(true),
    data: noticeState.extend({ notice: BusinessNoticeSchema.strip().nullable() }).strip(),
  })
  .strip();

const document = z.object({ url: https, sha256: digest }).strict();
export const AgreementDocumentsSchema = z
  .object({ version, terms: document, privacy: document, processing: document })
  .strict();
const required = AgreementDocumentsSchema.extend({ documentDigest: digest }).strict();
const receipt = z
  .object({ version, documentDigest: digest, acceptedAt: z.string().datetime() })
  .strict();
const status = z
  .object({
    required: required.nullable(),
    canAccept: z.boolean(),
    accepted: z.boolean(),
    receipt: receipt.optional(),
  })
  .strict();
export const OrganizationAgreementResponseSchema = z
  .object({ ok: z.literal(true), data: status })
  .strict();
export const OrganizationAgreementClientResponseSchema = z
  .object({
    ok: z.literal(true),
    data: status
      .extend({
        required: required
          .extend({
            terms: document.strip(),
            privacy: document.strip(),
            processing: document.strip(),
          })
          .strip()
          .nullable(),
        receipt: receipt.strip().optional(),
      })
      .strip(),
  })
  .strip();
export type OrganizationAgreementStatus = z.infer<typeof status>;
export const OrganizationAgreementAcceptRequestSchema = z
  .object({ version, documentDigest: digest, accepted: z.literal(true) })
  .strict();
