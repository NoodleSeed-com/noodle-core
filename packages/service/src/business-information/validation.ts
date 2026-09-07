import { type JsonObject, type JsonValue, MANAGED_RETENTION_DAYS } from './contracts.js';

export const MAX_PAYLOAD_BYTES = 32 * 1024;
export const MAX_PAYLOAD_DEPTH = 6;
export const MAX_PAYLOAD_PROPERTIES = 128;
export const MAX_PAYLOAD_STRING_LENGTH = 4096;
export const MAX_PAYLOAD_ARRAY_ITEMS = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_EXPORT_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_RETENTION_DAYS = 30;

export class PayloadValidationError extends Error {
  constructor(
    readonly code:
      | 'invalid_json'
      | 'payload_too_large'
      | 'payload_too_deep'
      | 'too_many_properties'
      | 'string_too_long'
      | 'array_too_large'
      | 'prohibited_field'
      | 'payment_card_value'
      | 'credential_value'
      | 'government_id_value'
      | 'health_biometric_value',
    message: string,
  ) {
    super(message);
    this.name = 'PayloadValidationError';
  }
}

export class CursorValidationError extends Error {
  constructor(message = 'cursor is invalid') {
    super(message);
    this.name = 'CursorValidationError';
  }
}

const PROHIBITED_FIELD_PATTERNS: readonly RegExp[] = [
  /^(?:card_?number|credit_?card|debit_?card|pan|cvv|cvc|card_?expiry)$/i,
  /(?:password|passwd|passcode|secret|api_?key|access_?token|refresh_?token|authorization)/i,
  /(?:ssn|social_?security|national_?id|government_?id|passport|driver.?s?_?licen[cs]e)/i,
  /(?:health|medical|diagnosis|patient|biometric|fingerprint|faceprint|voiceprint)/i,
];

const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{8,}\b/,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/i,
];

const GOVERNMENT_ID_VALUE_PATTERNS: readonly RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:SSN|social security|national ID|passport number|driver'?s? licen[cs]e)\s*[:#-]\s*\S+/i,
];

const HEALTH_BIOMETRIC_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:medical record|patient record|diagnosis|biometric template|fingerprint template|faceprint|voiceprint)\s*[:#-]/i,
];

export function validateManagedPayload(value: unknown): JsonObject {
  if (!isPlainObject(value)) {
    throw new PayloadValidationError('invalid_json', 'managed payload must be a JSON object');
  }
  let properties = 0;
  const validated = validateValue(value, '$', 1, () => {
    properties += 1;
    if (properties > MAX_PAYLOAD_PROPERTIES) {
      throw new PayloadValidationError(
        'too_many_properties',
        `managed payload exceeds ${MAX_PAYLOAD_PROPERTIES} properties`,
      );
    }
  }) as JsonObject;
  const encoded = Buffer.byteLength(JSON.stringify(validated), 'utf8');
  if (encoded > MAX_PAYLOAD_BYTES) {
    throw new PayloadValidationError(
      'payload_too_large',
      `managed payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  return structuredClone(validated);
}

function validateValue(
  value: unknown,
  path: string,
  depth: number,
  countProperty: () => void,
): JsonValue {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new PayloadValidationError(
      'payload_too_deep',
      `managed payload exceeds depth ${MAX_PAYLOAD_DEPTH}`,
    );
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PayloadValidationError('invalid_json', `${path} must be a finite JSON number`);
    }
    return value;
  }
  if (typeof value === 'string') {
    validateString(value, path);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PAYLOAD_ARRAY_ITEMS) {
      throw new PayloadValidationError(
        'array_too_large',
        `${path} exceeds ${MAX_PAYLOAD_ARRAY_ITEMS} array items`,
      );
    }
    return value.map((entry, index) =>
      validateValue(entry, `${path}[${index}]`, depth + 1, countProperty),
    );
  }
  if (!isPlainObject(value)) {
    throw new PayloadValidationError('invalid_json', `${path} contains a non-JSON value`);
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    countProperty();
    if (key.length === 0 || key.length > 64) {
      throw new PayloadValidationError('invalid_json', `${path} contains an invalid property name`);
    }
    if (PROHIBITED_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new PayloadValidationError('prohibited_field', `${path}.${key} is a prohibited field`);
    }
    result[key] = validateValue(entry, `${path}.${key}`, depth + 1, countProperty);
  }
  return result;
}

function validateString(value: string, path: string): void {
  if (value.length > MAX_PAYLOAD_STRING_LENGTH) {
    throw new PayloadValidationError(
      'string_too_long',
      `${path} exceeds ${MAX_PAYLOAD_STRING_LENGTH} string characters`,
    );
  }
  if (looksLikePaymentCard(value)) {
    throw new PayloadValidationError('payment_card_value', `${path} contains payment card data`);
  }
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new PayloadValidationError('credential_value', `${path} contains credential data`);
  }
  if (GOVERNMENT_ID_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new PayloadValidationError('government_id_value', `${path} contains government ID data`);
  }
  if (HEALTH_BIOMETRIC_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new PayloadValidationError(
      'health_biometric_value',
      `${path} contains health or biometric data`,
    );
  }
}

function looksLikePaymentCard(value: string): boolean {
  const candidates = value.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateScalar(label: string, value: string, maximum = 128): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} must be between 1 and ${maximum} single-line characters`);
  }
  return normalized;
}

export function validateEmail(value: string): string {
  const normalized = validateScalar('business grant email', value, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('business grant email is invalid');
  }
  return normalized;
}

export function validateScope<
  T extends { org: string; app: string; env: string; installationId: string },
>(scope: T): T {
  validateSlug('organization', scope.org);
  validateSlug('app', scope.app);
  validateSlug('environment', scope.env);
  validateSlug('installation', scope.installationId);
  return scope;
}

export function validateSlug(label: string, value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new Error(`${label} must be a lowercase slug`);
  }
  return value;
}

export function validateRetentionDays(value: number | undefined): 7 | 30 | 90 {
  const resolved = value ?? DEFAULT_RETENTION_DAYS;
  if (!MANAGED_RETENTION_DAYS.includes(resolved as 7 | 30 | 90)) {
    throw new Error('retentionDays must be 7, 30, or 90');
  }
  return resolved as 7 | 30 | 90;
}

export function boundedPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

export function boundedExportPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPORT_PAGE_SIZE) {
    throw new Error(`limit must be an integer between 1 and ${MAX_EXPORT_PAGE_SIZE}`);
  }
  return value;
}

export function validateRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer');
  }
  return value;
}
