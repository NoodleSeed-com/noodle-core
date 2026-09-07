import { z } from '@noodleseed/one';

export const listSchema = z.object({
  listId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  webUrl: z.string().optional(),
  template: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
});

export const listColumnSchema = z.object({
  columnId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  indexed: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  required: z.boolean().optional(),
  type: z.string().optional(),
  definition: z.unknown().optional(),
});

export const listItemSchema = z.object({
  siteId: z.string().optional(),
  listId: z.string().optional(),
  itemId: z.string(),
  name: z.string().optional(),
  webUrl: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  columns: z.record(z.string(), z.unknown()),
});
