import { z } from 'zod';

export const draftArtifactCheckSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), artifactDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({
    ok: z.literal(false),
    issues: z
      .array(
        z.strictObject({
          code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
          message: z.string().max(500),
          path: z.string().max(240).optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
]);
export type DraftArtifactCheck = z.infer<typeof draftArtifactCheckSchema>;
export interface DraftArtifactInput {
  readonly manifest: string;
  readonly connectors?: string;
}
export function draftCompileFailure(code: string): Extract<DraftArtifactCheck, { ok: false }> {
  return {
    ok: false,
    issues: [
      {
        code,
        message: 'This draft did not pass the source and manifest check. Nothing was published.',
      },
    ],
  };
}
