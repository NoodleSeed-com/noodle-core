# SharePoint Microsoft Graph

This curated example owns the Microsoft SharePoint delegated Microsoft Entra auth capability slot. It exposes
a demo-ready MCP surface for SharePoint sites, files, drives, lists, list items, recent files, user identity,
and upload-session creation through Microsoft Graph.

For a list-only demo that covers schema discovery plus complete row and column manipulation, use
[`../sharepoint-lists`](../sharepoint-lists/README.md). This example stays broader so it can show files,
search, drives, resources, prompts, delegated auth, and upload-session creation in one place.

## What It Does

- Authenticates the MCP user with Microsoft Entra through `customerAuth.microsoft(...)`.
- Stores the Microsoft refresh token through Noodle's delegated credential broker.
- Calls Microsoft Graph with a short-lived delegated access token for the signed-in user.
- Lets Microsoft Graph and SharePoint enforce the user's effective ACLs.
- Returns resource IDs in tool responses so MCP clients can chain follow-up calls.

Tools:

- `sharepoint_search` - unified Microsoft Search across `driveItem`, `listItem`, and `site` results.
- `sharepoint_read_file` - return drive item metadata plus a Microsoft Graph download URL.
- `sharepoint_read_file_content` - read small text-like files through Microsoft Graph `/content`.
- `sharepoint_list_items` - browse a drive folder or a SharePoint list.
- `sharepoint_list_sites` - search visible SharePoint sites and return `{ siteId, name, webUrl }`.
- `sharepoint_list_drives` - list document-library drives for a known site and return `{ driveId, name }`.
- `sharepoint_list_site_lists` - list SharePoint lists in a site and return `{ listId, name, displayName }`.
- `sharepoint_list_list_columns` - inspect list columns, internal field names, types, and choices.
- `sharepoint_create_list` - create a new SharePoint list in a site and return the new `listId`.
- `sharepoint_list_list_items` - list rows from a SharePoint list and return each `itemId` plus columns.
- `sharepoint_query_list` - query list items with a Graph `$filter` expression and expanded columns.
- `sharepoint_add_list_item` - add an item with human-friendly column names and return the created `itemId`.
- `sharepoint_get_list_item` - fetch one list item by `itemId` before update or delete.
- `sharepoint_update_list_item` - partially update one list item with human-friendly column names.
- `sharepoint_delete_list_item` - delete one confirmed list item by `itemId`.
- `sharepoint_get_metadata` - get metadata for a drive item by `driveId` and `itemId`.
- `sharepoint_upload_file` - create a Graph upload session and return the preauthenticated `uploadUrl`.

Resources:

- `sharepoint://recent_files` (`recent_files`) - recent drive items for the signed-in user.
- `sharepoint://whoami` (`whoami`) - Microsoft Graph `/me` profile for the signed-in user.

Prompt:

- `summarize_document` - guides the client through search, read, and summary steps for a document.

## Current Connector Limits

`sharepoint_read_file_content` calls Microsoft Graph `/drives/{driveId}/items/{itemId}/content` and decodes
the response as UTF-8 text. Use it for small text-like files such as `.txt`, `.md`, `.csv`, `.json`, or
source files. It is not a document parser: Microsoft Graph returns file bytes, not extracted text, so Office
documents, PDFs, spreadsheets, images, media, and other binary formats still need a binary/text extraction
connector. The underlying declarative HTTP connector also enforces its default 1 MiB response cap. When a
file is too large, binary-looking, or cannot be read through `/content`, the tool returns `readStatus`,
metadata, and any available `downloadUrl` instead of failing the tool call.

`sharepoint_read_file` intentionally reports `textExtractionStatus: "download_url_only"` and returns
`downloadUrl` for the file bytes, matching Microsoft Graph's drive item download URL behavior. Use that URL
when a client or future connector needs the original binary bytes.

`sharepoint_upload_file` creates a Microsoft Graph upload session. Uploading the actual bytes requires an
HTTP `PUT` to the returned `uploadUrl`, which is outside this JSON connector's current method/body support.
Use the returned URL exactly as-is and do not send an `Authorization` header; Microsoft Graph preauthorizes
that upload-session URL.

List browsing and list queries request 200 items at a time with hardcoded `$top=200`. For larger folders or
lists, call the same tool again with the returned `skipToken`; `sharepoint_list_items` can also accept the
returned `nextLink` and extract the token. For list-specific row work, prefer
`sharepoint_list_list_items` over the generic `sharepoint_list_items`.

This demo intentionally stays Microsoft Graph v1.0-only. It can create lists and add, update, read, query,
and delete individual list items, but it does not expose a `sharepoint_delete_list` tool because Microsoft
Graph v1.0 does not document a delete-list operation for the list container. If a user asks to delete an
entire SharePoint list, explain that this demo can delete rows/items but not the list itself.

## Microsoft Entra Setup

Create an Entra app registration for this example:

1. Add a web redirect URI:
   `https://cloud.noodleseed.dev/oauth/customer/microsoft/callback`
2. Add delegated Microsoft Graph scopes:
   - `User.Read`
   - `Sites.Read.All`
   - `Sites.ReadWrite.All`
   - `Sites.Manage.All`
   - `Files.ReadWrite.All`
3. Grant admin consent if your tenant requires it.
4. Create a client secret. Do not commit the secret value.

`Sites.Read.All`, `Sites.ReadWrite.All`, `Sites.Manage.All`, and `Files.ReadWrite.All` are broad demo scopes.
Graph still runs as the signed-in user, so SharePoint ACLs continue to constrain returned data, list writes,
and upload targets. For a production app, narrow the scope set to the least-privileged Microsoft Graph
permissions your tools need.

Useful Microsoft references:

- Microsoft Search API: <https://learn.microsoft.com/en-us/graph/search-concept-files>
- List drives for a site: <https://learn.microsoft.com/en-us/graph/api/drive-list>
- Drive resource type: <https://learn.microsoft.com/en-us/graph/api/resources/drive>
- Drive item content download: <https://learn.microsoft.com/en-us/graph/api/driveitem-get-content>
- List resource: <https://learn.microsoft.com/en-us/graph/api/resources/list>
- Create list: <https://learn.microsoft.com/en-us/graph/api/list-create>
- List columns: <https://learn.microsoft.com/en-us/graph/api/list-list-columns>
- List list items: <https://learn.microsoft.com/en-us/graph/api/listitem-list>
- Create list item: <https://learn.microsoft.com/en-us/graph/api/listitem-create>
- Update list item fields: <https://learn.microsoft.com/en-us/graph/api/listitem-update>
- Delete list item: <https://learn.microsoft.com/en-us/graph/api/listitem-delete>
- Create upload session: <https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession>

## Configure The Example

`src/server.ts` references Microsoft app configuration with managed config:

- `variable("MICROSOFT_TENANT_ID")` for the Entra tenant ID.
- `variable("MICROSOFT_CLIENT_ID")` for the Entra app registration client ID.
- `secret("MICROSOFT_CLIENT_SECRET")` for the Entra client secret.

Set the non-secret values through Noodle managed variables:

```sh
noodle login

noodle variables set MICROSOFT_TENANT_ID \
  --runtime cloud \
  --scope env \
  --org <org> \
  --app sharepoint \
  --env prod \
  --value "<tenant-id>"

noodle variables set MICROSOFT_CLIENT_ID \
  --runtime cloud \
  --scope env \
  --org <org> \
  --app sharepoint \
  --env prod \
  --value "<application-client-id>"
```

Store the client secret through Noodle managed secrets:

```sh
export MICROSOFT_CLIENT_SECRET="<client-secret>"
noodle secrets set MICROSOFT_CLIENT_SECRET \
  --runtime cloud \
  --scope env \
  --org <org> \
  --app sharepoint \
  --env prod \
  --from-env MICROSOFT_CLIENT_SECRET
```

For purely local validation, use the same commands with `--runtime local`; the values are written to the
repo-local `.env.noodle` file, which is ignored by git.

## Run Locally

This example requires a Noodle CLI/runtime with Microsoft delegated OAuth support.

```sh
noodle validate
noodle auth doctor src/server.ts
noodle dev
```

`noodle dev` boots a local loopback MCP server on `src/server.ts` and hot-reloads on save. The Microsoft
delegated auth flow is a hosted customer-auth flow, so use the hosted deployment path for a real OAuth
sign-in with an MCP client.

## Deploy

```sh
noodle login
noodle link --org <org> --app sharepoint --env prod
noodle deploy --access customers
```

Connect an OAuth-capable MCP client to the deployed endpoint:

```text
https://cloud.noodleseed.dev/o/<org>/sharepoint/prod/mcp
```

On first connect, the client follows Noodle's protected-resource metadata, Noodle redirects to Microsoft,
Microsoft returns to the Noodle bridge callback, and the runtime stores the delegated Microsoft credential.
Tool calls then exchange that stored refresh token for per-user Graph access tokens.

## Demo Flow

In ChatGPT, Gemini Enterprise, or another OAuth-capable MCP client:

1. Read the `whoami` resource to confirm which Microsoft user is connected.
2. Call `sharepoint_list_sites` with a site search term, such as `NoodleBorg`, and copy the returned
   `siteId`.
3. Call `sharepoint_list_drives` with the `siteId` to list that site's document-library drives and copy a
   `driveId` when you want to browse a non-default document library.
4. Call `sharepoint_search` with a file name, list item title, site name, or topic. The tool defaults to
   searching files, list items, and sites with 10 results per type. Copy the returned `driveId` and `itemId`
   for file follow-up calls.
5. Call `sharepoint_read_file` or `sharepoint_get_metadata` with `driveId` and `itemId`.
6. For small text-like files, call `sharepoint_read_file_content` with `driveId` and `itemId` to return the
   decoded text content directly in the MCP tool response.
7. Call `sharepoint_list_items` with `mode: "drive"` and either `siteId` or `driveId` to browse folders.
8. Call `sharepoint_list_site_lists` with `siteId` to discover list names and copy a `listId`.
9. Call `sharepoint_list_list_columns` with `siteId` and `listId` when the user wants to add or edit rows
   and Gemini is unsure which column names or choice values are valid.
10. Call `sharepoint_list_list_items` with `siteId` and `listId` to view list rows with all columns. Copy
    the returned `itemId` for update or delete follow-up calls.
11. Call `sharepoint_create_list` with `siteId`, `displayName`, optional `description`, optional `template`,
    and optional `columns` to create a new list. For simple text columns, pass names such as
    `["TeamName", "Department"]`; for typed columns, pass objects such as
    `{ "name": "Age", "type": "number" }` or
    `{ "name": "Status", "type": "choice", "choices": ["Open", "Closed"] }`. The default template is
    `genericList`, which already includes the built-in Title column.
12. Call `sharepoint_add_list_item` with `siteId`, `listId`, and a `values` object keyed by visible display
    names or internal names, for example `{ "Task name": "Launch task", "Status": "Open" }`. The tool
    resolves those names to Graph field names before writing.
13. Call `sharepoint_get_list_item` before mutating a row when the user has not already confirmed the exact
    `itemId`.
14. Call `sharepoint_update_list_item` with `siteId`, `listId`, `itemId`, and a partial `values` object to
    edit only the provided columns.
15. Call `sharepoint_delete_list_item` only after the user has confirmed the exact `itemId`. There is no
    Graph-only `sharepoint_delete_list` tool in this demo.
16. Call `sharepoint_query_list` with a Graph `$filter` expression for filtered list data.
17. Call `sharepoint_upload_file` to create an upload session when demonstrating write capability. Then PUT
   the local file bytes to the returned `uploadUrl` with `Content-Length` and `Content-Range`, omitting
   `Authorization`.

`sharepoint_list_sites` uses Microsoft Search rather than `/sites` enumeration because complete delegated
site inventory is not available through the Graph site collection list endpoint. Search results and all
subsequent calls are still scoped by the signed-in user's delegated permissions and SharePoint ACLs.
`sharepoint_list_drives` uses `GET /sites/{siteId}/drives`, which returns the document-library drives for a
known site rather than discovering sites.

## Test

```sh
npm test
```

The tests assert the authored manifest, connector catalog, and pure response summarizers. They do not call
Microsoft Graph or require a real tenant.
