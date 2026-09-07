import { z } from '@noodleseed/one';

export const driveItemSchema = z.object({
  siteId: z.string().optional(),
  driveId: z.string().optional(),
  parentItemId: z.string().optional(),
  itemId: z.string(),
  name: z.string(),
  webUrl: z.string().optional(),
  downloadUrl: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  itemType: z.enum(['file', 'folder', 'item']),
});

export const driveSchema = z.object({
  driveId: z.string(),
  name: z.string(),
  webUrl: z.string().optional(),
  driveType: z.string().optional(),
});

export const listSchema = z.object({
  listId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  webUrl: z.string().optional(),
  template: z.string().optional(),
});

export const listColumnSchema = z.object({
  columnId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  type: z.enum(['text', 'number', 'boolean', 'dateTime', 'choice', 'unknown']),
  required: z.boolean().optional(),
  hidden: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  choices: z.array(z.string()).optional(),
});

export const createListColumnInputSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    type: z.enum(['text', 'number', 'boolean', 'dateTime', 'choice']).optional(),
    choices: z.array(z.string()).optional(),
  }),
  z.record(z.string(), z.unknown()),
]);

export const listItemSchema = z.object({
  siteId: z.string().optional(),
  listId: z.string().optional(),
  itemId: z.string(),
  name: z.string().optional(),
  webUrl: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  columns: z.unknown(),
});
