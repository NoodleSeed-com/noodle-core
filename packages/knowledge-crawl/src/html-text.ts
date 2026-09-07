/**
 * Deliberately small HTML→text extraction for a lexical index: strip non-content blocks and
 * markup, decode the common entities, collapse whitespace. Fetched pages are untrusted input —
 * this reduces them to bounded plain text and nothing here evaluates or resolves anything.
 */

const NON_CONTENT_BLOCKS = /<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_BREAK =
  /<\/?(p|div|li|ul|ol|table|tr|td|th|h[1-6]|br|hr|section|article|header|footer|nav|blockquote|pre)\b[^>]*>/gi;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export function extractHtmlText(html: string): string {
  const withoutBlocks = html.replace(NON_CONTENT_BLOCKS, ' ');
  const withBreaks = withoutBlocks.replace(BLOCK_BREAK, ' ');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

/**
 * The content-extraction seam: (content type, bytes) → indexable `{ html, title, text }`, or
 * `undefined` for media we cannot yet extract. Future formats — PDF is the named next candidate
 * (ADR 0202 deferred triggers) — become one new case here; everything downstream (sealing,
 * revisions, indexing, fusion, citations) is format-agnostic.
 */
export function extractPageContent(
  contentType: string,
  bytes: ArrayBuffer,
): { html: string; title: string; text: string } | undefined {
  if (!contentType.startsWith('text/html')) return undefined;
  const html = new TextDecoder().decode(bytes);
  return { html, title: extractHtmlTitle(html), text: extractHtmlText(html) };
}

export function extractHtmlTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  if (title !== undefined && title.trim() !== '')
    return decodeEntities(title).replace(/\s+/g, ' ').trim();
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  if (heading !== undefined) {
    const text = decodeEntities(heading.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (text !== '') return text;
  }
  return '';
}
