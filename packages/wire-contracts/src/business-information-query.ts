import { z } from 'zod';

/** Maximum decrypted candidates for a native payload filter/sort query, not a storage quota. */
export const MANAGED_RECORD_QUERY_SCAN_LIMIT = 10_000;
export const ManagedRecordQuerySchema = z
  .object({
    filters: z
      .array(
        z
          .object({
            field: z.string().min(1).max(128),
            value: z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    sortField: z.string().min(1).max(128).optional(),
    sortDirection: z.enum(['asc', 'desc']).optional(),
    createdAtFrom: z.iso.datetime({ offset: true }).optional(),
    createdAtTo: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sortDirection !== undefined && value.sortField === undefined)
      context.addIssue({ code: 'custom', message: 'sortDirection requires sortField' });
    if (
      value.createdAtFrom !== undefined &&
      value.createdAtTo !== undefined &&
      Date.parse(value.createdAtFrom) > Date.parse(value.createdAtTo)
    )
      context.addIssue({ code: 'custom', message: 'createdAtFrom must not follow createdAtTo' });
    if (new Set(value.filters?.map((filter) => filter.field)).size !== (value.filters?.length ?? 0))
      context.addIssue({ code: 'custom', message: 'duplicate filter fields are not allowed' });
  });
export type ManagedRecordQuery = z.infer<typeof ManagedRecordQuerySchema>;
export const ManagedRecordQueryErrorSchema = z
  .object({
    error: z.string(),
    code: z.enum(['invalid_query', 'query_limit_exceeded']),
  })
  .strict();
