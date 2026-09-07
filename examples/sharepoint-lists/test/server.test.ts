import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import app from '../src/server.js';
import {
  normalizeCreateListColumns,
  summarizeColumn,
  summarizeListItemsPage,
  summarizeLists,
  summarizeSites,
} from '../src/summaries.js';

type ComputeRun = (input: Record<string, unknown>) => { result: unknown };

function serializedComputeRun(code: unknown): ComputeRun {
  expect(typeof code).toBe('string');
  if (typeof code !== 'string') throw new Error('expected serialized compute code');
  return runInNewContext(`(${code})`) as ComputeRun;
}

describe('SharePoint Lists MCP server', () => {
  it('exports a Noodle server definition', () => {
    expect(typeof app.toManifest).toBe('function');
    expect(typeof app.toConnectorCatalog).toBe('function');
  });

  it('declares the list-focused tool, resource, and prompt surface', async () => {
    const manifest = await app.toManifest();

    expect(manifest.server).toMatchObject({
      name: 'sharepoint_lists_microsoft_graph',
      title: 'SharePoint Lists Microsoft Graph',
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
        ],
      },
    });
    expect(manifest.connectors).toEqual({
      graph: { id: 'sharepoint_lists_graph', version: '1.0.0' },
      sharepoint: { id: 'sharepoint_lists_summary', version: '1.0.0' },
    });
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      'sharepoint_list_sites',
      'sharepoint_list_lists',
      'sharepoint_get_list',
      'sharepoint_list_columns',
      'sharepoint_create_list',
      'sharepoint_add_list_column',
      'sharepoint_update_list_column',
      'sharepoint_delete_list_column',
      'sharepoint_list_items',
      'sharepoint_get_list_item',
      'sharepoint_query_list',
      'sharepoint_add_list_item',
      'sharepoint_update_list_item',
      'sharepoint_delete_list_item',
    ]);
    expect(manifest.resources?.map((resource) => resource.name)).toEqual(['whoami']);
    expect(manifest.resources?.[0]).toMatchObject({
      uri: 'sharepoint-lists://whoami',
      mimeType: 'application/json',
    });
    expect(manifest.prompts?.map((prompt) => prompt.name)).toEqual(['manage_sharepoint_list']);

    for (const name of [
      'sharepoint_list_sites',
      'sharepoint_list_lists',
      'sharepoint_get_list',
      'sharepoint_list_columns',
      'sharepoint_list_items',
      'sharepoint_get_list_item',
      'sharepoint_query_list',
    ]) {
      expect(manifest.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
    }
    for (const name of [
      'sharepoint_create_list',
      'sharepoint_add_list_column',
      'sharepoint_update_list_column',
      'sharepoint_add_list_item',
      'sharepoint_update_list_item',
    ]) {
      expect(manifest.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
    }
    for (const name of ['sharepoint_delete_list_column', 'sharepoint_delete_list_item']) {
      expect(manifest.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
    }
  });

  it('declares Microsoft Graph list operations with write methods', () => {
    const catalog = app.toConnectorCatalog();
    const graph = catalog?.connectors.find(
      (connector) => connector.id === 'sharepoint_lists_graph',
    );

    expect(Object.keys(graph?.operations ?? {})).toEqual([
      'get_me',
      'search_sites',
      'list_site_lists',
      'get_site_list',
      'list_list_columns',
      'create_site_list',
      'create_list_column',
      'update_list_column',
      'delete_list_column',
      'list_list_items',
      'get_list_item',
      'query_list_items',
      'create_list_item',
      'update_list_item',
      'delete_list_item',
    ]);
    expect(graph?.operations.update_list_column).toMatchObject({
      type: 'action',
      method: 'PATCH',
      path: '/sites/{siteId}/lists/{listId}/columns/{columnId}',
    });
    expect(graph?.operations.delete_list_column).toMatchObject({
      type: 'action',
      method: 'DELETE',
      responseType: 'text',
    });
    expect(graph?.operations.update_list_item).toMatchObject({
      type: 'action',
      method: 'PATCH',
      path: '/sites/{siteId}/lists/{listId}/items/{itemId}/fields',
      request: '${args.fields}',
    });
    expect(graph?.operations.delete_list_item).toMatchObject({
      type: 'action',
      method: 'DELETE',
      responseType: 'text',
    });
  });

  it('declares a compute connector for list response normalization', () => {
    const catalog = app.toConnectorCatalog();
    const summary = catalog?.connectors.find(
      (connector) => connector.id === 'sharepoint_lists_summary',
    );

    expect(summary).toMatchObject({
      id: 'sharepoint_lists_summary',
      version: '1.0.0',
      kind: 'custom',
      operations: {
        summarize: {
          type: 'read',
          input: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              value: {},
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
        normalize_create_list_columns: {
          type: 'read',
          input: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              columns: { type: 'array' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(summary?.operations.summarize.code).toBe(
      summary?.operations.normalize_create_list_columns.code,
    );
  });

  it('runs serialized compute code for list summaries', () => {
    const catalog = app.toConnectorCatalog();
    const summary = catalog?.connectors.find(
      (connector) => connector.id === 'sharepoint_lists_summary',
    );
    const summarize = serializedComputeRun(summary?.operations.summarize.code);
    const normalizeColumns = serializedComputeRun(
      summary?.operations.normalize_create_list_columns.code,
    );

    expect(
      summarize({
        kind: 'lists',
        value: [
          {
            id: 'list-1',
            name: 'Tasks',
            displayName: 'Team Tasks',
            list: { template: 'genericList' },
          },
        ],
      }).result,
    ).toEqual([
      { listId: 'list-1', name: 'Tasks', displayName: 'Team Tasks', template: 'genericList' },
    ]);
    expect(
      summarize({
        kind: 'columns',
        value: [
          { id: 'col-1', name: 'Status', displayName: 'Status', choice: { choices: ['Open'] } },
        ],
      }).result,
    ).toEqual([
      {
        columnId: 'col-1',
        name: 'Status',
        displayName: 'Status',
        type: 'choice',
        definition: {
          id: 'col-1',
          name: 'Status',
          displayName: 'Status',
          choice: { choices: ['Open'] },
        },
      },
    ]);
    expect(
      summarize({
        kind: 'list_items_page',
        value: {
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/sites/site/lists/list/items?$skiptoken=abc%20123',
          value: [
            {
              id: '7',
              webUrl: 'https://contoso.sharepoint.com/sites/demo/Lists/Tasks/7_.000',
              sharepointIds: { siteId: 'site-1', listId: 'list-1' },
              fields: { Title: 'Launch demo', Status: 'Open', '@odata.etag': '"etag"' },
            },
          ],
        },
      }).result,
    ).toEqual({
      items: [
        {
          siteId: 'site-1',
          listId: 'list-1',
          itemId: '7',
          name: 'Launch demo',
          webUrl: 'https://contoso.sharepoint.com/sites/demo/Lists/Tasks/7_.000',
          columns: { Title: 'Launch demo', Status: 'Open' },
        },
      ],
      nextLink: 'https://graph.microsoft.com/v1.0/sites/site/lists/list/items?$skiptoken=abc%20123',
      skipToken: 'abc 123',
    });
    expect(
      normalizeColumns({
        kind: 'create_list_columns',
        columns: ['Status', { name: 'DueDate', dateTime: {} }],
      }).result,
    ).toEqual({
      columns: [
        { name: 'Status', text: {} },
        { name: 'DueDate', dateTime: {} },
      ],
    });
  });

  it('summarizes list primitives directly', () => {
    expect(summarizeSites([{ resource: { id: 'site-1', displayName: 'Ops' } }])).toEqual([
      { siteId: 'site-1', name: 'Ops' },
    ]);
    expect(summarizeLists([{ id: 'list-1', displayName: 'Tasks' }])).toEqual([
      { listId: 'list-1', name: 'Tasks', displayName: 'Tasks' },
    ]);
    expect(summarizeColumn({ id: 'col-1', name: 'Amount', number: {} })).toMatchObject({
      columnId: 'col-1',
      name: 'Amount',
      type: 'number',
    });
    expect(
      summarizeListItemsPage({
        value: [{ id: '1', fields: { Title: 'Task', '@odata.etag': 'etag' } }],
      }),
    ).toEqual({ items: [{ itemId: '1', name: 'Task', columns: { Title: 'Task' } }] });
    expect(normalizeCreateListColumns(['Name'])).toEqual({ columns: [{ name: 'Name', text: {} }] });
  });
});
