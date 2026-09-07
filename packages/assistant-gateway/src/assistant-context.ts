import type { RuntimeArtifact } from '@noodle-borg/compiler';
import {
  type CallerIdentity,
  type ExecuteDeps,
  executeAmbientContext,
  type InvocationContext,
  type InvocationContextPreferenceSource,
  type InvocationLocationContext,
} from '@noodle-borg/runtime';
import { toolTouchesDelegatedAuth } from './assistant-delegated-projection.js';

export interface AssistantContextPreferences {
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
}

interface ResolveInvocationContextInput {
  readonly instant: Date;
  readonly applicationPreference?: AssistantContextPreferences;
  readonly clientHint?: AssistantContextPreferences;
  readonly defaults?: AssistantContextPreferences;
}

export type AssistantContextPreferencesResult =
  | { readonly ok: true; readonly value: AssistantContextPreferences }
  | { readonly ok: false };

const PLATFORM_DEFAULTS = { locale: 'en-US', timeZone: 'UTC' } as const;

/** Resolve presentation preferences independently from server-authoritative time. */
export function resolveInvocationContext(input: ResolveInvocationContextInput): InvocationContext {
  if (!Number.isFinite(input.instant.getTime())) throw new RangeError('invalid invocation instant');
  const locale = resolvePreference(input, 'locale', canonicalLocale, PLATFORM_DEFAULTS.locale);
  const timeZone = resolvePreference(
    input,
    'timeZone',
    canonicalTimeZone,
    PLATFORM_DEFAULTS.timeZone,
  );
  const parts = localParts(input.instant, timeZone.value);
  return {
    temporal: {
      instant: input.instant.toISOString(),
      localDate: `${parts.year}-${parts.month}-${parts.day}`,
      localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
      utcOffset: offsetFromPart(parts.timeZoneName),
      weekday: parts.weekday,
      timeZone: timeZone.value,
      locale: locale.value,
      source: { locale: locale.source, timeZone: timeZone.source },
    },
    ambientStatus: 'not_configured',
  };
}

/** Stable temporal grounding line shared by normal turns and interaction continuations. */
export function invocationContextSystemMessage(context: InvocationContext): string {
  const temporal = context.temporal;
  return (
    `Current server time: ${temporal.instant}. User-local date and time: ` +
    `${temporal.localDate} ${temporal.localTime} ${temporal.utcOffset} ` +
    `(${temporal.weekday}, ${temporal.timeZone}; locale ${temporal.locale}).`
  );
}

/** Validate and canonicalize a backend-supplied preference object at the session boundary. */
export function parseAssistantContextPreferences(
  value: unknown,
): AssistantContextPreferencesResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).some((key) => key !== 'locale' && key !== 'timeZone')) {
    return { ok: false };
  }
  const result: { locale?: string; timeZone?: string } = {};
  if (record.locale !== undefined) {
    if (typeof record.locale !== 'string' || record.locale.length > 160) return { ok: false };
    const locale = canonicalLocale(record.locale);
    if (locale === undefined) return { ok: false };
    result.locale = locale;
  }
  if (record.timeZone !== undefined) {
    if (typeof record.timeZone !== 'string' || record.timeZone.length > 160) return { ok: false };
    const timeZone = canonicalTimeZone(record.timeZone);
    if (timeZone === undefined) return { ok: false };
    result.timeZone = timeZone;
  }
  return { ok: true, value: result };
}

export function isAssistantVerifiedClaims(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean | null>> {
  return isBoundedScalarRecord(value, 64, 240);
}

export function isAssistantPageContext(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean | null>> {
  return isBoundedScalarRecord(value, 80, 2_000);
}

function isBoundedScalarRecord(value: unknown, keyLimit: number, stringLimit: number): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([key, item]) =>
        key.length <= keyLimit &&
        (item === null ||
          typeof item === 'number' ||
          typeof item === 'boolean' ||
          (typeof item === 'string' && item.length <= stringLimit)),
    )
  );
}

function resolvePreference(
  input: ResolveInvocationContextInput,
  field: keyof AssistantContextPreferences,
  canonicalize: (value: string) => string | undefined,
  platformDefault: string,
): { readonly value: string; readonly source: InvocationContextPreferenceSource } {
  const candidates: readonly {
    readonly value: string | undefined;
    readonly source: InvocationContextPreferenceSource;
  }[] = [
    { value: input.applicationPreference?.[field], source: 'user-preference' },
    { value: input.clientHint?.[field], source: 'client-hint' },
    { value: input.defaults?.[field], source: 'server-default' },
    { value: platformDefault, source: 'platform-default' },
  ];
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;
    const canonical = canonicalize(candidate.value);
    if (canonical !== undefined) return { value: canonical, source: candidate.source };
  }
  // The platform defaults are compile-time constants validated by the same canonicalizers.
  throw new Error(`invalid platform ${field} default`);
}

function canonicalLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    return undefined;
  }
}

function canonicalTimeZone(value: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

interface LocalDateTimeParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  readonly weekday: string;
  readonly timeZoneName: string;
}

function localParts(instant: Date, timeZone: string): LocalDateTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    timeZoneName: 'longOffset',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  ) as Readonly<Record<string, string>>;
  const required = [
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'second',
    'weekday',
    'timeZoneName',
  ] as const;
  if (required.some((key) => parts[key] === undefined)) {
    throw new RangeError('unable to resolve local date and time');
  }
  return parts as unknown as LocalDateTimeParts;
}

function offsetFromPart(value: string | undefined): string {
  if (value === 'GMT' || value === 'UTC') return '+00:00';
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(value ?? '');
  if (!match?.[1]) throw new RangeError(`unsupported timezone offset ${value ?? 'unknown'}`);
  return match[1];
}

interface ResolveAssistantInvocationContextInput {
  readonly artifact: RuntimeArtifact;
  readonly executeDeps: ExecuteDeps;
  readonly caller?: CallerIdentity;
  readonly instant: Date;
  readonly applicationPreference?: AssistantContextPreferences;
  readonly clientHint?: AssistantContextPreferences;
  readonly clientLocationHint?: Omit<InvocationLocationContext, 'source'>;
}

/** Resolve one immutable snapshot, including a schema-validated read-only ambient provider. */
export async function resolveInvocationContextSnapshot(
  input: ResolveAssistantInvocationContextInput,
): Promise<InvocationContext> {
  const callerPreference = {
    ...(input.caller?.locale ? { locale: input.caller.locale } : {}),
    ...(input.caller?.timeZone ? { timeZone: input.caller.timeZone } : {}),
    ...(input.applicationPreference ?? {}),
  };
  const clientHint = {
    ...(input.clientLocationHint?.timeZone === undefined
      ? {}
      : { timeZone: input.clientLocationHint.timeZone }),
    ...(input.clientHint ?? {}),
  };
  const temporal = resolveInvocationContext({
    instant: input.instant,
    ...(Object.keys(callerPreference).length > 0
      ? { applicationPreference: callerPreference }
      : {}),
    ...(Object.keys(clientHint).length === 0 ? {} : { clientHint }),
    ...(input.artifact.server.context?.defaults
      ? { defaults: input.artifact.server.context.defaults }
      : {}),
  });
  const context: InvocationContext = {
    ...temporal,
    ...(input.clientLocationHint === undefined
      ? {}
      : { location: { ...input.clientLocationHint, source: 'client-hint' } }),
  };
  const ambient = input.artifact.server.context?.ambient;
  if (!ambient) return context;

  // An anonymous principal can never satisfy a delegated-auth fulfilment: the broker exchange
  // is guaranteed to fail, so skip the doomed round trip instead of paying it every turn.
  if (input.caller?.identityKind === 'anonymous') {
    const delegatedKeys = (
      input.executeDeps.broker as {
        readonly assistantDelegatedAuthKeys?: () => ReadonlySet<string>;
      }
    ).assistantDelegatedAuthKeys?.();
    if (
      delegatedKeys !== undefined &&
      delegatedKeys.size > 0 &&
      toolTouchesDelegatedAuth(ambient, delegatedKeys)
    ) {
      return { ...context, ambientStatus: 'unavailable' };
    }
  }

  const result = await executeAmbientContext(input.artifact, {
    ...input.executeDeps,
    ...(input.caller ? { caller: input.caller } : {}),
    context,
  });
  if (!result.ok) return { ...context, ambientStatus: 'unavailable' };
  return { ...context, ambientStatus: 'available', ambient: result.output };
}
