import type { InvocationClientHint, InvocationClientLocationHint } from './handler.js';
import { rpcMethod } from './request-capture.js';

const OPENAI_USER_LOCATION_META_KEY = 'openai/userLocation';
const MAX_LOCATION_TEXT_LENGTH = 160;

/**
 * Project host-specific request metadata into the small, host-neutral hint accepted by the resolver.
 * Raw metadata never crosses this adapter boundary.
 */
export function invocationClientHint(parsed: unknown): InvocationClientHint | undefined {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls = items.filter((item) => rpcMethod(item) === 'tools/call');
  if (calls.length === 0) return undefined;

  const locations = calls.map(locationFromToolCall);
  if (locations.some((location) => location === undefined)) return undefined;
  const first = locations[0];
  if (first === undefined) return undefined;
  const signature = JSON.stringify(first);
  if (locations.some((location) => JSON.stringify(location) !== signature)) return undefined;
  return { location: first };
}

function locationFromToolCall(value: unknown): InvocationClientLocationHint | undefined {
  if (!isRecord(value) || !isRecord(value.params) || !isRecord(value.params._meta)) {
    return undefined;
  }
  const raw = value.params._meta[OPENAI_USER_LOCATION_META_KEY];
  if (!isRecord(raw)) return undefined;

  const latitude = boundedCoordinate(raw.latitude, -90, 90);
  const longitude = boundedCoordinate(raw.longitude, -180, 180);
  if (latitude === undefined || longitude === undefined) return undefined;

  const city = boundedText(raw.city);
  const region = boundedText(raw.region);
  const country = boundedText(raw.country);
  const timeZone = canonicalTimeZone(raw.timezone);
  return {
    latitude,
    longitude,
    ...(city === undefined ? {} : { city }),
    ...(region === undefined ? {} : { region }),
    ...(country === undefined ? {} : { country }),
    ...(timeZone === undefined ? {} : { timeZone }),
  };
}

function boundedCoordinate(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_LOCATION_TEXT_LENGTH ||
    containsControlCharacter(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function canonicalTimeZone(value: unknown): string | undefined {
  const timeZone = boundedText(value);
  if (timeZone === undefined) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
