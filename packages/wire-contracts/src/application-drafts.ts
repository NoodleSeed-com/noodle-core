import { z } from 'zod';

/** Bounded browser-authoring input; not the compiled deployment artifact allowance. */
export const APPLICATION_DRAFT_LIMITS = Object.freeze({
  draftsPerApp: 10,
  draftsPerWorkspace: 50,
  sourceBytesPerWorkspace: 32 * 1024 * 1024,
  receiptsPerWorkspace: 10_000,
  retryWindowMs: 24 * 60 * 60 * 1000,
  revisionsPerDraft: 100,
  files: 64,
  pathChars: 240,
  fileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
});

const sourcePath = z
  .string()
  .max(APPLICATION_DRAFT_LIMITS.pathChars)
  .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:ts|tsx|css)$/);
const sourceText = z
  .string()
  .max(APPLICATION_DRAFT_LIMITS.fileBytes)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= APPLICATION_DRAFT_LIMITS.fileBytes,
    'Source file exceeds the UTF-8 byte allowance',
  );

function sourceSchema(additive: boolean) {
  const object = additive ? z.object : z.strictObject;
  return object({
    entrypoint: sourcePath.refine((path) => /\.tsx?$/.test(path), 'Entrypoint must be TypeScript'),
    files: z
      .array(object({ path: sourcePath, content: sourceText }))
      .min(1)
      .max(APPLICATION_DRAFT_LIMITS.files),
  }).superRefine((source, context) => {
    const paths = source.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', message: 'Source paths must be unique', path: ['files'] });
    }
    if (!paths.includes(source.entrypoint)) {
      context.addIssue({ code: 'custom', message: 'Entrypoint must exist', path: ['entrypoint'] });
    }
    const bytes = source.files.reduce(
      (total, file) => total + new TextEncoder().encode(file.content).byteLength,
      0,
    );
    if (bytes > APPLICATION_DRAFT_LIMITS.totalBytes) {
      context.addIssue({
        code: 'custom',
        message: 'Draft source exceeds the byte allowance',
        path: ['files'],
      });
    }
  });
}

export const ApplicationDraftSourceSchema = sourceSchema(false);
export type ApplicationDraftSource = z.infer<typeof ApplicationDraftSourceSchema>;
export const ApplicationDraftIdSchema = z.string().uuid();
const revision = z.number().int().positive().max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const environment = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export const ApplicationDraftCreateRequestSchema = z.strictObject({
  environment,
  source: ApplicationDraftSourceSchema,
  baseRelease: z.string().min(1).max(200).optional(),
});
export const ApplicationDraftEditRequestSchema = z.strictObject({
  expectedRevision: revision,
  source: ApplicationDraftSourceSchema,
});
export const ApplicationDraftUndoRequestSchema = z.strictObject({
  expectedRevision: revision,
  targetRevision: revision,
});
export const ApplicationDraftRevisionRequestSchema = z.strictObject({
  expectedRevision: revision,
});

function draftSchema(additive: boolean) {
  const object = additive ? z.object : z.strictObject;
  return object({
    id: ApplicationDraftIdSchema,
    org: environment,
    app: environment,
    environment,
    revision,
    sourceDigest: digest,
    source: sourceSchema(additive),
    baseRelease: z.string().min(1).max(200).optional(),
    createdAt: z.iso.datetime(),
    createdBySubject: z.string().min(1).max(500),
    updatedAt: z.iso.datetime(),
    updatedBySubject: z.string().min(1).max(500),
    origin: z.enum(['manual', 'guided', 'ai', 'undo', 'import']),
  });
}

export const ApplicationDraftSchema = draftSchema(false);
export type ApplicationDraft = z.infer<typeof ApplicationDraftSchema>;
export const ApplicationDraftSummarySchema = ApplicationDraftSchema.omit({ source: true });
export type ApplicationDraftSummary = z.infer<typeof ApplicationDraftSummarySchema>;
export const ApplicationDraftResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ draft: ApplicationDraftSchema }),
});

function historyResponse(additive: boolean) {
  const object = additive ? z.object : z.strictObject;
  return object({
    ok: z.literal(true),
    data: object({
      revisions: z
        .array(draftSchema(additive).omit({ source: true }))
        .max(APPLICATION_DRAFT_LIMITS.revisionsPerDraft),
    }),
  });
}
export const ApplicationDraftHistoryResponseSchema = historyResponse(false);
export const ApplicationDraftHistoryClientResponseSchema = historyResponse(true);

function diffSchema(additive: boolean) {
  const object = additive ? z.object : z.strictObject;
  return object({
    draftId: ApplicationDraftIdSchema,
    fromRevision: revision,
    toRevision: revision,
    fromDigest: digest,
    toDigest: digest,
    fromEntrypoint: sourcePath,
    toEntrypoint: sourcePath,
    changes: z
      .array(
        object({ path: sourcePath, before: sourceText.nullable(), after: sourceText.nullable() }),
      )
      .max(APPLICATION_DRAFT_LIMITS.files * 2),
  });
}
export const ApplicationDraftDiffSchema = diffSchema(false);
export type ApplicationDraftDiff = z.infer<typeof ApplicationDraftDiffSchema>;
export const ApplicationDraftDiffResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ diff: ApplicationDraftDiffSchema }),
});
export const ApplicationDraftDiffClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ diff: diffSchema(true) }),
});
export const ApplicationDraftDiffRequestSchema = z.strictObject({ from: revision, to: revision });
export const ApplicationDraftClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ draft: draftSchema(true) }),
});

export const ApplicationDraftListResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({
    drafts: z
      .array(ApplicationDraftSchema.omit({ source: true }))
      .max(APPLICATION_DRAFT_LIMITS.draftsPerApp),
  }),
});
export const ApplicationDraftListClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    drafts: z
      .array(draftSchema(true).omit({ source: true }))
      .max(APPLICATION_DRAFT_LIMITS.draftsPerApp),
  }),
});
