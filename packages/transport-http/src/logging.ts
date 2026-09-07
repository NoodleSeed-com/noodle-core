/**
 * Minimal structured (JSON-line) logging for the runtime front-door + deploy plane (Slice 27, ADR 0031).
 *
 * A precursor to full OpenTelemetry (ADR 0024, Phase 4); it shares that decision's **hard redaction**
 * intent but pulls in no dependency. Safety is structural: every record is a **flat bag of scalars**
 * built by hand from an allowlist at the call site, and non-scalar values are dropped to `[unloggable]`
 * — so a stray token-bearing object can never be stringified into a line, and no call site ever logs a
 * header map, request body, secret, bearer token, or continuation token.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A flat bag of **pre-redacted scalar** fields. Never pass raw secrets, tokens, headers, or bodies. */
export interface LogFields {
  readonly [key: string]: unknown;
}

/** Destination for a finished log line. */
export type LogSink = (line: string) => void;

/** Writes one compact JSON line + `\n` to stdout. Do not use for MCP stdio transport. */
export const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/** Writes one compact JSON line + `\n` to stderr. Safe for MCP stdio transport diagnostics. */
export const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

export interface LoggerOptions {
  /** Minimum level to emit; lower levels are dropped. Default `info`. */
  readonly level?: LogLevel;
  /** Where lines go. Default {@link stdoutSink}. */
  readonly sink?: LogSink;
  /** Clock for the `ts` field (injectable for deterministic tests). Default `Date.now`. */
  readonly clock?: () => number;
  /** Static fields merged into every record (e.g. a service name). */
  readonly base?: LogFields;
}

export interface Logger {
  readonly level: LogLevel;
  log(level: LogLevel, event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger with extra base fields (e.g. a per-request id) merged in. */
  child(extra: LogFields): Logger;
}

/** Keys the record owns; a field may not overwrite them. */
const RESERVED = new Set(['ts', 'level', 'event']);
const SENSITIVE_FIELD =
  /(?:authorization|bearer|body|continuation|credential|header|password|secret|token)/i;

/** Coerce a field value to a loggable scalar; anything non-scalar becomes a marker (never serialized). */
function scalar(key: string, value: unknown): string | number | boolean {
  if (SENSITIVE_FIELD.test(key)) return '[redacted]';
  if (value === null || value === undefined) return '';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value as string | number | boolean;
  }
  return '[unloggable]';
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? stdoutSink;
  const clock = options.clock ?? Date.now;
  const base = options.base ?? {};

  function emit(lvl: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const record: Record<string, string | number | boolean> = {
      ts: new Date(clock()).toISOString(),
      level: lvl,
      event,
    };
    for (const [key, value] of Object.entries(base)) {
      if (!RESERVED.has(key) && value !== undefined) record[key] = scalar(key, value);
    }
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (!RESERVED.has(key) && value !== undefined) record[key] = scalar(key, value);
      }
    }
    sink(JSON.stringify(record));
  }

  return {
    level,
    log: emit,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (extra) => createLogger({ level, sink, clock, base: { ...base, ...extra } }),
  };
}

const noop = (): void => undefined;

/** A logger that drops everything — the default so opting out (and existing callers) cost nothing. */
export const noopLogger: Logger = {
  level: 'error',
  log: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => noopLogger,
};
