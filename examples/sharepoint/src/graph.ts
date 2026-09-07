import { connector, secret, variable, z } from '@noodleseed/one';

export const microsoftTenantId = variable('MICROSOFT_TENANT_ID');
export const microsoftClientId = variable('MICROSOFT_CLIENT_ID');
const microsoftTokenUrl = `https://login.microsoftonline.com/${microsoftTenantId}/oauth2/v2.0/token`;

export const graphScopes = [
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Sites.Read.All',
  'https://graph.microsoft.com/Sites.ReadWrite.All',
  'https://graph.microsoft.com/Sites.Manage.All',
  'https://graph.microsoft.com/Files.ReadWrite.All',
] as const;

export const graph = connector('sharepoint_graph')
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
      list_recent_files: {
        type: 'read',
        method: 'GET',
        path: '/me/drive/recent?$top=25&$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,remoteItem,parentReference,@microsoft.graph.downloadUrl',
        output: z.object({ items: z.unknown().optional() }),
        response: { items: '${response.value}' },
      },
      search_all: {
        type: 'read',
        method: 'POST',
        path: '/search/query',
        input: z.object({ query: z.string(), size: z.number().optional() }),
        output: z.object({ hits: z.unknown().optional() }),
        request: {
          requests: [
            {
              entityTypes: ['driveItem', 'listItem', 'site'],
              query: { queryString: '${args.query}' },
              size: '${args.size ?? 10}',
            },
          ],
        },
        response: {
          hits: '${response.value[0].hitsContainers[0].hits}',
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
        response: {
          hits: '${response.value[0].hitsContainers[0].hits}',
        },
      },
      list_site_drive_root: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/drive/root/children?$top=200&$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl',
        query: ['$skiptoken'],
        input: z.object({ siteId: z.string(), $skiptoken: z.string().optional() }),
        output: z.object({ page: z.unknown().optional() }),
        response: { page: '${response}' },
      },
      list_site_drive_children: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/drive/items/{itemId}/children?$top=200&$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl',
        query: ['$skiptoken'],
        input: z.object({
          siteId: z.string(),
          itemId: z.string(),
          $skiptoken: z.string().optional(),
        }),
        output: z.object({ page: z.unknown().optional() }),
        response: { page: '${response}' },
      },
      list_site_drives: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/drives?$select=id,name,webUrl,driveType',
        input: z.object({ siteId: z.string() }),
        output: z.object({ drives: z.unknown().optional() }),
        response: { drives: '${response.value}' },
      },
      list_drive_root: {
        type: 'read',
        method: 'GET',
        path: '/drives/{driveId}/root/children?$top=200&$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl',
        query: ['$skiptoken'],
        input: z.object({ driveId: z.string(), $skiptoken: z.string().optional() }),
        output: z.object({ page: z.unknown().optional() }),
        response: { page: '${response}' },
      },
      list_drive_children: {
        type: 'read',
        method: 'GET',
        path: '/drives/{driveId}/items/{itemId}/children?$top=200&$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl',
        query: ['$skiptoken'],
        input: z.object({
          driveId: z.string(),
          itemId: z.string(),
          $skiptoken: z.string().optional(),
        }),
        output: z.object({ page: z.unknown().optional() }),
        response: { page: '${response}' },
      },
      get_drive_item_metadata: {
        type: 'read',
        method: 'GET',
        path: '/drives/{driveId}/items/{itemId}?$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl',
        input: z.object({ driveId: z.string(), itemId: z.string() }),
        output: z.object({ item: z.unknown().optional() }),
        response: { item: '${response}' },
      },
      get_drive_item_content: {
        type: 'read',
        method: 'GET',
        path: '/drives/{driveId}/items/{itemId}/content',
        responseType: 'text',
        input: z.object({ driveId: z.string(), itemId: z.string() }),
        output: z.object({ content: z.string() }),
        response: { content: '${response}' },
      },
      list_site_lists: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists?$select=id,name,displayName,webUrl,list',
        input: z.object({ siteId: z.string() }),
        output: z.object({ lists: z.unknown().optional() }),
        response: { lists: '${response.value}' },
      },
      list_list_columns: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists/{listId}/columns?$select=id,name,displayName,hidden,readOnly,required,boolean,choice,dateTime,number,text',
        input: z.object({ siteId: z.string(), listId: z.string() }),
        output: z.object({ columns: z.unknown().optional() }),
        response: { columns: '${response.value}' },
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
      get_list_item: {
        type: 'read',
        method: 'GET',
        path: '/sites/{siteId}/lists/{listId}/items/{itemId}?$expand=fields',
        input: z.object({ siteId: z.string(), listId: z.string(), itemId: z.string() }),
        output: z.object({ item: z.unknown().optional() }),
        response: { item: '${response}' },
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
        output: z.object({
          listId: z.string(),
          name: z.string().optional(),
          displayName: z.string().optional(),
          webUrl: z.string().optional(),
          template: z.string().optional(),
        }),
        request: {
          displayName: '${args.displayName}',
          description: '${args.description ?? ""}',
          columns: '${args.columns}',
          list: { template: '${args.template ?? "genericList"}' },
        },
        response: {
          listId: '${response.id}',
          name: '${response.name ?? response.displayName ?? ""}',
          displayName: '${response.displayName ?? response.name ?? ""}',
          webUrl: '${response.webUrl ?? ""}',
          template: '${response.list.template ?? ""}',
        },
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
        output: z.object({
          itemId: z.string(),
          webUrl: z.string().optional(),
          createdDateTime: z.string().optional(),
          lastModifiedDateTime: z.string().optional(),
          columns: z.record(z.string(), z.unknown()),
        }),
        request: {
          fields: '${args.fields}',
        },
        response: {
          itemId: '${response.id}',
          webUrl: '${response.webUrl ?? ""}',
          createdDateTime: '${response.createdDateTime ?? ""}',
          lastModifiedDateTime: '${response.lastModifiedDateTime ?? ""}',
          columns: '${response.fields ?? args.fields}',
        },
      },
      update_list_item_fields: {
        type: 'action',
        method: 'PATCH',
        path: '/sites/{siteId}/lists/{listId}/items/{itemId}/fields',
        input: z.object({
          siteId: z.string(),
          listId: z.string(),
          itemId: z.string(),
          fields: z.record(z.string(), z.unknown()),
        }),
        output: z.object({ columns: z.record(z.string(), z.unknown()) }),
        request: {
          '${spread}': '${args.fields}',
        },
        response: {
          columns: '${response}',
        },
      },
      delete_list_item: {
        type: 'action',
        method: 'DELETE',
        path: '/sites/{siteId}/lists/{listId}/items/{itemId}',
        responseType: 'empty',
        input: z.object({ siteId: z.string(), listId: z.string(), itemId: z.string() }),
        output: z.object({ deleted: z.boolean() }),
        response: { deleted: true },
      },
      create_upload_session: {
        type: 'action',
        method: 'POST',
        path: '/drives/{driveId}/items/{parentItemId}:/{fileName}:/createUploadSession',
        input: z.object({
          driveId: z.string(),
          parentItemId: z.string(),
          fileName: z.string(),
          conflictBehavior: z.string(),
        }),
        output: z.object({
          uploadUrl: z.string().optional(),
          expirationDateTime: z.string().optional(),
        }),
        request: {
          item: {
            '@microsoft.graph.conflictBehavior': '${args.conflictBehavior}',
            name: '${args.fileName}',
          },
        },
        response: {
          uploadUrl: '${response.uploadUrl}',
          expirationDateTime: '${response.expirationDateTime}',
        },
      },
    },
  });
