import { annotations, tool, z } from '@noodleseed/one';
import {
  createListColumnInputSchema,
  listColumnSchema,
  listItemSchema,
  listSchema,
} from './schemas.js';

const readAnnotations = annotations.readOnly({ openWorld: true });

export function sharePointListTools() {
  return [
    tool('sharepoint_list_site_lists', {
      description:
        'List SharePoint lists for a known site after sharepoint_list_sites has returned a siteId. Use this when the user asks what lists exist in a SharePoint site, or before list item operations when the listId is not known. Returns listId values that must be reused for column, item, add, update, query, and delete item tools.',
      annotations: readAnnotations,
      input: z.object({
        siteId: z
          .string()
          .describe(
            'Microsoft Graph site id, for example the siteId returned by sharepoint_list_sites. Do not invent this value; look it up first if the user only gave a site name.',
          ),
      }),
      output: z.object({
        siteId: z.string(),
        lists: z.array(listSchema),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.listSiteLists({ siteId: input.siteId });
        const summary = connectors.sharepoint.summarize({ kind: 'lists', value: result.lists });
        return { siteId: input.siteId, lists: summary.result };
      },
    }),
    tool('sharepoint_list_list_columns', {
      description:
        'Inspect the columns for a SharePoint list before adding or editing list items. Use this when Gemini is unsure which fields exist, whether a field is read-only, or what valid choice values are. The returned name is the internal SharePoint field name; displayName is the human label users usually mention.',
      annotations: readAnnotations,
      input: z.object({
        siteId: z.string().describe('Microsoft Graph site id returned by sharepoint_list_sites.'),
        listId: z
          .string()
          .describe('Microsoft Graph list id returned by sharepoint_list_site_lists.'),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        columns: z.array(listColumnSchema),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.listListColumns({
          siteId: input.siteId,
          listId: input.listId,
        });
        const summary = connectors.lists.summarizeColumns({
          kind: 'columns',
          columns: result.columns,
        });
        return { siteId: input.siteId, listId: input.listId, columns: summary.result };
      },
    }),
    tool('sharepoint_create_list', {
      description:
        'Create a new SharePoint list in a site. Defaults to the Microsoft Graph genericList template and returns the new listId for follow-up list item calls. Use simple column strings for text columns, or objects such as {"name":"Age","type":"number"} and {"name":"Status","type":"choice","choices":["Open","Closed"]}. This Graph-only demo does not expose deleting an entire list.',
      annotations: annotations.openAction({ destructive: false }),
      input: z.object({
        siteId: z
          .string()
          .describe(
            'Microsoft Graph site id, for example the siteId returned by sharepoint_list_sites.',
          ),
        displayName: z.string().describe('Display name for the new SharePoint list.'),
        description: z.string().optional().describe('Optional description for the list.'),
        template: z
          .string()
          .optional()
          .describe('Microsoft Graph list template. Defaults to genericList.'),
        columns: z
          .array(createListColumnInputSchema)
          .optional()
          .describe(
            'Optional list columns. Use strings for text columns, or objects with name/type such as {"name":"Department","type":"text"}, {"name":"Age","type":"number"}, {"name":"Done","type":"boolean"}, {"name":"DueDate","type":"dateTime"}, or {"name":"Status","type":"choice","choices":["Open","Closed"]}.',
          ),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        list: listSchema,
        normalizedColumns: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
      fulfil({ input, connectors }) {
        const normalizedColumns = connectors.lists.normalizeCreateListColumns({
          kind: 'create_list_columns',
          columns: input.columns,
        });
        const result = connectors.graph.createSiteList({
          siteId: input.siteId,
          displayName: input.displayName,
          description: input.description,
          template: input.template,
          columns: normalizedColumns.result.columns,
        });
        return {
          siteId: input.siteId,
          listId: result.listId,
          list: result,
          normalizedColumns: normalizedColumns.result.normalizedColumns,
        };
      },
    }),
    tool('sharepoint_list_list_items', {
      description:
        'List items in a SharePoint list and return each itemId plus all expanded column values. Use this list-specific tool instead of the generic sharepoint_list_items when the user wants rows from a SharePoint list. Use the returned itemId for sharepoint_get_list_item, sharepoint_update_list_item, or sharepoint_delete_list_item. If skipToken is returned, pass it back to fetch the next page.',
      annotations: readAnnotations,
      input: z.object({
        siteId: z.string().describe('Microsoft Graph site id returned by sharepoint_list_sites.'),
        listId: z
          .string()
          .describe('Microsoft Graph list id returned by sharepoint_list_site_lists.'),
        skipToken: z
          .string()
          .optional()
          .describe('Continuation token returned by a previous sharepoint_list_list_items call.'),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        items: z.array(listItemSchema),
        nextLink: z.string().optional(),
        skipToken: z.string().optional(),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.listListItems({
          siteId: input.siteId,
          listId: input.listId,
          $skiptoken: input.skipToken,
        });
        const summary = connectors.sharepoint.summarize({
          kind: 'list_items_page',
          value: result.page,
        });
        return {
          siteId: input.siteId,
          listId: input.listId,
          items: summary.result.items,
          nextLink: summary.result.nextLink,
          skipToken: summary.result.skipToken,
        };
      },
    }),
    tool('sharepoint_query_list', {
      description:
        'Query SharePoint list items with a Microsoft Graph $filter expression and return item ids plus expanded columns.',
      annotations: readAnnotations,
      input: z.object({
        siteId: z.string(),
        listId: z.string(),
        filter: z.string(),
        skipToken: z
          .string()
          .optional()
          .describe('Continuation token returned by a previous query response.'),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        filter: z.string(),
        items: z.array(listItemSchema),
        nextLink: z.string().optional(),
        skipToken: z.string().optional(),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.queryListItems({
          siteId: input.siteId,
          listId: input.listId,
          filter: input.filter,
          $skiptoken: input.skipToken,
        });
        const summary = connectors.sharepoint.summarize({
          kind: 'list_items_page',
          value: result.page,
        });
        return {
          siteId: input.siteId,
          listId: input.listId,
          filter: input.filter,
          items: summary.result.items,
          nextLink: summary.result.nextLink,
          skipToken: summary.result.skipToken,
        };
      },
    }),
    tool('sharepoint_add_list_item', {
      description:
        'Add an item to an existing SharePoint list using human-friendly column values. The values object may use visible column display names or internal names; this tool fetches the list columns, resolves names case-insensitively, validates common text/number/boolean/dateTime/choice values, and then writes the item through Microsoft Graph. Use sharepoint_list_list_columns first when unsure which fields exist.',
      annotations: annotations.openAction({ destructive: false }),
      input: z.object({
        siteId: z.string().describe('Microsoft Graph site id returned by sharepoint_list_sites.'),
        listId: z
          .string()
          .describe('Microsoft Graph list id returned by sharepoint_list_site_lists.'),
        values: z
          .record(z.string(), z.unknown())
          .describe(
            'Column values keyed by visible column display names or internal names, for example {"Title":"Launch task","Status":"Open"} or {"Task name":"Launch task"}. Do not include read-only columns.',
          ),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        item: listItemSchema,
        columns: z.record(z.string(), z.unknown()),
        resolvedFields: z.record(z.string(), z.string()),
      }),
      fulfil({ input, connectors }) {
        const resolved = connectors.lists.resolveListItemValues({
          kind: 'list_item_values',
          siteId: input.siteId,
          listId: input.listId,
          values: input.values,
        });
        const result = connectors.graph.createListItem({
          siteId: input.siteId,
          listId: input.listId,
          fields: resolved.result.fields,
        });
        const item = {
          siteId: input.siteId,
          listId: input.listId,
          itemId: result.itemId,
          name: result.columns.Title,
          webUrl: result.webUrl,
          createdDateTime: result.createdDateTime,
          lastModifiedDateTime: result.lastModifiedDateTime,
          columns: result.columns,
        };
        return {
          siteId: input.siteId,
          listId: input.listId,
          itemId: result.itemId,
          item,
          columns: result.columns,
          resolvedFields: resolved.result.resolvedFields,
        };
      },
    }),
    tool('sharepoint_get_list_item', {
      description:
        'Get one SharePoint list item by siteId, listId, and itemId. Use this as a safety check before updating or deleting a list item, especially when the user identified a row by name or position rather than by itemId.',
      annotations: readAnnotations,
      input: z.object({
        siteId: z.string().describe('Microsoft Graph site id returned by sharepoint_list_sites.'),
        listId: z
          .string()
          .describe('Microsoft Graph list id returned by sharepoint_list_site_lists.'),
        itemId: z
          .string()
          .describe('Microsoft Graph list item id returned by sharepoint_list_list_items.'),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        item: listItemSchema,
        columns: z.record(z.string(), z.unknown()),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.getListItem({
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
        });
        const summary = connectors.sharepoint.summarize({
          kind: 'list_item',
          value: result.item,
        });
        return {
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
          item: summary.result,
          columns: summary.result.columns,
        };
      },
    }),
    tool('sharepoint_update_list_item', {
      description:
        'Perform a partial update of an existing SharePoint list item. Use this only when the itemId is known or after sharepoint_get_list_item confirms the correct row. The values object may use visible column display names or internal names; this tool resolves and validates those names before calling Microsoft Graph PATCH /fields. Only provided fields are changed.',
      annotations: annotations.openAction({ destructive: false }),
      input: z.object({
        siteId: z.string().describe('Microsoft Graph site id returned by sharepoint_list_sites.'),
        listId: z
          .string()
          .describe('Microsoft Graph list id returned by sharepoint_list_site_lists.'),
        itemId: z
          .string()
          .describe('Microsoft Graph list item id returned by sharepoint_list_list_items.'),
        values: z
          .record(z.string(), z.unknown())
          .describe(
            'Fields to update, keyed by visible column display names or internal names. Include only columns the user wants changed; do not include read-only columns.',
          ),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        columns: z.record(z.string(), z.unknown()),
        resolvedFields: z.record(z.string(), z.string()),
      }),
      fulfil({ input, connectors }) {
        const resolved = connectors.lists.resolveListItemValues({
          kind: 'list_item_values',
          siteId: input.siteId,
          listId: input.listId,
          values: input.values,
        });
        const result = connectors.graph.updateListItemFields({
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
          fields: resolved.result.fields,
        });
        return {
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
          columns: result.columns,
          resolvedFields: resolved.result.resolvedFields,
        };
      },
    }),
    tool('sharepoint_delete_list_item', {
      description:
        'Delete one SharePoint list item by confirmed itemId. This is destructive. If the user has not provided a confirmed itemId, first call sharepoint_list_list_items or sharepoint_get_list_item to identify the exact row. This Graph-only demo can delete list items, but it does not delete entire SharePoint lists because Microsoft Graph v1.0 does not expose a delete-list endpoint.',
      annotations: annotations.openAction({ destructive: true }),
      input: z.object({
        siteId: z.string().describe('Microsoft Graph site id returned by sharepoint_list_sites.'),
        listId: z
          .string()
          .describe('Microsoft Graph list id returned by sharepoint_list_site_lists.'),
        itemId: z
          .string()
          .describe(
            'Confirmed Microsoft Graph list item id returned by sharepoint_list_list_items.',
          ),
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        deleted: z.boolean(),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.deleteListItem({
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
        });
        return {
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
          deleted: result.deleted,
        };
      },
    }),
  ];
}
