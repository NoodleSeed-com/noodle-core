import { connector, secret, variable, z } from '@noodleseed/one';

export const microsoftTenantId = variable('MICROSOFT_TENANT_ID');
export const microsoftClientId = variable('MICROSOFT_CLIENT_ID');
const microsoftTokenUrl = `https://login.microsoftonline.com/${microsoftTenantId}/oauth2/v2.0/token`;

export const graphScopes = [
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Sites.Read.All',
  'https://graph.microsoft.com/Sites.ReadWrite.All',
  'https://graph.microsoft.com/Sites.Manage.All',
] as const;

export const graph = connector('sharepoint_lists_graph')
  .version('1.0.0')
  .http({
    baseUrl: 'https://graph.microsoft.com/v1.0',
    allowedOrigins: ['https://graph.microsoft.com', 'https://login.microsoftonline.com'],
    auth: {
      kind: 'delegatedOAuth',
      provider: 'microsoft',
      tokenUrl: microsoftTokenUrl,
      clientId: microsoftClientId,
      clientSecret: secret('MICROSOFT_CLIENT_SECRET'),
      scopes: graphScopes,
      authMethod: 'client_secret_post',
    },
    operations: {
      get_me: {
        type: 'read',
        method: 'GET',
        path: '/me',
        output: z.object({
          id: z.string().optional(),
          displayName: z.string().optional(),
          mail: z.string().optional(),
          userPrincipalName: z.string().optional(),
        }),
        response: {
          id: '${response.id}',
          displayName: '${response.displayName ?? ""}',
          mail: '${response.mail ?? response.userPrincipalName ?? ""}',
          userPrincipalName: '${response.userPrincipalName ?? ""}',
        },
      },
      search_sites: {
        type: 'read',
        method: 'POST',
        path: '/search/query',
        input: z.object({ query: z.string(), size: z.number().optional() }),
        output: z.object({ hits: z.unknown().optional() }),
        request: {
          requests: [
            {
              entityTypes: ['site'],
              query: { queryString: '${args.query}' },
              size: '${args.size ?? 10}',
            },
          ],
        },
        response: { hits: '${response.value[0].hitsContainers[0].hits}' },
      },
      list_site_lists: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists?$select=id,name,displayName,webUrl,createdDateTime,lastModifiedDateTime,list',
        input: z.object({ siteId: z.string() }),
        output: z.object({ lists: z.unknown().optional() }),
        response: { lists: '${response.value}' },
      },
      get_site_list: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists/{listId}?$select=id,name,displayName,webUrl,createdDateTime,lastModifiedDateTime,list',
        input: z.object({ siteId: z.string(), listId: z.string() }),
        output: z.object({ list: z.unknown().optional() }),
        response: { list: '${response}' },
      },
      list_list_columns: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists/{listId}/columns?$select=id,name,displayName,description,hidden,indexed,readOnly,required,text,number,choice,boolean,dateTime,currency,lookup,personOrGroup',
        input: z.object({ siteId: z.string(), listId: z.string() }),
        output: z.object({ columns: z.unknown().optional() }),
        response: { columns: '${response.value}' },
      },
      create_site_list: {
        type: 'action',
        method: 'POST',
        path: '/sites/{siteId}/lists',
        input: z.object({
          siteId: z.string(),
          displayName: z.string(),
          description: z.string().optional(),
          template: z.string().optional(),
          columns: z.array(z.unknown()).optional(),
        }),
        output: z.object({ list: z.unknown() }),
        request: {
          displayName: '${args.displayName}',
          description: '${args.description ?? ""}',
          columns: '${args.columns}',
          list: { template: '${args.template ?? "genericList"}' },
        },
        response: { list: '${response}' },
      },
      create_list_column: {
        type: 'action',
        method: 'POST',
        path: '/sites/{siteId}/lists/{listId}/columns',
        input: z.object({
          siteId: z.string(),
          listId: z.string(),
          column: z.record(z.string(), z.unknown()),
        }),
        output: z.object({ column: z.unknown() }),
        request: '${args.column}',
        response: { column: '${response}' },
      },
      update_list_column: {
        type: 'action',
        method: 'PATCH',
        path: '/sites/{siteId}/lists/{listId}/columns/{columnId}',
        input: z.object({
          siteId: z.string(),
          listId: z.string(),
          columnId: z.string(),
          patch: z.record(z.string(), z.unknown()),
        }),
        output: z.object({ column: z.unknown() }),
        request: '${args.patch}',
        response: { column: '${response}' },
      },
      delete_list_column: {
        type: 'action',
        method: 'DELETE',
        path: '/sites/{siteId}/lists/{listId}/columns/{columnId}',
        responseType: 'text',
        input: z.object({ siteId: z.string(), listId: z.string(), columnId: z.string() }),
        output: z.object({
          siteId: z.string(),
          listId: z.string(),
          columnId: z.string(),
          deleted: z.boolean(),
        }),
        response: {
          siteId: '${args.siteId}',
          listId: '${args.listId}',
          columnId: '${args.columnId}',
          deleted: true,
        },
      },
      list_list_items: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists/{listId}/items?$expand=fields&$top=200',
        query: ['$skiptoken'],
        input: z.object({
          siteId: z.string(),
          listId: z.string(),
          $skiptoken: z.string().optional(),
        }),
        output: z.object({ page: z.unknown().optional() }),
        response: { page: '${response}' },
      },
      get_list_item: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists/{listId}/items/{itemId}?$expand=fields',
        input: z.object({ siteId: z.string(), listId: z.string(), itemId: z.string() }),
        output: z.object({ item: z.unknown().optional() }),
        response: { item: '${response}' },
      },
      query_list_items: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists/{listId}/items?$expand=fields&$top=200&$filter={filter}',
        query: ['$skiptoken'],
        input: z.object({
          siteId: z.string(),
          listId: z.string(),
          filter: z.string(),
          $skiptoken: z.string().optional(),
        }),
        output: z.object({ page: z.unknown().optional() }),
        response: { page: '${response}' },
      },
      create_list_item: {
        type: 'action',
        method: 'POST',
        path: '/sites/{siteId}/lists/{listId}/items',
        input: z.object({
          siteId: z.string(),
          listId: z.string(),
          fields: z.record(z.string(), z.unknown()),
        }),
        output: z.object({ item: z.unknown() }),
        request: { fields: '${args.fields}' },
        response: { item: '${response}' },
      },
      update_list_item: {
        type: 'action',
        method: 'PATCH',
        path: '/sites/{siteId}/lists/{listId}/items/{itemId}/fields',
        input: z.object({
          siteId: z.string(),
          listId: z.string(),
          itemId: z.string(),
          fields: z.record(z.string(), z.unknown()),
        }),
        output: z.object({ itemId: z.string(), columns: z.record(z.string(), z.unknown()) }),
        request: '${args.fields}',
        response: {
          itemId: '${args.itemId}',
          columns: '${response}',
        },
      },
      delete_list_item: {
        type: 'action',
        method: 'DELETE',
        path: '/sites/{siteId}/lists/{listId}/items/{itemId}',
        responseType: 'text',
        input: z.object({ siteId: z.string(), listId: z.string(), itemId: z.string() }),
        output: z.object({
          siteId: z.string(),
          listId: z.string(),
          itemId: z.string(),
          deleted: z.boolean(),
        }),
        response: {
          siteId: '${args.siteId}',
          listId: '${args.listId}',
          itemId: '${args.itemId}',
          deleted: true,
        },
      },
    },
  });
