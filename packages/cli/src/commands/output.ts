/**
 * Agent-native output contract for every CLI command.
 *
 * The canonical success and failure envelopes ensure every `--json` command emits one stable,
 * machine-readable shape:
 *
 *   success → { ok: true, data: <T>, warnings?: string[] }
 *   failure → { ok: false, error: { code, message, cause?, fix?, next?, requestId? } }
 *
 * Exit codes are the same taxonomy `serviceFailure()` already returns, named here so new
 * commands and their tests reference the contract instead of magic numbers.
 */

/** Stable CLI exit-code taxonomy (superset-compatible with the existing serviceFailure codes). */
export const EXIT = {
  /** Success. */
  OK: 0,
  /** A domain/runtime failure (the request ran but did not succeed). */
  FAILURE: 1,
  /** Bad arguments, a missing required target, or a headless missing-answer. */
  USAGE: 2,
  /** Authentication/authorization failure (HTTP 401/403). */
  AUTH: 3,
  /** The service could not be reached (network error). */
  UNREACHABLE: 4,
  /** An MCP/tool-call smoke failed (`tools`/`resources`/`prompts`/`test`). */
  MCP: 5,
} as const;

interface JsonOk<T> {
  readonly ok: true;
  readonly data: T;
  readonly warnings?: readonly string[];
}

/**
 * A single per-field/per-issue problem nested under {@link JsonError.errors}. The enrichment fields
 * (`didYouMean`/`suggestions`/`expected`/`got`/`docAnchor`) appear only when the underlying issue offers
 * them, so a repair loop can act on them deterministically. A structural superset of both the compiler's
 * {@link ValidationIssue} and the MCP Apps audit finding, so multi-error commands nest either uniformly.
 */
export interface JsonFieldError {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
  readonly expected?: string;
  readonly got?: string;
  readonly didYouMean?: string;
  readonly suggestions?: readonly string[];
  readonly docAnchor?: string;
}

/**
 * The failure side of the envelope's `error` object. Mirror image of the success side's `data`: one stable,
 * machine-readable shape every `--json` command emits on failure. `errors` nests per-field issues for
 * multi-error commands; `detail` carries an opaque upstream payload (e.g. a raw JSON-RPC error) for debugging.
 */
export interface JsonError {
  readonly code: string;
  readonly message: string;
  readonly cause?: string;
  readonly fix?: string;
  readonly next?: string;
  readonly requestId?: string;
  readonly errors?: readonly JsonFieldError[];
  readonly fixPrompt?: string;
  readonly suggestions?: readonly string[];
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  /** An opaque upstream detail (e.g. the raw JSON-RPC error) kept for agent debugging, never a secret. */
  readonly detail?: unknown;
}

interface JsonFailure {
  readonly ok: false;
  readonly error: JsonError;
}

/** The full `--json` envelope: a success payload or the stable failure shape. */
export type JsonEnvelope<T> = JsonOk<T> | JsonFailure;

/** A machine-actionable next step: an exact command plus why to run it. Emitted inside `data.nextCommands`. */
export interface NextCommand {
  readonly command: string;
  readonly reason: string;
}

interface JsonStreamSnapshot<T> {
  readonly kind: 'snapshot';
  readonly snapshot: T;
}

interface JsonStreamEvent<T> {
  readonly kind: 'event';
  readonly event: T;
}

/** Print the success envelope to stdout. Adds `warnings` only when non-empty (matches the error shape). */
export function printJsonOk<T>(
  data: T,
  warnings?: readonly string[],
  write: (line: string) => void = console.log,
): void {
  const envelope: JsonOk<T> =
    warnings !== undefined && warnings.length > 0
      ? { ok: true, data, warnings }
      : { ok: true, data };
  write(JSON.stringify(envelope));
}

/**
 * Print the failure envelope to stdout and return the exit code. Mirror image of {@link printJsonOk}: every
 * local `--json` command emits `{ ok: false, error }` on failure, and the caller returns the exit code so the
 * command's existing exit taxonomy is preserved.
 */
export function printJsonFailure(
  error: JsonError,
  exitCode = 1,
  write: (line: string) => void = console.log,
): number {
  const envelope: JsonFailure = { ok: false, error };
  write(JSON.stringify(envelope));
  return exitCode;
}

/** Print the initial state for a streaming command as one NDJSON envelope. */
export function printJsonStreamSnapshot<T>(snapshot: T): void {
  printJsonOk<JsonStreamSnapshot<T>>({ kind: 'snapshot', snapshot });
}

/** Print a subsequent streaming record as one NDJSON envelope. */
export function printJsonStreamEvent<T>(event: T): void {
  printJsonOk<JsonStreamEvent<T>>({ kind: 'event', event });
}

/**
 * Print unwrapped JSON only for explicitly human/protocol debugging modes that do not use `--json`.
 * Machine-mode command output must use the envelope or stream helpers above.
 */
export function printRawJsonForHumanDebug(
  value: unknown,
  indentation?: number,
  write: (line: string) => void = console.log,
): void {
  write(JSON.stringify(value, null, indentation));
}
