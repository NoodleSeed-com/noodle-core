import type { AssistantClientContext } from './client.js';
import { type AssistantPageContext, copyAssistantPageContext } from './model-context.js';

const PAGE_MARKDOWN_MAX_BYTES = 12 * 1024;
const PAGE_MARKDOWN_TIMEOUT_MS = 2_000;

type PageSnapshot = {
  readonly page: {
    readonly url: string;
    readonly contentType?: 'text/markdown';
    readonly content?: string;
    readonly truncated?: true;
  };
};

/** Resolve untrusted presentation hints without making them part of verified user or page context. */
export function browserClientContext(): AssistantClientContext {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // Older or restricted browsers may not expose an IANA timezone; the service falls back safely.
  }
  const locale = globalThis.navigator?.language;
  return {
    ...(locale ? { locale } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
}

/** The current same-origin document identity, without ephemeral query or fragment state. */
export function browserPageUrl(): string | undefined {
  try {
    const location = globalThis.location;
    if (!location) return undefined;
    const url = new URL(location.href);
    if (url.origin === 'null') return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Read the optional Markdown representation of a public page. This is untrusted per-turn context, not
 * a document scraper: safe-URL failures fall back to the URL alone, and an unsafe URL yields no context.
 */
export async function browserPageContext(url: string): Promise<AssistantPageContext | undefined> {
  let urlOnly: AssistantPageContext;
  try {
    urlOnly = copyAssistantPageContext({ page: { url } });
  } catch {
    // A canonical URL can itself look credential-shaped. Never fetch, retain, or forward it.
    return undefined;
  }
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), PAGE_MARKDOWN_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/markdown' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (!response.ok || !isSameOrigin(response, url) || !isMarkdown(response)) return urlOnly;
    const { content, truncated } = await readBoundedUtf8(response);
    const page: PageSnapshot = {
      page: {
        url,
        contentType: 'text/markdown',
        content,
        ...(truncated ? { truncated: true } : {}),
      },
    };
    return copyAssistantPageContext(page);
  } catch {
    // `copyAssistantPageContext` rejects credential-shaped content through the one shared boundary.
    return urlOnly;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function isSameOrigin(response: Response, url: string): boolean {
  try {
    return response.url !== '' && new URL(response.url).origin === new URL(url).origin;
  } catch {
    return false;
  }
}

function isMarkdown(response: Response): boolean {
  return (
    response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/markdown'
  );
}

async function readBoundedUtf8(
  response: Response,
): Promise<{ content: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Markdown response has no readable body');
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = PAGE_MARKDOWN_MAX_BYTES - byteLength;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { content: decodeUtf8(bytes, truncated), truncated };
}

function decodeUtf8(bytes: Uint8Array, truncated: boolean): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let content: string;
  try {
    content = decoder.decode(bytes, { stream: true });
  } catch {
    throw new Error('Markdown response is not valid UTF-8');
  }
  try {
    return content + decoder.decode();
  } catch {
    if (truncated) return content;
    throw new Error('Markdown response is not valid UTF-8');
  }
}
