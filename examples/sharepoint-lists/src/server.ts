import {
  annotations,
  connector,
  customerAuth,
  prompt,
  resource,
  secret,
  server,
  tool,
  z,
} from '@noodleseed/one';
import { graph, graphScopes, microsoftClientId, microsoftTenantId } from './graph.js';
import { listColumnSchema, listItemSchema, listSchema } from './schemas.js';
import { runSharePointListsCompute } from './summaries.js';

const sharepointLists = connector('sharepoint_lists_summary')
  .version('1.0.0')
  .compute('summarize', {
    input: z.object({ kind: z.string(), value: z.unknown().optional() }),
    output: z.object({ result: z.unknown() }),
    run: runSharePointListsCompute,
  })
  .compute('normalize_create_list_columns', {
    input: z.object({ kind: z.string(), columns: z.array(z.unknown()).optional() }),
    output: z.object({ result: z.record(z.string(), z.unknown()) }),
    run: runSharePointListsCompute,
  });

const readAnnotations = annotations.readOnly({ openWorld: true });
const writeAnnotations = annotations.openAction({ destructive: false });
const deleteAnnotations = annotations.openAction({ destructive: true });

const columnDefinitionInput = z
  .record(z.string(), z.unknown())
  .describe(
    'Microsoft Graph columnDefinition object. Include an internal name plus exactly one type facet such as {"text":{}}, {"number":{}}, {"choice":{"choices":["Open","Closed"]}}, or {"dateTime":{}}.',
  );

const fieldValuesInput = z
  .record(z.string(), z.unknown())
  .describe(
    'Column values keyed by internal SharePoint column name. Call sharepoint_list_columns first when unsure.',
  );

export default server(
  'sharepoint_lists_microsoft_graph',
  {
    title: 'SharePoint Lists Microsoft Graph',
    version: '1.0.0',
    use: { graph, sharepoint: sharepointLists },
    auth: customerAuth.microsoft({
      tenantId: microsoftTenantId,
      clientId: microsoftClientId,
      clientSecret: secret('MICROSOFT_CLIENT_SECRET'),
      scopes: graphScopes,
      authMethod: 'client_secret_post',
      user: { id: 'sub', email: 'preferred_username' },
    }),
    instructions:
      'Use the sharepoint_* tools to discover SharePoint sites, inspect lists and columns, and create, query, update, or delete list rows through Microsoft Graph. Always call sharepoint_list_columns before writing unknown fields so internal column names and read-only columns are known.',
  },
  [
    tool('sharepoint_list_sites', {
      description:
        'Search visible SharePoint sites by name and return site ids for follow-up list discovery.',
      annotations: readAnnotations,
      input: z.object({
        search: z.string().describe('Site name or keywords, for example "Operations".'),
        size: z.number().int().min(1).max(25).optional().describe('Maximum sites to return.'),
      }),
      output: z.object({
        search: z.string(),
        sites: z.array(
          z.object({ siteId: z.string(), name: z.string(), webUrl: z.string().optional() }),
        ),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.searchSites({ query: input.search, size: input.size });
        const summary = connectors.sharepoint.summarize({ kind: 'sites', value: result.hits });
        return { search: input.search, sites: summary.result };
      },
    }),
    tool('sharepoint_list_lists', {
      description:
        'List SharePoint lists in a site and return list ids, display names, URLs, and templates.',
      annotations: readAnnotations,
      input: z.object({ siteId: z.string().describe('Microsoft Graph site id.') }),
      output: z.object({ siteId: z.string(), lists: z.array(listSchema) }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.listSiteLists({ siteId: input.siteId });
        const summary = connectors.sharepoint.summarize({ kind: 'lists', value: result.lists });
        return { siteId: input.siteId, lists: summary.result };
      },
    }),
    tool('sharepoint_get_list', {
      description: 'Get metadata for one SharePoint list by site id and list id.',
      annotations: readAnnotations,
      input: z.object({ siteId: z.string(), listId: z.string() }),
      output: z.object({ siteId: z.string(), listId: z.string(), list: listSchema }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.getSiteList({
          siteId: input.siteId,
          listId: input.listId,
        });
        const summary = connectors.sharepoint.summarize({ kind: 'list', value: result.list });
        return { siteId: input.siteId, listId: input.listId, list: summary.result };
      },
    }),
    tool('sharepoint_list_columns', {
      description:
        'Inspect a SharePoint list schema. Use this before add/update item calls to find internal column names, types, and read-only fields.',
      annotations: readAnnotations,
      input: z.object({ siteId: z.string(), listId: z.string() }),
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
        const summary = connectors.sharepoint.summarize({ kind: 'columns', value: result.columns });
        return { siteId: input.siteId, listId: input.listId, columns: summary.result };
      },
    }),
    tool('sharepoint_create_list', {
      description:
        'Create a new SharePoint list in a site. The default template is genericList and includes the built-in Title column.',
      annotations: writeAnnotations,
      input: z.object({
        siteId: z.string(),
        displayName: z.string(),
        description: z.string().optional(),
        template: z
          .string()
          .optional()
          .describe('Microsoft Graph list template. Defaults to genericList.'),
        columns: z
          .array(z.union([z.string(), columnDefinitionInput]))
          .optional()
          .describe(
            'Optional columns. Strings become text columns; objects are Graph columnDefinitions.',
          ),
      }),
      output: z.object({ siteId: z.string(), listId: z.string(), list: listSchema }),
      fulfil({ input, connectors }) {
        const normalized = connectors.sharepoint.normalizeCreateListColumns({
          kind: 'create_list_columns',
          columns: input.columns,
        });
        const result = connectors.graph.createSiteList({
          siteId: input.siteId,
          displayName: input.displayName,
          description: input.description,
          template: input.template,
          columns: normalized.result.columns,
        });
        const summary = connectors.sharepoint.summarize({ kind: 'list', value: result.list });
        return { siteId: input.siteId, listId: summary.result.listId, list: summary.result };
      },
    }),
    tool('sharepoint_add_list_column', {
      description:
        'Add a column to an existing SharePoint list using a Microsoft Graph columnDefinition object.',
      annotations: writeAnnotations,
      input: z.object({ siteId: z.string(), listId: z.string(), column: columnDefinitionInput }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        columnId: z.string(),
        column: listColumnSchema,
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.createListColumn({
          siteId: input.siteId,
          listId: input.listId,
          column: input.column,
        });
        const summary = connectors.sharepoint.summarize({ kind: 'column', value: result.column });
        return {
          siteId: input.siteId,
          listId: input.listId,
          columnId: summary.result.columnId,
          column: summary.result,
        };
      },
    }),
    tool('sharepoint_update_list_column', {
      description:
        'Patch editable metadata for a list column. Do not use this for read-only or sealed columns.',
      annotations: writeAnnotations,
      input: z.object({
        siteId: z.string(),
        listId: z.string(),
        columnId: z.string(),
        patch: columnDefinitionInput,
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        columnId: z.string(),
        column: listColumnSchema,
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.updateListColumn({
          siteId: input.siteId,
          listId: input.listId,
          columnId: input.columnId,
          patch: input.patch,
        });
        const summary = connectors.sharepoint.summarize({ kind: 'column', value: result.column });
        return {
          siteId: input.siteId,
          listId: input.listId,
          columnId: input.columnId,
          column: summary.result,
        };
      },
    }),
    tool('sharepoint_delete_list_column', {
      description:
        'Delete a custom SharePoint list column. Call sharepoint_list_columns first and avoid built-in, read-only, or required columns.',
      annotations: deleteAnnotations,
      input: z.object({ siteId: z.string(), listId: z.string(), columnId: z.string() }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        columnId: z.string(),
        deleted: z.literal(true),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.deleteListColumn({
          siteId: input.siteId,
          listId: input.listId,
          columnId: input.columnId,
        });
        return {
          siteId: result.siteId,
          listId: result.listId,
          columnId: result.columnId,
          deleted: result.deleted,
        };
      },
    }),
    tool('sharepoint_list_items', {
      description:
        'List SharePoint list rows with expanded fields. Use skipToken from a previous response to continue.',
      annotations: readAnnotations,
      input: z.object({
        siteId: z.string(),
        listId: z.string(),
        skipToken: z
          .string()
          .optional()
          .describe('Continuation token returned by a previous response.'),
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
    tool('sharepoint_get_list_item', {
      description: 'Get one SharePoint list row by id with expanded field values.',
      annotations: readAnnotations,
      input: z.object({ siteId: z.string(), listId: z.string(), itemId: z.string() }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        item: listItemSchema,
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.getListItem({
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
        });
        const summary = connectors.sharepoint.summarize({ kind: 'list_item', value: result.item });
        return {
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
          item: summary.result,
        };
      },
    }),
    tool('sharepoint_query_list', {
      description:
        "Query list rows with a Microsoft Graph OData $filter expression, for example: fields/Title eq 'Launch task'.",
      annotations: readAnnotations,
      input: z.object({
        siteId: z.string(),
        listId: z.string(),
        filter: z.string(),
        skipToken: z.string().optional(),
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
        'Add a row to a SharePoint list using internal column names. Call sharepoint_list_columns first when unsure.',
      annotations: writeAnnotations,
      input: z.object({ siteId: z.string(), listId: z.string(), fields: fieldValuesInput }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        item: listItemSchema,
        columns: z.record(z.string(), z.unknown()),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.createListItem({
          siteId: input.siteId,
          listId: input.listId,
          fields: input.fields,
        });
        const summary = connectors.sharepoint.summarize({ kind: 'list_item', value: result.item });
        return {
          siteId: input.siteId,
          listId: input.listId,
          itemId: summary.result.itemId,
          item: summary.result,
          columns: summary.result.columns,
        };
      },
    }),
    tool('sharepoint_update_list_item', {
      description:
        'Update field values on an existing SharePoint list row. The fields object must use internal column names.',
      annotations: writeAnnotations,
      input: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        fields: fieldValuesInput,
      }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        columns: z.record(z.string(), z.unknown()),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.updateListItem({
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
          fields: input.fields,
        });
        return {
          siteId: input.siteId,
          listId: input.listId,
          itemId: result.itemId,
          columns: result.columns,
        };
      },
    }),
    tool('sharepoint_delete_list_item', {
      description:
        'Delete one SharePoint list row by item id. Use only after confirming the target row with sharepoint_get_list_item.',
      annotations: deleteAnnotations,
      input: z.object({ siteId: z.string(), listId: z.string(), itemId: z.string() }),
      output: z.object({
        siteId: z.string(),
        listId: z.string(),
        itemId: z.string(),
        deleted: z.literal(true),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.deleteListItem({
          siteId: input.siteId,
          listId: input.listId,
          itemId: input.itemId,
        });
        return {
          siteId: result.siteId,
          listId: result.listId,
          itemId: result.itemId,
          deleted: result.deleted,
        };
      },
    }),
    resource('whoami', {
      uri: 'sharepoint-lists://whoami',
      title: 'Signed-in Microsoft user',
      description: 'Microsoft Graph /me profile for the signed-in user.',
      mimeType: 'application/json',
      fulfil({ connectors }) {
        return { profile: connectors.graph.getMe() };
      },
    }),
    prompt('manage_sharepoint_list', {
      title: 'Manage a SharePoint list',
      description:
        'Guide an MCP client through discovering a list, inspecting schema, and safely changing rows.',
      arguments: [
        { name: 'site_search', required: true },
        { name: 'list_name', required: false },
      ],
      fulfil({ input }) {
        return [
          {
            role: 'user',
            text: `Find the SharePoint site matching "${input.site_search}", list available lists, select the list matching "${input.list_name ?? 'the user request'}", inspect columns, then use internal column names for any row create, update, query, or delete. Before destructive delete calls, first show the row from sharepoint_get_list_item and ask for confirmation.`,
          },
        ];
      },
    }),
  ],
);
