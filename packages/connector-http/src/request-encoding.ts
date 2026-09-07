const FORM_BODY_TYPE_ERROR = 'form-urlencoded request body must be a plain object';
const FORM_FIELD_TYPE_ERROR = 'form-urlencoded request field must be JSON-compatible';

export type HttpRequestEncoding = 'json' | 'form-urlencoded';

export function requestPayload(
  encoding: HttpRequestEncoding | undefined,
  body: (() => unknown) | undefined,
): string | URLSearchParams | undefined {
  if (body === undefined) return undefined;
  const value = body();
  return encoding === 'form-urlencoded' ? formUrlEncodedBody(value) : JSON.stringify(value);
}

export function setOwnedHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name) delete headers[existing];
  }
  headers[name] = value;
}

/** Encode one evaluated request map with WHATWG application/x-www-form-urlencoded semantics. */
function formUrlEncodedBody(value: unknown): URLSearchParams {
  if (!isPlainObject(value)) throw new TypeError(FORM_BODY_TYPE_ERROR);

  const params = new URLSearchParams();
  for (const [name, field] of Object.entries(value)) {
    if (field === undefined) continue;
    params.append(name, formFieldValue(field));
  }
  return params;
}

function formFieldValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(FORM_FIELD_TYPE_ERROR);
    return String(value);
  }
  if (typeof value !== 'object') throw new TypeError(FORM_FIELD_TYPE_ERROR);

  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError(FORM_FIELD_TYPE_ERROR);
    return encoded;
  } catch {
    throw new TypeError(FORM_FIELD_TYPE_ERROR);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
