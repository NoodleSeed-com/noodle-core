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
import { runSharePointListCompute } from './list-compute.js';
import { sharePointListTools } from './list-tools.js';
import { driveItemSchema, driveSchema } from './schemas.js';
import { runSharePointSummaryCompute } from './summaries.js';

const sharepointSummary = connector('sharepoint_summary')
  .version('1.0.0')
  .compute('summarize', {
    input: z.object({ kind: z.string(), value: z.unknown() }),
    output: z.object({ result: z.unknown() }),
    run: runSharePointSummaryCompute,
  })
  .compute('list_items', {
    input: z.object({
      mode: z.string(),
      siteId: z.string().optional(),
      driveId: z.string().optional(),
      parentItemId: z.string().optional(),
      listId: z.string().optional(),
      skipToken: z.string().optional(),
      nextLink: z.string().optional(),
    }),
    output: z.object({ result: z.record(z.string(), z.unknown()) }),
    calls: {
      list_site_drive_root: 'sharepoint_graph.list_site_drive_root',
      list_site_drive_children: 'sharepoint_graph.list_site_drive_children',
      list_drive_root: 'sharepoint_graph.list_drive_root',
      list_drive_children: 'sharepoint_graph.list_drive_children',
      list_list_items: 'sharepoint_graph.list_list_items',
    },
    run: runSharePointSummaryCompute,
  })
  .compute('read_file_content', {
    input: z.object({ driveId: z.string(), itemId: z.string() }),
    output: z.object({ result: z.record(z.string(), z.unknown()) }),
    calls: {
      get_drive_item_metadata: 'sharepoint_graph.get_drive_item_metadata',
      get_drive_item_content: 'sharepoint_graph.get_drive_item_content',
    },
    run: runSharePointSummaryCompute,
  });

const sharepointListHelpers = connector('sharepoint_list_helpers')
  .version('1.0.0')
  .compute('summarize_columns', {
    input: z.object({ kind: z.string(), columns: z.unknown() }),
    output: z.object({ result: z.array(z.unknown()) }),
    run: runSharePointListCompute,
  })
  .compute('normalize_create_list_columns', {
    input: z.object({ kind: z.string(), columns: z.array(z.unknown()).optional() }),
    output: z.object({ result: z.record(z.string(), z.unknown()) }),
    run: runSharePointListCompute,
  })
  .compute('resolve_list_item_values', {
    input: z.object({
      kind: z.string(),
      siteId: z.string(),
      listId: z.string(),
      values: z.record(z.string(), z.unknown()),
    }),
    output: z.object({ result: z.record(z.string(), z.unknown()) }),
    calls: {
      list_list_columns: 'sharepoint_graph.list_list_columns',
    },
    run: runSharePointListCompute,
  });

const readAnnotations = annotations.readOnly({ openWorld: true });

export default server(
  'sharepoint_microsoft_graph',
  {
    title: 'SharePoint Microsoft Graph',
    version: '1.0.0',
    use: { graph, sharepoint: sharepointSummary, lists: sharepointListHelpers },
    auth: customerAuth.microsoft({
      tenantId: microsoftTenantId,
      clientId: microsoftClientId,
      clientSecret: secret('MICROSOFT_CLIENT_SECRET'),
      scopes: graphScopes,
      authMethod: 'client_secret_post',
      user: { id: 'sub', email: 'preferred_username' },
    }),
    instructions:
      'Use the sharepoint_* tools to search, inspect, browse, and stage uploads through Microsoft Graph. For SharePoint list work, prefer sharepoint_list_sites to find a site, sharepoint_list_site_lists to find a list, sharepoint_list_list_columns when column names or values are unclear, then sharepoint_list_list_items, sharepoint_get_list_item, sharepoint_add_list_item, sharepoint_update_list_item, or sharepoint_delete_list_item. Tool results include resource ids for follow-up calls and are constrained by the signed-in Microsoft user delegated permissions and SharePoint ACLs.',
  },
  [
    tool('sharepoint_search', {
      description:
        'Search SharePoint files, list items, and sites with Microsoft Search. For site-only lookup, prefer sharepoint_list_sites. Returns resource ids for follow-up calls.',
      annotations: readAnnotations,
      input: z.object({
        query: z
          .string()
          .describe('Search text, such as a file name, list item title, or site name.'),
        size: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Maximum results per requested entity type. Defaults to 10.'),
      }),
      output: z.object({
        query: z.string(),
        results: z.array(z.unknown()),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.searchAll({
          query: input.query,
          size: input.size,
        });
        const summary = connectors.sharepoint.summarize({
          kind: 'search_hits',
          value: result.hits,
        });
        return { query: input.query, results: summary.result };
      },
    }),
    tool('sharepoint_read_file', {
      description:
        'Return file metadata plus a Graph download URL for a drive item. For small text-like files, use sharepoint_read_file_content to read decoded text content.',
      annotations: readAnnotations,
      input: z.object({ driveId: z.string(), itemId: z.string() }),
      output: z.object({
        driveId: z.string(),
        itemId: z.string(),
        file: driveItemSchema.extend({
          textExtractionStatus: z.literal('download_url_only'),
          textUnavailableReason: z.string(),
        }),
        downloadUrl: z.string().optional(),
        textExtractionStatus: z.literal('download_url_only'),
        textUnavailableReason: z.string(),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.getDriveItemMetadata({
          driveId: input.driveId,
          itemId: input.itemId,
        });
        const summary = connectors.sharepoint.summarize({
          kind: 'file_metadata',
          value: result.item,
        });
        return {
          driveId: input.driveId,
          itemId: input.itemId,
          file: summary.result,
          downloadUrl: summary.result.downloadUrl,
          textExtractionStatus: summary.result.textExtractionStatus,
          textUnavailableReason: summary.result.textUnavailableReason,
        };
      },
    }),
    tool('sharepoint_read_file_content', {
      description:
        'Read a small text-like SharePoint file by drive id and item id using Microsoft Graph /content. For binary or large files, returns metadata and a download URL instead of failing.',
      annotations: readAnnotations,
      input: z.object({
        driveId: z.string(),
        itemId: z.string(),
      }),
      output: z.object({
        driveId: z.string(),
        itemId: z.string(),
        readStatus: z.enum([
          'read',
          'unsupported_binary',
          'too_large',
          'metadata_unavailable',
          'content_unavailable',
        ]),
        name: z.string().optional(),
        webUrl: z.string().optional(),
        downloadUrl: z.string().optional(),
        mimeType: z.string().optional(),
        size: z.number().optional(),
        content: z.string(),
        contentEncoding: z.literal('utf-8'),
        maxBytes: z.number(),
        warning: z.string(),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.sharepoint.readFileContent({
          driveId: input.driveId,
          itemId: input.itemId,
        });
        return {
          driveId: result.result.driveId,
          itemId: result.result.itemId,
          readStatus: result.result.readStatus,
          name: result.result.name,
          webUrl: result.result.webUrl,
          downloadUrl: result.result.downloadUrl,
          mimeType: result.result.mimeType,
          size: result.result.size,
          content: result.result.content,
          contentEncoding: result.result.contentEncoding,
          maxBytes: result.result.maxBytes,
          warning: result.result.warning,
        };
      },
    }),
    tool('sharepoint_list_items', {
      description:
        'Browse a SharePoint drive folder or list. Use mode "drive" with siteId or driveId, or mode "list" with siteId and listId.',
      annotations: readAnnotations,
      input: z.object({
        mode: z.enum(['drive', 'list']),
        siteId: z.string().optional(),
        driveId: z.string().optional(),
        parentItemId: z.string().optional(),
        listId: z.string().optional(),
        skipToken: z
          .string()
          .optional()
          .describe('Continuation token returned by a previous list response.'),
        nextLink: z
          .string()
          .optional()
          .describe('Full nextLink returned by a previous list response; skipToken is preferred.'),
      }),
      output: z.object({
        mode: z.enum(['drive', 'list']),
        siteId: z.string().optional(),
        driveId: z.string().optional(),
        parentItemId: z.string().optional(),
        listId: z.string().optional(),
        items: z.array(z.unknown()),
        nextLink: z.string().optional(),
        skipToken: z.string().optional(),
        warning: z.string().optional(),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.sharepoint.listItems({
          mode: input.mode,
          siteId: input.siteId,
          driveId: input.driveId,
          parentItemId: input.parentItemId,
          listId: input.listId,
          skipToken: input.skipToken,
          nextLink: input.nextLink,
        });
        return {
          mode: result.result.mode,
          siteId: result.result.siteId,
          driveId: result.result.driveId,
          parentItemId: result.result.parentItemId,
          listId: result.result.listId,
          items: result.result.items,
          nextLink: result.result.nextLink,
          skipToken: result.result.skipToken,
          warning: result.result.warning,
        };
      },
    }),
    tool('sharepoint_list_sites', {
      description:
        'Search visible SharePoint sites by name and return site ids and names. Uses Microsoft Search for delegated user access.',
      annotations: readAnnotations,
      input: z.object({
        search: z.string().describe('Site name or keywords, for example "NoodleBorg".'),
        size: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Maximum number of sites to return. Defaults to 10.'),
      }),
      output: z.object({
        search: z.string(),
        sites: z.array(
          z.object({
            siteId: z.string(),
            name: z.string(),
            webUrl: z.string().optional(),
          }),
        ),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.searchSites({
          query: input.search,
          size: input.size,
        });
        const summary = connectors.sharepoint.summarize({ kind: 'sites', value: result.hits });
        return { search: input.search, sites: summary.result };
      },
    }),
    tool('sharepoint_list_drives', {
      description:
        'List the SharePoint document-library drives for a site and return each drive id and name for follow-up file browsing calls.',
      annotations: readAnnotations,
      input: z.object({
        siteId: z
          .string()
          .describe(
            'Microsoft Graph site id, for example the siteId returned by sharepoint_list_sites.',
          ),
      }),
      output: z.object({
        siteId: z.string(),
        drives: z.array(driveSchema),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.listSiteDrives({ siteId: input.siteId });
        const summary = connectors.sharepoint.summarize({ kind: 'drives', value: result.drives });
        return { siteId: input.siteId, drives: summary.result };
      },
    }),
    ...sharePointListTools(),
    tool('sharepoint_get_metadata', {
      description: 'Get metadata for a SharePoint drive item by drive id and item id.',
      annotations: readAnnotations,
      input: z.object({ driveId: z.string(), itemId: z.string() }),
      output: z.object({
        driveId: z.string(),
        itemId: z.string(),
        metadata: driveItemSchema,
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.getDriveItemMetadata({
          driveId: input.driveId,
          itemId: input.itemId,
        });
        const summary = connectors.sharepoint.summarize({
          kind: 'drive_item',
          value: result.item,
        });
        return { driveId: input.driveId, itemId: input.itemId, metadata: summary.result };
      },
    }),
    tool('sharepoint_upload_file', {
      description:
        'Create a Microsoft Graph upload session for a file in a SharePoint drive folder. The response uploadUrl accepts the file-byte PUT outside this JSON connector.',
      annotations: annotations.openAction({ destructive: false }),
      input: z.object({
        driveId: z.string(),
        parentItemId: z.string(),
        fileName: z.string(),
        conflictBehavior: z.enum(['fail', 'replace', 'rename']),
      }),
      output: z.object({
        driveId: z.string(),
        parentItemId: z.string(),
        fileName: z.string(),
        uploadUrl: z
          .string()
          .describe(
            'Preauthenticated Microsoft Graph upload-session URL. PUT file bytes to this exact URL and omit Authorization.',
          ),
        uploadMethod: z.literal('PUT'),
        authorizationHeader: z.literal('omit'),
        expirationDateTime: z.string().optional(),
        uploadInstructions: z.string(),
      }),
      fulfil({ input, connectors }) {
        const result = connectors.graph.createUploadSession({
          driveId: input.driveId,
          parentItemId: input.parentItemId,
          fileName: input.fileName,
          conflictBehavior: input.conflictBehavior,
        });
        return {
          driveId: input.driveId,
          parentItemId: input.parentItemId,
          fileName: input.fileName,
          uploadUrl: result.uploadUrl,
          uploadMethod: 'PUT',
          authorizationHeader: 'omit',
          expirationDateTime: result.expirationDateTime,
          uploadInstructions:
            'Upload the file bytes with an HTTP PUT to this exact uploadUrl before expirationDateTime. Do not add an Authorization header; the upload session URL is already preauthorized. The Noodle declarative HTTP connector currently creates the upload session but does not stream arbitrary file bytes.',
        };
      },
    }),
    resource('recent_files', {
      uri: 'sharepoint://recent_files',
      title: 'Recent SharePoint files',
      description: 'Recent Microsoft Graph drive items for the signed-in user.',
      mimeType: 'application/json',
      fulfil({ connectors }) {
        const result = connectors.graph.listRecentFiles();
        const summary = connectors.sharepoint.summarize({
          kind: 'drive_items',
          value: result.items,
        });
        return { recentFiles: summary.result };
      },
    }),
    resource('whoami', {
      uri: 'sharepoint://whoami',
      title: 'Signed-in Microsoft user',
      description: 'Microsoft Graph /me profile for the signed-in user.',
      mimeType: 'application/json',
      fulfil({ connectors }) {
        const profile = connectors.graph.getMe();
        return { profile };
      },
    }),
    prompt('summarize_document', {
      title: 'Summarize a SharePoint document',
      description:
        'Guide an MCP client through searching for a SharePoint document and summarizing it.',
      arguments: [
        { name: 'query', required: true },
        { name: 'site_id', required: false },
      ],
      fulfil({ input }) {
        return [
          {
            role: 'user',
            text: `Find a SharePoint document matching "${input.query}". If site_id is present ("${input.site_id}"), prefer results from that site. Call sharepoint_search with driveItem results, then call sharepoint_read_file on the best driveId/itemId. If the file is text-like and small, call sharepoint_read_file_content to read its contents. For Office, PDF, spreadsheet, image, media, or large files, use the downloadUrl and explain that full text extraction requires a binary extractor connector before producing a summary.`,
          },
        ];
      },
    }),
  ],
);
