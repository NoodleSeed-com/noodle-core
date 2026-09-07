export type SharePointSiteSummary = {
  siteId: string;
  name: string;
  webUrl?: string;
};

export type SharePointDriveItemSummary = {
  siteId?: string;
  driveId?: string;
  parentItemId?: string;
  itemId: string;
  name: string;
  webUrl?: string;
  downloadUrl?: string;
  size?: number;
  mimeType?: string;
  lastModifiedDateTime?: string;
  itemType: 'file' | 'folder' | 'item';
};

export type SharePointDriveSummary = {
  driveId: string;
  name: string;
  webUrl?: string;
  driveType?: string;
};

export type SharePointListSummary = {
  listId: string;
  name: string;
  displayName?: string;
  webUrl?: string;
  template?: string;
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

export type SharePointFileMetadataSummary = SharePointDriveItemSummary & {
  textExtractionStatus: 'download_url_only';
  textUnavailableReason: string;
};

export type SharePointSearchHitSummary =
  | ({ resourceType: 'site'; hitId?: string; summary?: string } & SharePointSiteSummary)
  | ({ resourceType: 'driveItem'; hitId?: string; summary?: string } & SharePointDriveItemSummary)
  | ({ resourceType: 'listItem'; hitId?: string; summary?: string } & SharePointListItemSummary)
  | {
      resourceType: 'unknown';
      hitId?: string;
      summary?: string;
      itemId?: string;
      name?: string;
      webUrl?: string;
    };

const TEXT_EXTRACTION_UNAVAILABLE =
  'This metadata tool does not extract text. Use sharepoint_read_file_content for small text-like files, ' +
  'or use downloadUrl with a dedicated binary/text extraction connector for Office, PDF, spreadsheet, ' +
  'image, media, or larger files.';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function valuesFromPage(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return Array.isArray(record?.value) ? record.value : [];
}

export function columnsFromFields(fields: unknown): Record<string, unknown> {
  const rawFields = asRecord(fields) ?? {};
  const columns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawFields)) {
    if (key.startsWith('@odata.')) continue;
    columns[key] = value;
  }
  return columns;
}

export function sharePointBrowserDownloadUrl(webUrl: string | undefined): string | undefined {
  if (webUrl === undefined) return undefined;
  if (!/^https?:\/\//i.test(webUrl)) return undefined;
  const hashIndex = webUrl.indexOf('#');
  const base = hashIndex === -1 ? webUrl : webUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : webUrl.slice(hashIndex);
  if (/[?&]download=/.test(base)) return webUrl;
  return `${base}${base.includes('?') ? '&' : '?'}download=1${hash}`;
}

export function summarizeSiteResource(resource: unknown): SharePointSiteSummary | undefined {
  const site = asRecord(resource);
  if (site === undefined) return undefined;
  const siteId = stringValue(site.id);
  if (siteId === undefined) return undefined;
  const name =
    stringValue(site.displayName) ?? stringValue(site.name) ?? stringValue(site.webUrl) ?? siteId;
  const webUrl = stringValue(site.webUrl);
  return webUrl === undefined ? { siteId, name } : { siteId, name, webUrl };
}

export function summarizeSharePointSites(rawSitesOrHits: unknown): SharePointSiteSummary[] {
  const rawSites = valuesFromPage(rawSitesOrHits);
  const summaries: SharePointSiteSummary[] = [];
  const seenSiteIds = new Set<string>();

  for (const item of rawSites) {
    const hit = asRecord(item);
    const summary = summarizeSiteResource(hit?.resource ?? item);
    if (summary === undefined || seenSiteIds.has(summary.siteId)) continue;
    seenSiteIds.add(summary.siteId);
    summaries.push(summary);
  }
  return summaries;
}

export function summarizeSharePointDriveItems(
  rawItemsOrPage: unknown,
): SharePointDriveItemSummary[] {
  const rawItems = valuesFromPage(rawItemsOrPage);
  const summaries: SharePointDriveItemSummary[] = [];

  for (const item of rawItems) {
    const driveItem = asRecord(item);
    const remoteItem = asRecord(driveItem?.remoteItem);
    const itemId = stringValue(driveItem?.id) ?? stringValue(remoteItem?.id);
    const name = stringValue(driveItem?.name) ?? stringValue(remoteItem?.name);
    if (driveItem === undefined || itemId === undefined || name === undefined) continue;

    const file = asRecord(driveItem.file) ?? asRecord(remoteItem?.file);
    const folder = asRecord(driveItem.folder) ?? asRecord(remoteItem?.folder);
    const parentReference =
      asRecord(driveItem.parentReference) ?? asRecord(remoteItem?.parentReference);
    const declaredItemType = stringValue(driveItem.itemType) ?? stringValue(remoteItem?.itemType);
    const graphDownloadUrl =
      stringValue(driveItem['@microsoft.graph.downloadUrl']) ??
      stringValue(driveItem.downloadUrl) ??
      stringValue(remoteItem?.['@microsoft.graph.downloadUrl']) ??
      stringValue(remoteItem?.downloadUrl);
    const itemType = folder ? 'folder' : file || declaredItemType === 'file' ? 'file' : 'item';
    const webUrl = stringValue(driveItem.webUrl) ?? stringValue(remoteItem?.webUrl);
    const downloadUrl =
      graphDownloadUrl ?? (itemType === 'file' ? sharePointBrowserDownloadUrl(webUrl) : undefined);
    const summary: SharePointDriveItemSummary = { itemId, name, itemType };

    const siteId = stringValue(parentReference?.siteId);
    const driveId = stringValue(parentReference?.driveId);
    const parentItemId = stringValue(parentReference?.id);
    const size = numberValue(driveItem.size) ?? numberValue(remoteItem?.size);
    const mimeType =
      stringValue(file?.mimeType) ??
      stringValue(driveItem.mimeType) ??
      stringValue(remoteItem?.mimeType);
    const lastModifiedDateTime =
      stringValue(driveItem.lastModifiedDateTime) ?? stringValue(remoteItem?.lastModifiedDateTime);
    if (siteId !== undefined) summary.siteId = siteId;
    if (driveId !== undefined) summary.driveId = driveId;
    if (parentItemId !== undefined) summary.parentItemId = parentItemId;
    if (webUrl !== undefined) summary.webUrl = webUrl;
    if (downloadUrl !== undefined) summary.downloadUrl = downloadUrl;
    if (size !== undefined) summary.size = size;
    if (mimeType !== undefined) summary.mimeType = mimeType;
    if (lastModifiedDateTime !== undefined) summary.lastModifiedDateTime = lastModifiedDateTime;
    summaries.push(summary);
  }
  return summaries;
}

export function summarizeSharePointDrives(rawDrivesOrPage: unknown): SharePointDriveSummary[] {
  const rawDrives = valuesFromPage(rawDrivesOrPage);
  const summaries: SharePointDriveSummary[] = [];

  for (const item of rawDrives) {
    const drive = asRecord(item);
    const driveId = stringValue(drive?.id);
    if (drive === undefined || driveId === undefined) continue;
    const name = stringValue(drive.name) ?? driveId;
    const summary: SharePointDriveSummary = { driveId, name };
    const webUrl = stringValue(drive.webUrl);
    const driveType = stringValue(drive.driveType);
    if (webUrl !== undefined) summary.webUrl = webUrl;
    if (driveType !== undefined) summary.driveType = driveType;
    summaries.push(summary);
  }
  return summaries;
}

export function summarizeSharePointLists(rawListsOrPage: unknown): SharePointListSummary[] {
  const rawLists = valuesFromPage(rawListsOrPage);
  const summaries: SharePointListSummary[] = [];

  for (const item of rawLists) {
    const list = asRecord(item);
    const listId = stringValue(list?.id);
    if (list === undefined || listId === undefined) continue;
    const name = stringValue(list.displayName) ?? stringValue(list.name) ?? listId;
    const summary: SharePointListSummary = { listId, name };
    const displayName = stringValue(list.displayName);
    const webUrl = stringValue(list.webUrl);
    const listInfo = asRecord(list.list);
    const template = stringValue(listInfo?.template);
    if (displayName !== undefined) summary.displayName = displayName;
    if (webUrl !== undefined) summary.webUrl = webUrl;
    if (template !== undefined) summary.template = template;
    summaries.push(summary);
  }
  return summaries;
}

export function summarizeSharePointListItems(rawItemsOrPage: unknown): SharePointListItemSummary[] {
  const rawItems = valuesFromPage(rawItemsOrPage);
  const summaries: SharePointListItemSummary[] = [];

  for (const item of rawItems) {
    const listItem = asRecord(item);
    const itemId = stringValue(listItem?.id);
    if (listItem === undefined || itemId === undefined) continue;
    const fields = asRecord(listItem.fields);
    const sharepointIds = asRecord(listItem.sharepointIds);
    const columns = columnsFromFields(fields);
    const summary: SharePointListItemSummary = { itemId, columns };
    const siteId = stringValue(sharepointIds?.siteId);
    const listId = stringValue(sharepointIds?.listId);
    const name =
      stringValue(fields?.Title) ?? stringValue(fields?.LinkTitle) ?? stringValue(listItem.name);
    const webUrl = stringValue(listItem.webUrl);
    const createdDateTime = stringValue(listItem.createdDateTime);
    const lastModifiedDateTime = stringValue(listItem.lastModifiedDateTime);
    if (siteId !== undefined) summary.siteId = siteId;
    if (listId !== undefined) summary.listId = listId;
    if (name !== undefined) summary.name = name;
    if (webUrl !== undefined) summary.webUrl = webUrl;
    if (createdDateTime !== undefined) summary.createdDateTime = createdDateTime;
    if (lastModifiedDateTime !== undefined) summary.lastModifiedDateTime = lastModifiedDateTime;
    summaries.push(summary);
  }
  return summaries;
}

export function summarizeSharePointFileMetadata(rawItem: unknown): SharePointFileMetadataSummary {
  const item = summarizeSharePointDriveItems([rawItem])[0] ?? {
    itemId: stringValue(asRecord(rawItem)?.id) ?? '',
    name: stringValue(asRecord(rawItem)?.name) ?? '',
    itemType: 'item' as const,
  };
  return {
    ...item,
    textExtractionStatus: 'download_url_only',
    textUnavailableReason: TEXT_EXTRACTION_UNAVAILABLE,
  };
}

export function summarizeSharePointSearchHits(
  rawHitsOrPage: unknown,
): SharePointSearchHitSummary[] {
  const rawHits = valuesFromPage(rawHitsOrPage);
  const summaries: SharePointSearchHitSummary[] = [];

  for (const item of rawHits) {
    const hit = asRecord(item);
    const resource = asRecord(hit?.resource ?? item);
    if (resource === undefined) continue;
    const typeName = stringValue(resource['@odata.type']) ?? '';
    const hitId = stringValue(hit?.hitId);
    const hitSummary = stringValue(hit?.summary);
    const common = {
      ...(hitId === undefined ? {} : { hitId }),
      ...(hitSummary === undefined ? {} : { summary: hitSummary }),
    };

    if (typeName.includes('site')) {
      const site = summarizeSiteResource(resource);
      if (site !== undefined) summaries.push({ resourceType: 'site', ...common, ...site });
      continue;
    }
    if (typeName.includes('driveItem')) {
      const driveItem = summarizeSharePointDriveItems([resource])[0];
      if (driveItem !== undefined) {
        summaries.push({ resourceType: 'driveItem', ...common, ...driveItem });
      }
      continue;
    }
    if (typeName.includes('listItem')) {
      const listItem = summarizeSharePointListItems([resource])[0];
      if (listItem !== undefined) {
        summaries.push({ resourceType: 'listItem', ...common, ...listItem });
      }
      continue;
    }

    summaries.push({
      resourceType: 'unknown',
      ...common,
      ...(stringValue(resource.id) === undefined ? {} : { itemId: stringValue(resource.id) }),
      ...(stringValue(resource.name) === undefined ? {} : { name: stringValue(resource.name) }),
      ...(stringValue(resource.webUrl) === undefined
        ? {}
        : { webUrl: stringValue(resource.webUrl) }),
    });
  }
  return summaries;
}

export function runSharePointSummaryCompute(
  input: Record<string, unknown>,
  host?: {
    readonly callOperation?: (name: string, args: Readonly<Record<string, unknown>>) => unknown;
  },
): { result: unknown } {
  const asObject = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const values = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    const record = asObject(value);
    return Array.isArray(record?.value) ? record.value : [];
  };
  const columns = (fields: unknown): Record<string, unknown> => {
    const raw = asObject(fields) ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!key.startsWith('@odata.')) out[key] = value;
    }
    return out;
  };
  const browserDownload = (webUrl: string | undefined): string | undefined => {
    if (webUrl === undefined || !/^https?:\/\//i.test(webUrl)) return undefined;
    const hashIndex = webUrl.indexOf('#');
    const base = hashIndex === -1 ? webUrl : webUrl.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : webUrl.slice(hashIndex);
    if (/[?&]download=/.test(base)) return webUrl;
    return `${base}${base.includes('?') ? '&' : '?'}download=1${hash}`;
  };
  const maxTextContentBytes = 1_048_576;
  const isTextLike = (name: string | undefined, mimeType: string | undefined): boolean => {
    const lowerMime = (mimeType ?? '').toLowerCase();
    if (lowerMime.startsWith('text/')) return true;
    if (
      [
        'application/json',
        'application/ld+json',
        'application/xml',
        'application/xhtml+xml',
        'application/javascript',
        'application/x-javascript',
        'application/typescript',
        'application/x-yaml',
        'application/yaml',
        'application/csv',
      ].includes(lowerMime)
    ) {
      return true;
    }
    const lowerName = (name ?? '').toLowerCase();
    return /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html|htm|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|cs|c|cc|cpp|h|hpp|php|sql|yaml|yml|toml|ini|env|log|sh|bash|zsh|ps1)$/i.test(
      lowerName,
    );
  };
  const pageInfo = (page: unknown): Record<string, unknown> => {
    const nextLink = str(asObject(page)?.['@odata.nextLink']);
    if (nextLink === undefined) return {};
    const match = /[?&]\$skiptoken=([^&]+)/i.exec(nextLink);
    return {
      nextLink,
      ...(match?.[1] === undefined ? {} : { skipToken: decodeURIComponent(match[1]) }),
    };
  };
  const tokenFromNextLink = (nextLink: string | undefined): string | undefined => {
    if (nextLink === undefined) return undefined;
    const match = /[?&]\$skiptoken=([^&]+)/i.exec(nextLink);
    return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
  };
  const site = (resource: unknown): Record<string, unknown> | undefined => {
    const item = asObject(resource);
    const siteId = str(item?.id);
    if (item === undefined || siteId === undefined) return undefined;
    const webUrl = str(item.webUrl);
    return {
      siteId,
      name: str(item.displayName) ?? str(item.name) ?? webUrl ?? siteId,
      ...(webUrl === undefined ? {} : { webUrl }),
    };
  };
  const driveItems = (raw: unknown): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const value of values(raw)) {
      const item = asObject(value);
      const remoteItem = asObject(item?.remoteItem);
      const itemId = str(item?.id) ?? str(remoteItem?.id);
      const name = str(item?.name) ?? str(remoteItem?.name);
      if (item === undefined || itemId === undefined || name === undefined) continue;
      const file = asObject(item.file) ?? asObject(remoteItem?.file);
      const folder = asObject(item.folder) ?? asObject(remoteItem?.folder);
      const parent = asObject(item.parentReference) ?? asObject(remoteItem?.parentReference);
      const declaredItemType = str(item.itemType) ?? str(remoteItem?.itemType);
      const itemType = folder ? 'folder' : file || declaredItemType === 'file' ? 'file' : 'item';
      const webUrl = str(item.webUrl) ?? str(remoteItem?.webUrl);
      const graphDownload =
        str(item['@microsoft.graph.downloadUrl']) ??
        str(item.downloadUrl) ??
        str(remoteItem?.['@microsoft.graph.downloadUrl']) ??
        str(remoteItem?.downloadUrl);
      const downloadUrl =
        graphDownload ?? (itemType === 'file' ? browserDownload(webUrl) : undefined);
      const row: Record<string, unknown> = { itemId, name, itemType };
      for (const [key, value] of Object.entries({
        siteId: str(parent?.siteId),
        driveId: str(parent?.driveId),
        parentItemId: str(parent?.id),
        webUrl,
        downloadUrl,
        size: num(item.size) ?? num(remoteItem?.size),
        mimeType: str(file?.mimeType) ?? str(item.mimeType) ?? str(remoteItem?.mimeType),
        lastModifiedDateTime:
          str(item.lastModifiedDateTime) ?? str(remoteItem?.lastModifiedDateTime),
      })) {
        if (value !== undefined) row[key] = value;
      }
      out.push(row);
    }
    return out;
  };
  const drives = (raw: unknown): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const value of values(raw)) {
      const drive = asObject(value);
      const driveId = str(drive?.id);
      if (drive === undefined || driveId === undefined) continue;
      const row: Record<string, unknown> = {
        driveId,
        name: str(drive.name) ?? driveId,
      };
      for (const [key, value] of Object.entries({
        webUrl: str(drive.webUrl),
        driveType: str(drive.driveType),
      })) {
        if (value !== undefined) row[key] = value;
      }
      out.push(row);
    }
    return out;
  };
  const listItems = (raw: unknown): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const value of values(raw)) {
      const item = asObject(value);
      const itemId = str(item?.id);
      if (item === undefined || itemId === undefined) continue;
      const fields = asObject(item.fields);
      const ids = asObject(item.sharepointIds);
      const row: Record<string, unknown> = { itemId, columns: columns(fields) };
      for (const [key, value] of Object.entries({
        siteId: str(ids?.siteId),
        listId: str(ids?.listId),
        name: str(fields?.Title) ?? str(fields?.LinkTitle) ?? str(item.name),
        webUrl: str(item.webUrl),
        createdDateTime: str(item.createdDateTime),
        lastModifiedDateTime: str(item.lastModifiedDateTime),
      })) {
        if (value !== undefined) row[key] = value;
      }
      out.push(row);
    }
    return out;
  };
  const summarize = (): { result: unknown } => {
    const kind = String(input.kind);
    if (kind === 'sites') {
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const value of values(input.value)) {
        const hit = asObject(value);
        const row = site(hit?.resource ?? value);
        const siteId = str(row?.siteId);
        if (row === undefined || siteId === undefined || seen.has(siteId)) continue;
        seen.add(siteId);
        out.push(row);
      }
      return { result: out };
    }
    if (kind === 'drive_items') return { result: driveItems(input.value) };
    if (kind === 'drive_item') return { result: driveItems([input.value])[0] ?? {} };
    if (kind === 'drives') return { result: drives(input.value) };
    if (kind === 'list_items') return { result: listItems(input.value) };
    if (kind === 'list_item') return { result: listItems([input.value])[0] ?? {} };
    if (kind === 'list_items_page') {
      return { result: { items: listItems(input.value), ...pageInfo(input.value) } };
    }
    if (kind === 'lists') {
      const out: Record<string, unknown>[] = [];
      for (const value of values(input.value)) {
        const list = asObject(value);
        const listId = str(list?.id);
        if (list === undefined || listId === undefined) continue;
        const listInfo = asObject(list.list);
        const row: Record<string, unknown> = {
          listId,
          name: str(list.displayName) ?? str(list.name) ?? listId,
        };
        for (const [key, value] of Object.entries({
          displayName: str(list.displayName),
          webUrl: str(list.webUrl),
          template: str(listInfo?.template),
        })) {
          if (value !== undefined) row[key] = value;
        }
        out.push(row);
      }
      return { result: out };
    }
    if (kind === 'file_metadata') {
      return {
        result: {
          ...(driveItems([input.value])[0] ?? {}),
          textExtractionStatus: 'download_url_only',
          textUnavailableReason:
            'This metadata tool does not extract text. Use sharepoint_read_file_content for small text-like files, or use downloadUrl with a dedicated binary/text extraction connector for Office, PDF, spreadsheet, image, media, or larger files.',
        },
      };
    }
    if (kind === 'search_hits') {
      const out: Record<string, unknown>[] = [];
      for (const value of values(input.value)) {
        const hit = asObject(value);
        const resource = asObject(hit?.resource ?? value);
        if (resource === undefined) continue;
        const typeName = str(resource['@odata.type']) ?? '';
        const common = {
          ...(str(hit?.hitId) === undefined ? {} : { hitId: str(hit?.hitId) }),
          ...(str(hit?.summary) === undefined ? {} : { summary: str(hit?.summary) }),
        };
        if (typeName.includes('site')) {
          const row = site(resource);
          if (row !== undefined) out.push({ resourceType: 'site', ...common, ...row });
        } else if (typeName.includes('driveItem')) {
          const row = driveItems([resource])[0];
          if (row !== undefined) out.push({ resourceType: 'driveItem', ...common, ...row });
        } else if (typeName.includes('listItem')) {
          const row = listItems([resource])[0];
          if (row !== undefined) out.push({ resourceType: 'listItem', ...common, ...row });
        } else {
          out.push({
            resourceType: 'unknown',
            ...common,
            ...(str(resource.id) === undefined ? {} : { itemId: str(resource.id) }),
            ...(str(resource.name) === undefined ? {} : { name: str(resource.name) }),
            ...(str(resource.webUrl) === undefined ? {} : { webUrl: str(resource.webUrl) }),
          });
        }
      }
      return { result: out };
    }
    return { result: input.value };
  };

  if (input.kind !== undefined) return summarize();

  if (input.driveId !== undefined && input.itemId !== undefined && input.mode === undefined) {
    const driveId = str(input.driveId);
    const itemId = str(input.itemId);
    const callOperation = host?.callOperation;
    if (driveId === undefined || itemId === undefined || callOperation === undefined) {
      return {
        result: {
          driveId: driveId ?? '',
          itemId: itemId ?? '',
          readStatus: 'metadata_unavailable',
          content: '',
          contentEncoding: 'utf-8',
          maxBytes: maxTextContentBytes,
          warning: 'driveId, itemId, and callOperation are required to read file content.',
        },
      };
    }

    const metadata = callOperation('get_drive_item_metadata', { driveId, itemId }) as {
      item?: unknown;
    };
    const file = driveItems([metadata.item])[0] ?? {};
    const name = str(file.name);
    const mimeType = str(file.mimeType);
    const size = num(file.size);
    const baseResult: Record<string, unknown> = {
      driveId,
      itemId,
      name,
      webUrl: str(file.webUrl),
      downloadUrl: str(file.downloadUrl),
      mimeType,
      size,
      content: '',
      contentEncoding: 'utf-8',
      maxBytes: maxTextContentBytes,
    };
    for (const key of Object.keys(baseResult)) {
      if (baseResult[key] === undefined) delete baseResult[key];
    }

    if (metadata.item === undefined) {
      return {
        result: {
          ...baseResult,
          readStatus: 'metadata_unavailable',
          warning: 'Microsoft Graph did not return file metadata, so content was not requested.',
        },
      };
    }
    if (size !== undefined && size > maxTextContentBytes) {
      return {
        result: {
          ...baseResult,
          readStatus: 'too_large',
          warning:
            'The file is larger than the 1 MiB text-response cap. Use downloadUrl with a binary/text extraction connector instead.',
        },
      };
    }
    if (!isTextLike(name, mimeType)) {
      return {
        result: {
          ...baseResult,
          readStatus: 'unsupported_binary',
          warning:
            'The file does not look like a text format. Microsoft Graph /content returns bytes; use downloadUrl with a binary/text extraction connector for this file.',
        },
      };
    }

    try {
      const response = callOperation('get_drive_item_content', { driveId, itemId }) as {
        content?: unknown;
      };
      return {
        result: {
          ...baseResult,
          readStatus: 'read',
          content: str(response.content) ?? '',
          warning:
            'Microsoft Graph /content returns file bytes; this tool decoded the response as UTF-8 text.',
        },
      };
    } catch {
      return {
        result: {
          ...baseResult,
          readStatus: 'content_unavailable',
          warning:
            'The file looked text-like, but Microsoft Graph /content could not be read through the current connector. Use downloadUrl as a fallback.',
        },
      };
    }
  }

  const mode = String(input.mode);
  const siteId = str(input.siteId);
  const driveId = str(input.driveId);
  const parentItemId = str(input.parentItemId);
  const listId = str(input.listId);
  const skipToken = str(input.skipToken) ?? tokenFromNextLink(str(input.nextLink));
  const pageArgs = skipToken === undefined ? {} : { $skiptoken: skipToken };
  const callOperation = host?.callOperation;
  if (callOperation === undefined) {
    return {
      result: { mode, items: [], warning: 'callOperation is required for list_items mode' },
    };
  }

  if (mode === 'list') {
    if (siteId === undefined || listId === undefined) {
      return {
        result: { mode, items: [], warning: 'siteId and listId are required for list mode' },
      };
    }
    const response = callOperation('list_list_items', { siteId, listId, ...pageArgs }) as {
      page?: unknown;
    };
    return {
      result: {
        mode,
        siteId,
        listId,
        items: listItems(response.page),
        ...pageInfo(response.page),
      },
    };
  }
  if (driveId !== undefined && parentItemId !== undefined) {
    const response = callOperation('list_drive_children', {
      driveId,
      itemId: parentItemId,
      ...pageArgs,
    }) as { page?: unknown };
    return {
      result: {
        mode: 'drive',
        driveId,
        parentItemId,
        items: driveItems(response.page),
        ...pageInfo(response.page),
      },
    };
  }
  if (driveId !== undefined) {
    const response = callOperation('list_drive_root', { driveId, ...pageArgs }) as {
      page?: unknown;
    };
    return {
      result: {
        mode: 'drive',
        driveId,
        items: driveItems(response.page),
        ...pageInfo(response.page),
      },
    };
  }
  if (siteId === undefined) {
    return {
      result: {
        mode: 'drive',
        items: [],
        warning: 'siteId or driveId is required for drive mode',
      },
    };
  }
  const response =
    parentItemId === undefined
      ? (callOperation('list_site_drive_root', { siteId, ...pageArgs }) as { page?: unknown })
      : (callOperation('list_site_drive_children', {
          siteId,
          itemId: parentItemId,
          ...pageArgs,
        }) as { page?: unknown });
  return {
    result: {
      mode: 'drive',
      siteId,
      ...(parentItemId === undefined ? {} : { parentItemId }),
      items: driveItems(response.page),
      ...pageInfo(response.page),
    },
  };
}
