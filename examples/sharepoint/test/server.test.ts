import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import app from '../src/server.js';
import {
  summarizeSharePointDriveItems,
  summarizeSharePointDrives,
  summarizeSharePointFileMetadata,
  summarizeSharePointListItems,
  summarizeSharePointLists,
  summarizeSharePointSearchHits,
  summarizeSharePointSites,
} from '../src/summaries.js';

/** Canonical closed object schema (ADR 0139) — compact form for signature assertions. */
function objSchema(
  properties: Record<string, unknown>,
  required?: readonly string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  };
}

type ComputeRun = (
  input: Record<string, unknown>,
  host?: {
    readonly callOperation?: (name: string, args: Readonly<Record<string, unknown>>) => unknown;
  },
) => { result: unknown };

function serializedComputeRun(code: unknown): ComputeRun {
  expect(typeof code).toBe('string');
  if (typeof code !== 'string') throw new Error('expected serialized compute code');
  return runInNewContext(`(${code})`) as ComputeRun;
}

describe('SharePoint Google demo MCP server', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
    expect(typeof app.toConnectorCatalog).toBe('function');
  });

  it('declares the issue #131 tool, resource, and prompt surface', async () => {
    const manifest = await app.toManifest();

    expect(manifest.server).toMatchObject({
      name: 'sharepoint_microsoft_graph',
      title: 'SharePoint Microsoft Graph',
      auth: {
        kind: 'bridge',
        provider: 'microsoft',
        tenantId: '${env.MICROSOFT_TENANT_ID}',
        clientId: '${env.MICROSOFT_CLIENT_ID}',
        clientSecret: 'MICROSOFT_CLIENT_SECRET',
        scopes: [
          'https://graph.microsoft.com/User.Read',
          'https://graph.microsoft.com/Sites.Read.All',
          'https://graph.microsoft.com/Sites.ReadWrite.All',
          'https://graph.microsoft.com/Sites.Manage.All',
          'https://graph.microsoft.com/Files.ReadWrite.All',
        ],
        authMethod: 'client_secret_post',
        user: { id: 'sub', email: 'preferred_username' },
      },
    });
    expect(manifest.connectors).toEqual({
      graph: { id: 'sharepoint_graph', version: '1.0.0' },
      sharepoint: { id: 'sharepoint_summary', version: '1.0.0' },
      lists: { id: 'sharepoint_list_helpers', version: '1.0.0' },
    });
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      'sharepoint_search',
      'sharepoint_read_file',
      'sharepoint_read_file_content',
      'sharepoint_list_items',
      'sharepoint_list_sites',
      'sharepoint_list_drives',
      'sharepoint_list_site_lists',
      'sharepoint_list_list_columns',
      'sharepoint_create_list',
      'sharepoint_list_list_items',
      'sharepoint_query_list',
      'sharepoint_add_list_item',
      'sharepoint_get_list_item',
      'sharepoint_update_list_item',
      'sharepoint_delete_list_item',
      'sharepoint_get_metadata',
      'sharepoint_upload_file',
    ]);
    expect(manifest.resources?.map((resource) => resource.name)).toEqual([
      'recent_files',
      'whoami',
    ]);
    expect(manifest.prompts?.map((prompt) => prompt.name)).toEqual(['summarize_document']);

    const readToolNames = manifest.tools
      .map((tool) => tool.name)
      .filter(
        (name) =>
          ![
            'sharepoint_create_list',
            'sharepoint_add_list_item',
            'sharepoint_update_list_item',
            'sharepoint_delete_list_item',
            'sharepoint_upload_file',
          ].includes(name),
      );
    for (const name of readToolNames) {
      expect(manifest.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
    }
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_upload_file')?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_create_list')?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_add_list_item')?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_update_list_item')?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_delete_list_item')?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });

    expect(manifest.resources?.find((resource) => resource.name === 'recent_files')).toMatchObject({
      uri: 'sharepoint://recent_files',
      mimeType: 'application/json',
    });
    expect(manifest.resources?.find((resource) => resource.name === 'whoami')).toMatchObject({
      uri: 'sharepoint://whoami',
      mimeType: 'application/json',
    });
    expect(manifest.prompts?.find((prompt) => prompt.name === 'summarize_document')).toMatchObject({
      arguments: [
        { name: 'query', required: true },
        { name: 'site_id', required: false },
      ],
    });

    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_search')?.inputSchema,
    ).toMatchObject({
      required: ['query'],
      properties: {
        size: {
          description: 'Maximum results per requested entity type. Defaults to 10.',
        },
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_search')?.inputSchema.properties,
    ).not.toHaveProperty('entityTypes');
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_search')?.fulfilment.steps?.[0],
    ).toMatchObject({
      use: 'graph.search_all',
      args: { query: '${input.query}', size: '${input.size}' },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_search')?.fulfilment.steps?.[0]?.args,
    ).not.toHaveProperty('entityTypes');
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_read_file_content'),
    ).toMatchObject({
      inputSchema: {
        required: ['driveId', 'itemId'],
      },
      outputSchema: {
        properties: {
          readStatus: {
            enum: [
              'read',
              'unsupported_binary',
              'too_large',
              'metadata_unavailable',
              'content_unavailable',
            ],
          },
        },
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_read_file_content')?.fulfilment
        .steps?.[0],
    ).toMatchObject({
      id: 'read_file_content',
      use: 'sharepoint.read_file_content',
      args: {
        driveId: '${input.driveId}',
        itemId: '${input.itemId}',
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_list_sites')?.inputSchema,
    ).toMatchObject({
      required: ['search'],
      properties: {
        size: {
          description: 'Maximum number of sites to return. Defaults to 10.',
        },
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_list_sites')?.fulfilment.steps?.[0],
    ).toMatchObject({
      use: 'graph.search_sites',
      args: { query: '${input.search}', size: '${input.size}' },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_list_drives')?.inputSchema,
    ).toMatchObject({
      required: ['siteId'],
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_list_drives')?.fulfilment.steps,
    ).toMatchObject([
      {
        id: 'list_site_drives',
        use: 'graph.list_site_drives',
        args: { siteId: '${input.siteId}' },
      },
      {
        id: 'summarize',
        use: 'sharepoint.summarize',
        args: { kind: 'drives', value: '${steps.list_site_drives.drives}' },
      },
    ]);
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_create_list')?.inputSchema,
    ).toMatchObject({
      required: ['siteId', 'displayName'],
      properties: {
        template: {
          description: 'Microsoft Graph list template. Defaults to genericList.',
        },
        columns: {
          description: expect.stringContaining('Optional list columns'),
        },
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_create_list')?.fulfilment.steps,
    ).toMatchObject([
      {
        id: 'normalize_create_list_columns',
        use: 'lists.normalize_create_list_columns',
        args: {
          kind: 'create_list_columns',
          columns: '${input.columns}',
        },
      },
      {
        id: 'create_site_list',
        use: 'graph.create_site_list',
        args: {
          siteId: '${input.siteId}',
          displayName: '${input.displayName}',
          description: '${input.description}',
          template: '${input.template}',
          columns: '${steps.normalize_create_list_columns.result.columns}',
        },
      },
    ]);
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_list_items')?.inputSchema.properties,
    ).toMatchObject({
      skipToken: {
        description: 'Continuation token returned by a previous list response.',
      },
      nextLink: {
        description: 'Full nextLink returned by a previous list response; skipToken is preferred.',
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_list_items')?.fulfilment.steps?.[0],
    ).toMatchObject({
      use: 'sharepoint.list_items',
      args: {
        skipToken: '${input.skipToken}',
        nextLink: '${input.nextLink}',
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_query_list')?.inputSchema.properties,
    ).toMatchObject({
      skipToken: {
        description: 'Continuation token returned by a previous query response.',
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_query_list')?.fulfilment.steps?.[0],
    ).toMatchObject({
      use: 'graph.query_list_items',
      args: {
        $skiptoken: '${input.skipToken}',
      },
    });
    expect(manifest.tools.find((tool) => tool.name === 'sharepoint_upload_file')).toMatchObject({
      fulfilment: {
        steps: [
          {
            id: 'create_upload_session',
            use: 'graph.create_upload_session',
            args: {
              driveId: '${input.driveId}',
              parentItemId: '${input.parentItemId}',
              fileName: '${input.fileName}',
              conflictBehavior: '${input.conflictBehavior}',
            },
          },
        ],
        output: {
          uploadUrl: '${steps.create_upload_session.uploadUrl}',
          uploadMethod: 'PUT',
          authorizationHeader: 'omit',
        },
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_add_list_item')?.inputSchema,
    ).toMatchObject({
      required: ['siteId', 'listId', 'values'],
      properties: {
        values: {
          description: expect.stringContaining('display names or internal names'),
        },
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_add_list_item')?.fulfilment.steps,
    ).toMatchObject([
      {
        id: 'resolve_list_item_values',
        use: 'lists.resolve_list_item_values',
        args: {
          kind: 'list_item_values',
          siteId: '${input.siteId}',
          listId: '${input.listId}',
          values: '${input.values}',
        },
      },
      {
        id: 'create_list_item',
        use: 'graph.create_list_item',
        args: {
          siteId: '${input.siteId}',
          listId: '${input.listId}',
          fields: '${steps.resolve_list_item_values.result.fields}',
        },
      },
    ]);
  });

  it('declares Microsoft Graph operations for search, reads, lists, resources, and upload sessions', () => {
    const catalog = app.toConnectorCatalog();
    const graph = catalog?.connectors.find((connector) => connector.id === 'sharepoint_graph');

    expect(graph).toMatchObject({
      id: 'sharepoint_graph',
      version: '1.0.0',
      http: {
        baseUrl: 'https://graph.microsoft.com/v1.0',
        allowedOrigins: ['https://graph.microsoft.com', 'https://login.microsoftonline.com'],
        auth: {
          kind: 'delegatedOAuth',
          provider: 'microsoft',
          tokenUrl:
            'https://login.microsoftonline.com/${env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token',
          clientId: '${env.MICROSOFT_CLIENT_ID}',
          clientSecret: 'MICROSOFT_CLIENT_SECRET',
          scopes: [
            'https://graph.microsoft.com/User.Read',
            'https://graph.microsoft.com/Sites.Read.All',
            'https://graph.microsoft.com/Sites.ReadWrite.All',
            'https://graph.microsoft.com/Sites.Manage.All',
            'https://graph.microsoft.com/Files.ReadWrite.All',
          ],
          authMethod: 'client_secret_post',
        },
      },
    });
    expect(Object.keys(graph?.operations ?? {})).toEqual([
      'get_me',
      'list_recent_files',
      'search_all',
      'search_sites',
      'list_site_drive_root',
      'list_site_drive_children',
      'list_site_drives',
      'list_drive_root',
      'list_drive_children',
      'get_drive_item_metadata',
      'get_drive_item_content',
      'list_site_lists',
      'list_list_columns',
      'list_list_items',
      'query_list_items',
      'get_list_item',
      'create_site_list',
      'create_list_item',
      'update_list_item_fields',
      'delete_list_item',
      'create_upload_session',
    ]);
    expect(graph?.operations.search_all).toMatchObject({
      type: 'read',
      method: 'POST',
      path: '/search/query',
      input: objSchema({ query: { type: 'string' }, size: { type: 'number' } }, ['query']),
      output: { type: 'object', properties: { hits: {} }, additionalProperties: false },
      request: {
        requests: [
          {
            entityTypes: ['driveItem', 'listItem', 'site'],
            size: '${args.size ?? 10}',
          },
        ],
      },
    });
    expect(graph?.operations.search_sites).toMatchObject({
      type: 'read',
      method: 'POST',
      path: '/search/query',
      input: objSchema({ query: { type: 'string' }, size: { type: 'number' } }, ['query']),
      request: {
        requests: [
          {
            entityTypes: ['site'],
            size: '${args.size ?? 10}',
          },
        ],
      },
    });
    expect(graph?.operations.get_drive_item_metadata).toMatchObject({
      type: 'read',
      method: 'GET',
      path: '/drives/{driveId}/items/{itemId}?$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl',
    });
    expect(graph?.operations.get_drive_item_content).toMatchObject({
      type: 'read',
      method: 'GET',
      path: '/drives/{driveId}/items/{itemId}/content',
      responseType: 'text',
      input: objSchema({ driveId: { type: 'string' }, itemId: { type: 'string' } }, [
        'driveId',
        'itemId',
      ]),
      output: objSchema({ content: { type: 'string' } }, ['content']),
      response: { content: '${response}' },
    });
    expect(graph?.operations.list_drive_children).toMatchObject({
      type: 'read',
      query: ['$skiptoken'],
      input: objSchema(
        { driveId: { type: 'string' }, itemId: { type: 'string' }, $skiptoken: { type: 'string' } },
        ['driveId', 'itemId'],
      ),
    });
    expect(graph?.operations.list_site_drives).toMatchObject({
      type: 'read',
      method: 'GET',
      path: '/sites/{siteId}/drives?$select=id,name,webUrl,driveType',
      input: objSchema({ siteId: { type: 'string' } }, ['siteId']),
      output: { type: 'object', properties: { drives: {} }, additionalProperties: false },
      response: { drives: '${response.value}' },
    });
    expect(graph?.operations.list_list_items).toMatchObject({
      type: 'read',
      method: 'GET',
      path: '/sites/{siteId}/lists/{listId}/items?$expand=fields&$top=200',
      query: ['$skiptoken'],
      input: objSchema(
        { siteId: { type: 'string' }, listId: { type: 'string' }, $skiptoken: { type: 'string' } },
        ['siteId', 'listId'],
      ),
      response: { page: '${response}' },
    });
    expect(graph?.operations.query_list_items).toMatchObject({
      query: ['$skiptoken'],
      input: objSchema(
        {
          siteId: { type: 'string' },
          listId: { type: 'string' },
          filter: { type: 'string' },
          $skiptoken: { type: 'string' },
        },
        ['siteId', 'listId', 'filter'],
      ),
    });
    expect(graph?.operations.create_site_list).toMatchObject({
      type: 'action',
      method: 'POST',
      path: '/sites/{siteId}/lists',
      input: objSchema(
        {
          siteId: { type: 'string' },
          displayName: { type: 'string' },
          description: { type: 'string' },
          template: { type: 'string' },
          columns: { type: 'array' },
        },
        ['siteId', 'displayName'],
      ),
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
    });
    expect(graph?.operations.create_list_item).toMatchObject({
      type: 'action',
      method: 'POST',
      path: '/sites/{siteId}/lists/{listId}/items',
      input: objSchema(
        { siteId: { type: 'string' }, listId: { type: 'string' }, fields: { type: 'object' } },
        ['siteId', 'listId', 'fields'],
      ),
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
    });
    expect(graph?.operations.create_upload_session).toMatchObject({
      type: 'action',
      method: 'POST',
      path: '/drives/{driveId}/items/{parentItemId}:/{fileName}:/createUploadSession',
      input: objSchema(
        {
          driveId: { type: 'string' },
          parentItemId: { type: 'string' },
          fileName: { type: 'string' },
          conflictBehavior: { type: 'string' },
        },
        ['driveId', 'parentItemId', 'fileName', 'conflictBehavior'],
      ),
      output: objSchema({ uploadUrl: { type: 'string' }, expirationDateTime: { type: 'string' } }),
      response: {
        uploadUrl: '${response.uploadUrl}',
        expirationDateTime: '${response.expirationDateTime}',
      },
    });
  });

  it('declares a compute connector for response normalization and mixed list browsing', () => {
    const catalog = app.toConnectorCatalog();
    const summary = catalog?.connectors.find((connector) => connector.id === 'sharepoint_summary');
    const helpers = catalog?.connectors.find(
      (connector) => connector.id === 'sharepoint_list_helpers',
    );

    expect(summary).toMatchObject({
      id: 'sharepoint_summary',
      version: '1.0.0',
      kind: 'custom',
      operations: {
        summarize: {
          type: 'read',
          input: objSchema({ kind: { type: 'string' }, value: {} }, ['kind', 'value']),
          output: objSchema({ result: {} }, ['result']),
        },
        list_items: {
          type: 'read',
          input: objSchema({ nextLink: { type: 'string' }, skipToken: { type: 'string' } }),
          output: objSchema({ result: { type: 'object' } }, ['result']),
          calls: {
            list_site_drive_root: 'sharepoint_graph.list_site_drive_root',
            list_site_drive_children: 'sharepoint_graph.list_site_drive_children',
            list_drive_root: 'sharepoint_graph.list_drive_root',
            list_drive_children: 'sharepoint_graph.list_drive_children',
            list_list_items: 'sharepoint_graph.list_list_items',
          },
        },
        read_file_content: {
          type: 'read',
          input: objSchema({ driveId: { type: 'string' }, itemId: { type: 'string' } }, [
            'driveId',
            'itemId',
          ]),
          output: objSchema({ result: { type: 'object' } }, ['result']),
          calls: {
            get_drive_item_metadata: 'sharepoint_graph.get_drive_item_metadata',
            get_drive_item_content: 'sharepoint_graph.get_drive_item_content',
          },
        },
      },
    });
    expect(helpers).toMatchObject({
      id: 'sharepoint_list_helpers',
      version: '1.0.0',
      kind: 'custom',
      operations: {
        summarize_columns: {
          type: 'read',
          input: objSchema({ kind: { type: 'string' }, columns: {} }, ['kind', 'columns']),
          output: objSchema({ result: { type: 'array' } }, ['result']),
        },
        normalize_create_list_columns: {
          type: 'read',
          input: objSchema({ kind: { type: 'string' }, columns: { type: 'array' } }, ['kind']),
          output: objSchema({ result: { type: 'object' } }, ['result']),
        },
        resolve_list_item_values: {
          type: 'read',
          input: objSchema(
            {
              kind: { type: 'string' },
              siteId: { type: 'string' },
              listId: { type: 'string' },
              values: { type: 'object' },
            },
            ['kind', 'siteId', 'listId', 'values'],
          ),
          output: objSchema({ result: { type: 'object' } }, ['result']),
          calls: {
            list_list_columns: 'sharepoint_graph.list_list_columns',
          },
        },
      },
    });
    expect(summary?.operations.summarize.code).toContain('search_hits');
    expect(summary?.operations.list_items.code).toContain('list_items');
    expect(summary?.operations.list_items.code).toContain('$skiptoken');
    expect(summary?.operations.summarize.code).toBe(summary?.operations.list_items.code);
    expect(summary?.operations.read_file_content.code).toBe(summary?.operations.list_items.code);
    expect(helpers?.operations.summarize_columns.code).toBe(
      helpers?.operations.normalize_create_list_columns.code,
    );
    expect(helpers?.operations.resolve_list_item_values.code).toBe(
      helpers?.operations.normalize_create_list_columns.code,
    );
  });

  it('runs the shared serialized compute code for summaries and paged list items', () => {
    const catalog = app.toConnectorCatalog();
    const summary = catalog?.connectors.find((connector) => connector.id === 'sharepoint_summary');
    const helpers = catalog?.connectors.find(
      (connector) => connector.id === 'sharepoint_list_helpers',
    );
    const summarize = serializedComputeRun(summary?.operations.summarize.code);
    const listItems = serializedComputeRun(summary?.operations.list_items.code);
    const readFileContent = serializedComputeRun(summary?.operations.read_file_content.code);
    const normalizeCreateListColumns = serializedComputeRun(
      helpers?.operations.normalize_create_list_columns.code,
    );

    expect(
      summarize({
        kind: 'drive_items',
        value: [
          {
            id: 'item-1',
            name: 'Profile.png',
            webUrl: 'https://contoso.sharepoint.com/sites/demo/Profile.png',
            parentReference: { driveId: 'drive-1', siteId: 'site-1', id: 'folder-1' },
            file: { mimeType: 'image/png' },
          },
        ],
      }).result,
    ).toEqual([
      {
        siteId: 'site-1',
        driveId: 'drive-1',
        parentItemId: 'folder-1',
        itemId: 'item-1',
        name: 'Profile.png',
        webUrl: 'https://contoso.sharepoint.com/sites/demo/Profile.png',
        downloadUrl: 'https://contoso.sharepoint.com/sites/demo/Profile.png?download=1',
        mimeType: 'image/png',
        itemType: 'file',
      },
    ]);

    expect(
      summarize({
        kind: 'drives',
        value: [
          {
            id: 'drive-1',
            name: 'Documents',
            webUrl: 'https://contoso.sharepoint.com/sites/demo/Shared%20Documents',
            driveType: 'documentLibrary',
          },
        ],
      }).result,
    ).toEqual([
      {
        driveId: 'drive-1',
        name: 'Documents',
        webUrl: 'https://contoso.sharepoint.com/sites/demo/Shared%20Documents',
        driveType: 'documentLibrary',
      },
    ]);

    expect(
      listItems(
        {
          mode: 'list',
          siteId: 'site-1',
          listId: 'list-1',
          nextLink:
            'https://graph.microsoft.com/v1.0/sites/site-1/lists/list-1/items?$skiptoken=abc%20123',
        },
        {
          callOperation(name, args) {
            expect(name).toBe('list_list_items');
            expect(args).toMatchObject({
              siteId: 'site-1',
              listId: 'list-1',
              $skiptoken: 'abc 123',
            });
            return {
              page: {
                '@odata.nextLink':
                  'https://graph.microsoft.com/v1.0/sites/site-1/lists/list-1/items?$skiptoken=next%20456',
                value: [
                  {
                    id: '7',
                    webUrl: 'https://contoso.sharepoint.com/sites/demo/Lists/Tasks/7_.000',
                    createdDateTime: '2026-07-01T00:00:00Z',
                    lastModifiedDateTime: '2026-07-02T00:00:00Z',
                    sharepointIds: { siteId: 'site-1', listId: 'list-1' },
                    fields: { Title: 'Launch demo', '@odata.etag': '"etag"' },
                  },
                ],
              },
            };
          },
        },
      ).result,
    ).toEqual({
      mode: 'list',
      siteId: 'site-1',
      listId: 'list-1',
      items: [
        {
          siteId: 'site-1',
          listId: 'list-1',
          itemId: '7',
          name: 'Launch demo',
          webUrl: 'https://contoso.sharepoint.com/sites/demo/Lists/Tasks/7_.000',
          createdDateTime: '2026-07-01T00:00:00Z',
          lastModifiedDateTime: '2026-07-02T00:00:00Z',
          columns: { Title: 'Launch demo' },
        },
      ],
      nextLink:
        'https://graph.microsoft.com/v1.0/sites/site-1/lists/list-1/items?$skiptoken=next%20456',
      skipToken: 'next 456',
    });

    expect(
      normalizeCreateListColumns({
        kind: 'create_list_columns',
        columns: [
          'Name',
          'Department',
          'Age',
          { name: 'StartDate', dateTime: { displayAs: 'default' } },
        ],
      }).result,
    ).toEqual({
      columns: [
        { name: 'Name', text: {} },
        { name: 'Department', text: {} },
        { name: 'Age', text: {} },
        { name: 'StartDate', dateTime: { displayAs: 'default' } },
      ],
      normalizedColumns: [
        { name: 'Name', type: 'text' },
        { name: 'Department', type: 'text' },
        { name: 'Age', type: 'text' },
        { name: 'StartDate', type: 'dateTime' },
      ],
    });
    expect(normalizeCreateListColumns({ kind: 'create_list_columns' }).result).toEqual({});

    const textReadCalls: string[] = [];
    expect(
      readFileContent(
        {
          driveId: 'drive-1',
          itemId: 'item-1',
        },
        {
          callOperation(name, args) {
            textReadCalls.push(name);
            if (name === 'get_drive_item_metadata') {
              expect(args).toEqual({ driveId: 'drive-1', itemId: 'item-1' });
              return {
                item: {
                  id: 'item-1',
                  name: 'notes.txt',
                  webUrl: 'https://contoso.sharepoint.com/sites/demo/notes.txt',
                  size: 11,
                  parentReference: { driveId: 'drive-1', siteId: 'site-1' },
                  file: { mimeType: 'text/plain' },
                  '@microsoft.graph.downloadUrl': 'https://download.example/notes.txt',
                },
              };
            }
            if (name === 'get_drive_item_content') {
              expect(args).toEqual({ driveId: 'drive-1', itemId: 'item-1' });
              return { content: 'hello world' };
            }
            throw new Error(`unexpected operation ${name}`);
          },
        },
      ).result,
    ).toEqual({
      driveId: 'drive-1',
      itemId: 'item-1',
      name: 'notes.txt',
      webUrl: 'https://contoso.sharepoint.com/sites/demo/notes.txt',
      downloadUrl: 'https://download.example/notes.txt',
      mimeType: 'text/plain',
      size: 11,
      content: 'hello world',
      contentEncoding: 'utf-8',
      maxBytes: 1048576,
      readStatus: 'read',
      warning:
        'Microsoft Graph /content returns file bytes; this tool decoded the response as UTF-8 text.',
    });
    expect(textReadCalls).toEqual(['get_drive_item_metadata', 'get_drive_item_content']);

    const binaryReadCalls: string[] = [];
    expect(
      readFileContent(
        {
          driveId: 'drive-1',
          itemId: 'image-1',
        },
        {
          callOperation(name) {
            binaryReadCalls.push(name);
            return {
              item: {
                id: 'image-1',
                name: 'profile.png',
                webUrl: 'https://contoso.sharepoint.com/sites/demo/profile.png',
                size: 1259016,
                parentReference: { driveId: 'drive-1', siteId: 'site-1' },
                file: { mimeType: 'image/png' },
              },
            };
          },
        },
      ).result,
    ).toMatchObject({
      driveId: 'drive-1',
      itemId: 'image-1',
      name: 'profile.png',
      downloadUrl: 'https://contoso.sharepoint.com/sites/demo/profile.png?download=1',
      mimeType: 'image/png',
      size: 1259016,
      content: '',
      contentEncoding: 'utf-8',
      maxBytes: 1048576,
      readStatus: 'too_large',
    });
    expect(binaryReadCalls).toEqual(['get_drive_item_metadata']);

    expect(
      readFileContent(
        {
          driveId: 'drive-1',
          itemId: 'notes-2',
        },
        {
          callOperation(name) {
            if (name === 'get_drive_item_metadata') {
              return {
                item: {
                  id: 'notes-2',
                  name: 'notes.md',
                  size: 12,
                  parentReference: { driveId: 'drive-1' },
                  file: { mimeType: 'text/markdown' },
                },
              };
            }
            throw new Error('connector failed for operation "get_drive_item_content"');
          },
        },
      ).result,
    ).toMatchObject({
      driveId: 'drive-1',
      itemId: 'notes-2',
      name: 'notes.md',
      readStatus: 'content_unavailable',
      content: '',
      contentEncoding: 'utf-8',
      maxBytes: 1048576,
    });
  });

  it('summarizes Microsoft Search hits across sites, files, and list items', () => {
    expect(
      summarizeSharePointSearchHits([
        {
          hitId: 'site-hit',
          summary: 'Team site',
          resource: {
            '@odata.type': '#microsoft.graph.site',
            id: 'tenant,site-a,web-a',
            displayName: 'NoodleBorg',
            webUrl: 'https://contoso.sharepoint.com/sites/NoodleBorg',
          },
        },
        {
          hitId: 'file-hit',
          resource: {
            '@odata.type': '#microsoft.graph.driveItem',
            id: 'item-1',
            name: 'Roadmap.docx',
            webUrl: 'https://contoso.sharepoint.com/sites/demo/Roadmap.docx',
            '@microsoft.graph.downloadUrl': 'https://download.example/roadmap',
            parentReference: { driveId: 'drive-1', siteId: 'site-1' },
            file: {
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
          },
        },
        {
          hitId: 'list-hit',
          resource: {
            '@odata.type': '#microsoft.graph.listItem',
            id: '7',
            webUrl: 'https://contoso.sharepoint.com/sites/demo/Lists/Tasks/7_.000',
            sharepointIds: { siteId: 'site-1', listId: 'list-1' },
            fields: { Title: 'Launch demo', Status: 'Active' },
          },
        },
      ]),
    ).toEqual([
      {
        resourceType: 'site',
        hitId: 'site-hit',
        summary: 'Team site',
        siteId: 'tenant,site-a,web-a',
        name: 'NoodleBorg',
        webUrl: 'https://contoso.sharepoint.com/sites/NoodleBorg',
      },
      {
        resourceType: 'driveItem',
        hitId: 'file-hit',
        siteId: 'site-1',
        driveId: 'drive-1',
        itemId: 'item-1',
        name: 'Roadmap.docx',
        webUrl: 'https://contoso.sharepoint.com/sites/demo/Roadmap.docx',
        downloadUrl: 'https://download.example/roadmap',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        itemType: 'file',
      },
      {
        resourceType: 'listItem',
        hitId: 'list-hit',
        siteId: 'site-1',
        listId: 'list-1',
        itemId: '7',
        name: 'Launch demo',
        webUrl: 'https://contoso.sharepoint.com/sites/demo/Lists/Tasks/7_.000',
        columns: { Title: 'Launch demo', Status: 'Active' },
      },
    ]);
  });

  it('summarizes sites, drives, drive items, lists, list items, and file metadata with follow-up IDs', () => {
    expect(
      summarizeSharePointSites([
        { resource: { id: 'tenant,site-a,web-a', displayName: 'NoodleBorg' } },
        { id: 'tenant,site-b,web-b', name: 'PrivateSite' },
      ]),
    ).toEqual([
      { siteId: 'tenant,site-a,web-a', name: 'NoodleBorg' },
      { siteId: 'tenant,site-b,web-b', name: 'PrivateSite' },
    ]);

    expect(
      summarizeSharePointDrives([
        {
          id: 'drive-1',
          name: 'Documents',
          webUrl: 'https://contoso.sharepoint.com/sites/demo/Shared%20Documents',
          driveType: 'documentLibrary',
        },
      ]),
    ).toEqual([
      {
        driveId: 'drive-1',
        name: 'Documents',
        webUrl: 'https://contoso.sharepoint.com/sites/demo/Shared%20Documents',
        driveType: 'documentLibrary',
      },
    ]);

    expect(
      summarizeSharePointDriveItems([
        {
          id: 'item-1',
          name: 'Profile.png',
          webUrl: 'https://contoso.sharepoint.com/sites/demo/Profile.png',
          parentReference: { driveId: 'drive-1', siteId: 'site-1', id: 'folder-1' },
          file: { mimeType: 'image/png' },
        },
        {
          id: 'shared-item-1',
          name: 'Shared roadmap.pdf',
          remoteItem: {
            id: 'remote-item-1',
            name: 'Shared roadmap.pdf',
            webUrl: 'https://contoso.sharepoint.com/sites/shared/Shared%20roadmap.pdf',
            parentReference: { driveId: 'remote-drive-1', siteId: 'remote-site-1' },
            file: { mimeType: 'application/pdf' },
            size: 4096,
          },
        },
      ]),
    ).toEqual([
      {
        siteId: 'site-1',
        driveId: 'drive-1',
        parentItemId: 'folder-1',
        itemId: 'item-1',
        name: 'Profile.png',
        webUrl: 'https://contoso.sharepoint.com/sites/demo/Profile.png',
        downloadUrl: 'https://contoso.sharepoint.com/sites/demo/Profile.png?download=1',
        mimeType: 'image/png',
        itemType: 'file',
      },
      {
        siteId: 'remote-site-1',
        driveId: 'remote-drive-1',
        itemId: 'shared-item-1',
        name: 'Shared roadmap.pdf',
        webUrl: 'https://contoso.sharepoint.com/sites/shared/Shared%20roadmap.pdf',
        downloadUrl: 'https://contoso.sharepoint.com/sites/shared/Shared%20roadmap.pdf?download=1',
        size: 4096,
        mimeType: 'application/pdf',
        itemType: 'file',
      },
    ]);

    expect(summarizeSharePointLists([{ id: 'list-1', displayName: 'Project Tasks' }])).toEqual([
      { listId: 'list-1', name: 'Project Tasks', displayName: 'Project Tasks' },
    ]);
    expect(summarizeSharePointListItems([{ id: '1', fields: { Title: 'Task' } }])).toEqual([
      { itemId: '1', name: 'Task', columns: { Title: 'Task' } },
    ]);
    expect(
      summarizeSharePointFileMetadata({
        id: 'item-1',
        name: 'Roadmap.docx',
        parentReference: { driveId: 'drive-1' },
        file: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      }),
    ).toMatchObject({
      driveId: 'drive-1',
      itemId: 'item-1',
      name: 'Roadmap.docx',
      itemType: 'file',
      textExtractionStatus: 'download_url_only',
    });
  });
});
