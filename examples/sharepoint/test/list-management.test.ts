import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import app from '../src/server.js';

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

describe('SharePoint list-management tools', () => {
  it('declares Gemini-friendly list tools with safe mutating annotations', async () => {
    const manifest = await app.toManifest();
    const toolNames = manifest.tools.map((tool) => tool.name);

    expect(toolNames).toContain('sharepoint_list_site_lists');
    expect(toolNames).toContain('sharepoint_list_list_columns');
    expect(toolNames).toContain('sharepoint_list_list_items');
    expect(toolNames).toContain('sharepoint_get_list_item');
    expect(toolNames).toContain('sharepoint_update_list_item');
    expect(toolNames).toContain('sharepoint_delete_list_item');
    expect(toolNames).not.toContain('sharepoint_delete_list');

    expect(manifest.tools.find((tool) => tool.name === 'sharepoint_list_site_lists')).toMatchObject(
      {
        description: expect.stringContaining('after sharepoint_list_sites'),
        inputSchema: {
          required: ['siteId'],
          properties: {
            siteId: {
              description: expect.stringContaining('siteId returned by sharepoint_list_sites'),
            },
          },
        },
      },
    );
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_list_list_columns'),
    ).toMatchObject({
      description: expect.stringContaining('before adding or editing list items'),
      inputSchema: {
        required: ['siteId', 'listId'],
      },
    });
    expect(manifest.tools.find((tool) => tool.name === 'sharepoint_add_list_item')).toMatchObject({
      description: expect.stringContaining('visible column display names'),
      inputSchema: {
        required: ['siteId', 'listId', 'values'],
        properties: {
          values: {
            description: expect.stringContaining('display names or internal names'),
          },
        },
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_update_list_item'),
    ).toMatchObject({
      description: expect.stringContaining('partial update'),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        required: ['siteId', 'listId', 'itemId', 'values'],
      },
    });
    expect(
      manifest.tools.find((tool) => tool.name === 'sharepoint_delete_list_item'),
    ).toMatchObject({
      description: expect.stringContaining('confirmed itemId'),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        required: ['siteId', 'listId', 'itemId'],
      },
      outputSchema: {
        required: ['siteId', 'listId', 'itemId', 'deleted'],
      },
    });
    const getListItem = manifest.tools.find((tool) => tool.name === 'sharepoint_get_list_item');
    expect(JSON.stringify(getListItem?.fulfilment.output)).not.toContain('.0');
    expect(getListItem?.fulfilment).toMatchObject({
      output: {
        item: '${steps.summarize.result}',
        columns: '${steps.summarize.result.columns}',
      },
    });
  });

  it('declares Microsoft Graph operations for list management', () => {
    const catalog = app.toConnectorCatalog();
    const graph = catalog?.connectors.find((connector) => connector.id === 'sharepoint_graph');

    expect(Object.keys(graph?.operations ?? {})).toEqual(
      expect.arrayContaining([
        'list_site_lists',
        'list_list_columns',
        'get_list_item',
        'create_list_item',
        'update_list_item_fields',
        'delete_list_item',
      ]),
    );
    expect(graph?.operations.list_list_columns).toMatchObject({
      type: 'read',
      method: 'GET',
      path: '/sites/{siteId}/lists/{listId}/columns?$select=id,name,displayName,hidden,readOnly,required,boolean,choice,dateTime,number,text',
    });
    expect(graph?.operations.get_list_item).toMatchObject({
      type: 'read',
      method: 'GET',
      path: '/sites/{siteId}/lists/{listId}/items/{itemId}?$expand=fields',
    });
    expect(graph?.operations.update_list_item_fields).toMatchObject({
      type: 'action',
      method: 'PATCH',
      path: '/sites/{siteId}/lists/{listId}/items/{itemId}/fields',
      request: { '${spread}': '${args.fields}' },
    });
    expect(graph?.operations.delete_list_item).toMatchObject({
      type: 'action',
      method: 'DELETE',
      path: '/sites/{siteId}/lists/{listId}/items/{itemId}',
      responseType: 'empty',
      response: { deleted: true },
    });
  });

  it('normalizes list columns and human-friendly item values through compute', () => {
    const catalog = app.toConnectorCatalog();
    const helper = catalog?.connectors.find(
      (connector) => connector.id === 'sharepoint_list_helpers',
    );
    const summarizeColumns = serializedComputeRun(helper?.operations.summarize_columns.code);
    const normalizeCreateListColumns = serializedComputeRun(
      helper?.operations.normalize_create_list_columns.code,
    );
    const resolveListItemValues = serializedComputeRun(
      helper?.operations.resolve_list_item_values.code,
    );

    const columns = [
      { id: 'c-title', name: 'Title', displayName: 'Task name', text: {} },
      {
        id: 'c-status',
        name: 'Status',
        displayName: 'Status',
        choice: { choices: ['Open', 'Closed'] },
      },
      { id: 'c-age', name: 'Age', displayName: 'Age', number: {} },
      { id: 'c-done', name: 'Done', displayName: 'Done', boolean: {} },
      { id: 'c-created', name: 'Created', displayName: 'Created', readOnly: true, dateTime: {} },
    ];

    expect(summarizeColumns({ kind: 'columns', columns }).result).toEqual([
      {
        columnId: 'c-title',
        name: 'Title',
        displayName: 'Task name',
        type: 'text',
      },
      {
        columnId: 'c-status',
        name: 'Status',
        displayName: 'Status',
        type: 'choice',
        choices: ['Open', 'Closed'],
      },
      {
        columnId: 'c-age',
        name: 'Age',
        displayName: 'Age',
        type: 'number',
      },
      {
        columnId: 'c-done',
        name: 'Done',
        displayName: 'Done',
        type: 'boolean',
      },
      {
        columnId: 'c-created',
        name: 'Created',
        displayName: 'Created',
        type: 'dateTime',
        readOnly: true,
      },
    ]);

    expect(
      normalizeCreateListColumns({
        kind: 'create_list_columns',
        columns: [
          'Department',
          { name: 'Age', type: 'number' },
          { name: 'Status', type: 'choice', choices: ['Open', 'Closed'] },
        ],
      }).result,
    ).toEqual({
      columns: [
        { name: 'Department', text: {} },
        { name: 'Age', number: {} },
        { name: 'Status', choice: { choices: ['Open', 'Closed'] } },
      ],
      normalizedColumns: [
        { name: 'Department', type: 'text' },
        { name: 'Age', type: 'number' },
        { name: 'Status', type: 'choice', choices: ['Open', 'Closed'] },
      ],
    });

    expect(
      resolveListItemValues(
        {
          kind: 'list_item_values',
          siteId: 'site-1',
          listId: 'list-1',
          values: {
            'task NAME': 'Launch demo',
            status: 'Open',
            Age: '42',
            done: 'true',
          },
        },
        {
          callOperation(name, args) {
            expect(name).toBe('list_list_columns');
            expect(args).toEqual({ siteId: 'site-1', listId: 'list-1' });
            return { columns };
          },
        },
      ).result,
    ).toEqual({
      fields: {
        Title: 'Launch demo',
        Status: 'Open',
        Age: 42,
        Done: true,
      },
      resolvedFields: {
        'task NAME': 'Title',
        status: 'Status',
        Age: 'Age',
        done: 'Done',
      },
    });

    expect(() =>
      resolveListItemValues(
        {
          kind: 'list_item_values',
          siteId: 'site-1',
          listId: 'list-1',
          values: { Status: 'Blocked' },
        },
        { callOperation: () => ({ columns }) },
      ),
    ).toThrow(/must be one of: Open, Closed/);
    expect(() =>
      resolveListItemValues(
        {
          kind: 'list_item_values',
          siteId: 'site-1',
          listId: 'list-1',
          values: { Created: '2026-07-06T00:00:00Z' },
        },
        { callOperation: () => ({ columns }) },
      ),
    ).toThrow(/read-only/);
  });
});
