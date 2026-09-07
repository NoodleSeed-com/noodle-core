# SharePoint Lists Microsoft Graph

This curated example owns the complete SharePoint Lists manipulation capability slot. It is a specialized
fork of the broader SharePoint demo and exposes an MCP surface for AI agents that need to discover,
inspect, create, query, update, and delete SharePoint list data through Microsoft Graph.

Use `examples/sharepoint` for the broader Microsoft Graph files/search/auth demo. Use this example when the
demo story is an agent working with SharePoint lists end to end.

## What It Does

- Authenticates the MCP user with Microsoft Entra through `customerAuth.microsoft(...)`.
- Stores the Microsoft refresh token through Noodle's delegated credential broker.
- Calls Microsoft Graph with a short-lived delegated access token for the signed-in user.
- Lets Microsoft Graph and SharePoint enforce the user's effective ACLs.
- Returns `siteId`, `listId`, `columnId`, and `itemId` values so agents can chain follow-up calls.

Tools:

- `sharepoint_list_sites` - search visible SharePoint sites by name.
- `sharepoint_list_lists` - list lists in a site and return `listId` values.
- `sharepoint_get_list` - read metadata for one list.
- `sharepoint_list_columns` - inspect internal column names, types, required/read-only flags, and hidden
  status.
- `sharepoint_create_list` - create a new SharePoint list.
- `sharepoint_add_list_column` - add a column with a Microsoft Graph `columnDefinition`.
- `sharepoint_update_list_column` - patch editable column metadata.
- `sharepoint_delete_list_column` - delete a custom/deletable column.
- `sharepoint_list_items` - list rows with expanded fields.
- `sharepoint_get_list_item` - fetch one row by item id.
- `sharepoint_query_list` - filter rows with a Graph OData `$filter` expression.
- `sharepoint_add_list_item` - add a row using internal column names.
- `sharepoint_update_list_item` - patch row field values using internal column names.
- `sharepoint_delete_list_item` - delete one row by item id.

Resources:

- `sharepoint-lists://whoami` (`whoami`) - Microsoft Graph `/me` profile for the signed-in user.

Prompt:

- `manage_sharepoint_list` - guides the client through site discovery, list discovery, schema inspection,
  and safe row changes.

## Microsoft Entra Setup

Create an Entra app registration for this example:

1. Add a web redirect URI:
   `https://cloud.noodleseed.dev/oauth/customer/microsoft/callback`
2. Add delegated Microsoft Graph scopes:
   - `User.Read`
   - `Sites.Read.All`
   - `Sites.ReadWrite.All`
   - `Sites.Manage.All`
3. Grant admin consent if your tenant requires it.
4. Create a client secret. Do not commit the secret value.

`Sites.Manage.All` is used because list-column creation and schema changes require manage-level delegated
permission in Microsoft Graph. Graph still runs as the signed-in user, so SharePoint ACLs constrain visible
sites, editable lists, row writes, and deletes.

Useful Microsoft references:

- Get list metadata: <https://learn.microsoft.com/en-us/graph/api/list-get>
- Create list: <https://learn.microsoft.com/en-us/graph/api/list-create>
- List columns: <https://learn.microsoft.com/en-us/graph/api/list-list-columns>
- Create list column: <https://learn.microsoft.com/en-us/graph/api/list-post-columns>
- ColumnDefinition resource: <https://learn.microsoft.com/en-us/graph/api/resources/columndefinition>
- Create list item: <https://learn.microsoft.com/en-us/graph/api/listitem-create>
- Update list item fields: <https://learn.microsoft.com/en-us/graph/api/listitem-update>
- Delete list item: <https://learn.microsoft.com/en-us/graph/api/listitem-delete>

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
  --app sharepoint-lists \
  --env prod \
  --value "<tenant-id>"

noodle variables set MICROSOFT_CLIENT_ID \
  --runtime cloud \
  --scope env \
  --org <org> \
  --app sharepoint-lists \
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
  --app sharepoint-lists \
  --env prod \
  --from-env MICROSOFT_CLIENT_SECRET
```

For purely local validation, use the same commands with `--runtime local`; the values are written to the
repo-local `.env.noodle` file, which is ignored by git.

## Run Locally

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
noodle link --org <org> --app sharepoint-lists --env prod
noodle deploy --access customers
```

Connect an OAuth-capable MCP client to the deployed endpoint:

```text
https://cloud.noodleseed.dev/o/<org>/sharepoint-lists/prod/mcp
```

## Demo Flow

In ChatGPT, Gemini Enterprise, or another OAuth-capable MCP client:

1. Read the `whoami` resource to confirm which Microsoft user is connected.
2. Call `sharepoint_list_sites` with a site search term and copy the returned `siteId`.
3. Call `sharepoint_list_lists` with the `siteId` and choose the target `listId`.
4. Call `sharepoint_list_columns` before writing. Use the returned internal `name` values, not display names,
   as keys in `fields`.
5. Call `sharepoint_create_list` to create a demo list when you want a clean sandbox.
6. Call `sharepoint_add_list_column` to add columns such as:
   `{ "name": "Status", "choice": { "choices": ["Open", "Blocked", "Done"] } }`
7. Call `sharepoint_add_list_item` with field values such as:
   `{ "Title": "Launch checklist", "Status": "Open" }`
8. Call `sharepoint_query_list` with a filter such as `fields/Status eq 'Open'`.
9. Call `sharepoint_update_list_item` to patch row fields, for example `{ "Status": "Done" }`.
10. Call `sharepoint_get_list_item` to verify the changed row.
11. Call `sharepoint_delete_list_item` only after confirming the exact `itemId`.
12. Call `sharepoint_delete_list_column` only for custom/deletable columns after inspecting the schema.

## Current Connector Limits

The example uses Microsoft Graph's JSON list APIs. It does not upload file bytes, parse Office/PDF content,
or expose SharePoint permission-management operations. The broader file/search demo remains in
`examples/sharepoint`.

List queries request 200 items at a time with `$top=200`. For larger lists, call the same tool again with the
returned `skipToken`.

## Test

```sh
npm test
```

The tests assert the authored manifest, connector catalog, and pure response summarizers. They do not call
Microsoft Graph or require a real tenant.
