/**
 * Deterministic readers for typed collection controls (ADR 0240 decision 5). A correctly typed value
 * is read here and never reaches a model; the same rules validate whatever a model does return.
 */
export type ParsedControl = 'email' | 'phone' | 'url';
export interface ParsedSpan {
  readonly control: ParsedControl;
  /** Normalised value: lowercase domain or host, `+` and digits for phones, https for bare hosts. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
const ABSOLUTE_URL = /https?:\/\/[^\s<>"'`]+/gi;
const BARE_HOST = /(?<![\w@./-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[^\s<>"'`]*)?/g;
/** Plain digit runs with the separators people type; at least seven digits (dates match: accepted). */
const PHONE = /\+?\(?\d[\d\s().-]{5,}\d/g;
const URL_TRAILING = /[.,;:!?)\]]+$/;
const HOST = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{2,5})?$/;
/** Bare tokens ending in a file extension are attachments people mention, not websites. */
const FILE_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'txt',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'zip',
  'mp3',
  'mp4',
]);
const SCAN_ORDER: readonly ParsedControl[] = ['email', 'url', 'phone'];

function normaliseEmail(raw: string): string | undefined {
  const match = raw.match(EMAIL);
  if (match?.length !== 1 || match[0] !== raw) return undefined;
  const at = raw.lastIndexOf('@');
  return `${raw.slice(0, at)}@${raw.slice(at + 1).toLowerCase()}`;
}
function normalisePhone(raw: string): string | undefined {
  if (!/^\+?[\d\s().-]+$/.test(raw)) return undefined;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return undefined;
  return `${raw.startsWith('+') ? '+' : ''}${digits}`;
}
function normaliseUrl(raw: string): string | undefined {
  const trimmed = raw.replace(URL_TRAILING, '');
  const absolute = /^https?:\/\//i.test(trimmed);
  const candidate = absolute ? trimmed : `https://${trimmed}`;
  const parts = /^(https?):\/\/([^/?#\s]+)(.*)$/i.exec(candidate);
  const scheme = parts?.[1];
  const rawHost = parts?.[2];
  if (scheme === undefined || rawHost === undefined || !HOST.test(rawHost)) return undefined;
  const host = rawHost.toLowerCase();
  if (!absolute && FILE_EXTENSIONS.has(host.slice(host.lastIndexOf('.') + 1))) return undefined;
  return `${scheme.toLowerCase()}://${host}${parts?.[3] ?? ''}`;
}

/** Validate and normalise one whole value with the control's rules; `undefined` means not that type. */
export function normaliseTypedValue(control: ParsedControl, raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) return undefined;
  if (control === 'email') return normaliseEmail(value);
  if (control === 'phone') return normalisePhone(value);
  return normaliseUrl(value);
}

function matches(text: string, control: ParsedControl): { start: number; end: number }[] {
  const patterns =
    control === 'email' ? [EMAIL] : control === 'url' ? [ABSOLUTE_URL, BARE_HOST] : [PHONE];
  const found: { start: number; end: number }[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = control === 'url' ? match[0].replace(URL_TRAILING, '') : match[0];
      if (raw.length > 0) found.push({ start: match.index, end: match.index + raw.length });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/**
 * Every candidate of the requested controls, in text order. Emails claim their span before URLs and
 * URLs before phones, so digits inside an address are never read as a number.
 */
export function scanTypedValues(
  text: string,
  controls: readonly ParsedControl[],
): readonly ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  for (const control of SCAN_ORDER) {
    if (!controls.includes(control)) continue;
    for (const { start, end } of matches(text, control)) {
      if (spans.some((span) => start < span.end && end > span.start)) continue;
      const value = normaliseTypedValue(control, text.slice(start, end));
      if (value !== undefined) spans.push({ control, value, start, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Replace each span with the caller's placeholder; used before any utterance reaches a model. */
export function redactSpans(
  text: string,
  spans: readonly ParsedSpan[],
  placeholder: (span: ParsedSpan) => string,
): string {
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, span.start) + placeholder(span);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
