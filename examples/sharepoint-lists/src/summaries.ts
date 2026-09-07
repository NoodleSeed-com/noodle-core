export type SharePointListSummary = {
  listId: string;
  name: string;
  displayName?: string;
  webUrl?: string;
  template?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
};

export type SharePointColumnSummary = {
  columnId: string;
  name: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  indexed?: boolean;
  readOnly?: boolean;
  required?: boolean;
  type?: string;
  definition?: unknown;
};

export type SharePointListItemSummary = {
  siteId?: string;
  listId?: string;
  itemId: string;
  name?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  columns: Record<string, unknown>;
};

type SummaryInput = {
  kind: string;
  value?: unknown;
  columns?: unknown[];
};

type ComputeHost = {
  callOperation?: (name: string, args: Readonly<Record<string, unknown>>) => unknown;
};

export function runSharePointListsCompute(
  input: SummaryInput,
  _host?: ComputeHost,
): { result: unknown } {
  function asArrayLocal(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    return [];
  }
  function asRecordLocal(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }
  function stringValueLocal(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  function copyStringLocal(
    source: Record<string, unknown> | undefined,
    target: Record<string, unknown>,
    key: string,
  ): void {
    const value = stringValueLocal(source?.[key]);
    if (value) target[key] = value;
  }
  function copyBooleanLocal(
    source: Record<string, unknown> | undefined,
    target: Record<string, unknown>,
    key: string,
  ): void {
    const value = source?.[key];
    if (typeof value === 'boolean') target[key] = value;
  }
  function columnTypeLocal(column: Record<string, unknown>): string | undefined {
    for (const key of [
      'boolean',
      'calculated',
      'choice',
      'currency',
      'dateTime',
      'lookup',
      'number',
      'personOrGroup',
      'text',
      'term',
      'hyperlinkOrPicture',
      'thumbnail',
    ]) {
      if (column[key] !== undefined) return key;
    }
    return stringValueLocal(column.type);
  }
  function stripODataLocal(record: Record<string, unknown> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record ?? {})) {
      if (!key.startsWith('@odata.')) out[key] = value;
    }
    return out;
  }
  function skipTokenFromNextLinkLocal(nextLink: string): string | undefined {
    const match = /[?&]\$skiptoken=([^&]+)/.exec(nextLink);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }
  function summarizeSitesLocal(rawSitesOrHits: unknown): Array<{
    siteId: string;
    name: string;
    webUrl?: string;
  }> {
    const summaries: Array<{ siteId: string; name: string; webUrl?: string }> = [];
    for (const entry of asArrayLocal(rawSitesOrHits)) {
      const resource = asRecordLocal(entry)?.resource ?? entry;
      const site = asRecordLocal(resource);
      const siteId = stringValueLocal(site?.id);
      const name = stringValueLocal(site?.displayName) ?? stringValueLocal(site?.name);
      if (!siteId || !name) continue;
      const summary: { siteId: string; name: string; webUrl?: string } = { siteId, name };
      const webUrl = stringValueLocal(site?.webUrl);
      if (webUrl) summary.webUrl = webUrl;
      summaries.push(summary);
    }
    return summaries;
  }
  function summarizeListLocal(rawList: unknown): SharePointListSummary | undefined {
    const list = asRecordLocal(rawList);
    const listId = stringValueLocal(list?.id);
    const name = stringValueLocal(list?.name) ?? stringValueLocal(list?.displayName);
    if (!listId || !name) return undefined;
    const summary: SharePointListSummary = { listId, name };
    copyStringLocal(list, summary, 'displayName');
    copyStringLocal(list, summary, 'webUrl');
    copyStringLocal(list, summary, 'createdDateTime');
    copyStringLocal(list, summary, 'lastModifiedDateTime');
    const listInfo = asRecordLocal(list?.list);
    const template = stringValueLocal(listInfo?.template);
    if (template) summary.template = template;
    return summary;
  }
  function summarizeListsLocal(rawLists: unknown): SharePointListSummary[] {
    const summaries: SharePointListSummary[] = [];
    for (const value of asArrayLocal(rawLists)) {
      const summary = summarizeListLocal(value);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }
  function summarizeColumnLocal(rawColumn: unknown): SharePointColumnSummary | undefined {
    const column = asRecordLocal(rawColumn);
    const columnId = stringValueLocal(column?.id);
    const name = stringValueLocal(column?.name);
    if (!columnId || !name) return undefined;
    const summary: SharePointColumnSummary = { columnId, name };
    copyStringLocal(column, summary, 'displayName');
    copyStringLocal(column, summary, 'description');
    copyBooleanLocal(column, summary, 'hidden');
    copyBooleanLocal(column, summary, 'indexed');
    copyBooleanLocal(column, summary, 'readOnly');
    copyBooleanLocal(column, summary, 'required');
    const type = columnTypeLocal(column);
    if (type) summary.type = type;
    summary.definition = rawColumn;
    return summary;
  }
  function summarizeColumnsLocal(rawColumns: unknown): SharePointColumnSummary[] {
    const summaries: SharePointColumnSummary[] = [];
    for (const value of asArrayLocal(rawColumns)) {
      const summary = summarizeColumnLocal(value);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }
  function summarizeListItemLocal(rawItem: unknown): SharePointListItemSummary | undefined {
    const item = asRecordLocal(rawItem);
    const itemId = stringValueLocal(item?.id);
    if (!itemId) return undefined;
    const fields = stripODataLocal(asRecordLocal(item?.fields));
    const summary: SharePointListItemSummary = { itemId, columns: fields };
    const ids = asRecordLocal(item?.sharepointIds);
    const siteId = stringValueLocal(ids?.siteId);
    const listId = stringValueLocal(ids?.listId);
    if (siteId) summary.siteId = siteId;
    if (listId) summary.listId = listId;
    const name =
      stringValueLocal(fields.Title) ??
      stringValueLocal(fields.LinkTitle) ??
      stringValueLocal(fields.Name);
    if (name) summary.name = name;
    copyStringLocal(item, summary, 'webUrl');
    copyStringLocal(item, summary, 'createdDateTime');
    copyStringLocal(item, summary, 'lastModifiedDateTime');
    return summary;
  }
  function summarizeListItemsLocal(rawItems: unknown): SharePointListItemSummary[] {
    const summaries: SharePointListItemSummary[] = [];
    for (const value of asArrayLocal(rawItems)) {
      const summary = summarizeListItemLocal(value);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }
  function summarizeListItemsPageLocal(rawPage: unknown): {
    items: SharePointListItemSummary[];
    nextLink?: string;
    skipToken?: string;
  } {
    const page = asRecordLocal(rawPage);
    const result: {
      items: SharePointListItemSummary[];
      nextLink?: string;
      skipToken?: string;
    } = { items: summarizeListItemsLocal(page?.value) };
    const nextLink = stringValueLocal(page?.['@odata.nextLink']);
    if (nextLink) {
      result.nextLink = nextLink;
      const token = skipTokenFromNextLinkLocal(nextLink);
      if (token) result.skipToken = token;
    }
    return result;
  }
  function normalizeCreateListColumnsLocal(columns: unknown[] | undefined): {
    columns?: unknown[];
  } {
    if (!Array.isArray(columns) || columns.length === 0) return {};
    return {
      columns: columns.map((column) => {
        if (typeof column === 'string') return { name: column, text: {} };
        return column;
      }),
    };
  }

  switch (input.kind) {
    case 'sites':
      return { result: summarizeSitesLocal(input.value) };
    case 'lists':
      return { result: summarizeListsLocal(input.value) };
    case 'list':
      return { result: summarizeListLocal(input.value) };
    case 'columns':
      return { result: summarizeColumnsLocal(input.value) };
    case 'column':
      return { result: summarizeColumnLocal(input.value) };
    case 'list_items_page':
      return { result: summarizeListItemsPageLocal(input.value) };
    case 'list_item':
      return { result: summarizeListItemLocal(input.value) };
    case 'create_list_columns':
      return { result: normalizeCreateListColumnsLocal(input.columns) };
    default:
      return { result: input.value };
  }
}

export function summarizeSites(rawSitesOrHits: unknown): Array<{
  siteId: string;
  name: string;
  webUrl?: string;
}> {
  const summaries: Array<{ siteId: string; name: string; webUrl?: string }> = [];
  for (const entry of asArray(rawSitesOrHits)) {
    const resource = asRecord(entry)?.resource ?? entry;
    const site = asRecord(resource);
    const siteId = stringValue(site?.id);
    const name = stringValue(site?.displayName) ?? stringValue(site?.name);
    if (!siteId || !name) continue;
    const summary: { siteId: string; name: string; webUrl?: string } = { siteId, name };
    const webUrl = stringValue(site?.webUrl);
    if (webUrl) summary.webUrl = webUrl;
    summaries.push(summary);
  }
  return summaries;
}

export function summarizeLists(rawLists: unknown): SharePointListSummary[] {
  const summaries: SharePointListSummary[] = [];
  for (const value of asArray(rawLists)) {
    const summary = summarizeList(value);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

export function summarizeList(rawList: unknown): SharePointListSummary | undefined {
  const list = asRecord(rawList);
  const listId = stringValue(list?.id);
  const name = stringValue(list?.name) ?? stringValue(list?.displayName);
  if (!listId || !name) return undefined;
  const summary: SharePointListSummary = { listId, name };
  copyString(list, summary, 'displayName');
  copyString(list, summary, 'webUrl');
  copyString(list, summary, 'createdDateTime');
  copyString(list, summary, 'lastModifiedDateTime');
  const listInfo = asRecord(list?.list);
  const template = stringValue(listInfo?.template);
  if (template) summary.template = template;
  return summary;
}

export function summarizeColumns(rawColumns: unknown): SharePointColumnSummary[] {
  const summaries: SharePointColumnSummary[] = [];
  for (const value of asArray(rawColumns)) {
    const summary = summarizeColumn(value);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

export function summarizeColumn(rawColumn: unknown): SharePointColumnSummary | undefined {
  const column = asRecord(rawColumn);
  const columnId = stringValue(column?.id);
  const name = stringValue(column?.name);
  if (!columnId || !name) return undefined;
  const summary: SharePointColumnSummary = { columnId, name };
  copyString(column, summary, 'displayName');
  copyString(column, summary, 'description');
  copyBoolean(column, summary, 'hidden');
  copyBoolean(column, summary, 'indexed');
  copyBoolean(column, summary, 'readOnly');
  copyBoolean(column, summary, 'required');
  const type = columnType(column);
  if (type) summary.type = type;
  summary.definition = rawColumn;
  return summary;
}

export function summarizeListItemsPage(rawPage: unknown): {
  items: SharePointListItemSummary[];
  nextLink?: string;
  skipToken?: string;
} {
  const page = asRecord(rawPage);
  const result: {
    items: SharePointListItemSummary[];
    nextLink?: string;
    skipToken?: string;
  } = { items: summarizeListItems(page?.value) };
  const nextLink = stringValue(page?.['@odata.nextLink']);
  if (nextLink) {
    result.nextLink = nextLink;
    const token = skipTokenFromNextLink(nextLink);
    if (token) result.skipToken = token;
  }
  return result;
}

export function summarizeListItems(rawItems: unknown): SharePointListItemSummary[] {
  const summaries: SharePointListItemSummary[] = [];
  for (const value of asArray(rawItems)) {
    const summary = summarizeListItem(value);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

export function summarizeListItem(rawItem: unknown): SharePointListItemSummary | undefined {
  const item = asRecord(rawItem);
  const itemId = stringValue(item?.id);
  if (!itemId) return undefined;
  const fields = stripOData(asRecord(item?.fields));
  const summary: SharePointListItemSummary = {
    itemId,
    columns: fields,
  };
  const ids = asRecord(item?.sharepointIds);
  const siteId = stringValue(ids?.siteId);
  const listId = stringValue(ids?.listId);
  if (siteId) summary.siteId = siteId;
  if (listId) summary.listId = listId;
  const name =
    stringValue(fields.Title) ?? stringValue(fields.LinkTitle) ?? stringValue(fields.Name);
  if (name) summary.name = name;
  copyString(item, summary, 'webUrl');
  copyString(item, summary, 'createdDateTime');
  copyString(item, summary, 'lastModifiedDateTime');
  return summary;
}

export function normalizeCreateListColumns(columns: unknown[] | undefined): {
  columns?: unknown[];
} {
  if (!Array.isArray(columns) || columns.length === 0) return {};
  return {
    columns: columns.map((column) => {
      if (typeof column === 'string') return { name: column, text: {} };
      return column;
    }),
  };
}

function columnType(column: Record<string, unknown>): string | undefined {
  for (const key of [
    'boolean',
    'calculated',
    'choice',
    'currency',
    'dateTime',
    'lookup',
    'number',
    'personOrGroup',
    'text',
    'term',
    'hyperlinkOrPicture',
    'thumbnail',
  ]) {
    if (column[key] !== undefined) return key;
  }
  return stringValue(column.type);
}

function skipTokenFromNextLink(nextLink: string): string | undefined {
  const match = /[?&]\$skiptoken=([^&]+)/.exec(nextLink);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function stripOData(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (!key.startsWith('@odata.')) out[key] = value;
  }
  return out;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function copyString(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = stringValue(source?.[key]);
  if (value) target[key] = value;
}

function copyBoolean(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source?.[key];
  if (typeof value === 'boolean') target[key] = value;
}
