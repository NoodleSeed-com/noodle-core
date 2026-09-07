export interface AssistantEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Per-request options for an MCP App request. `bridge` marks the call's originating surface for
 * attribution (ADR 0220) — a body field: a header would have to join the route's CORS allowlist.
 * `onSuspended` fires when that request parks on an interaction, before its promise can settle: the
 * only way to answer a caller that must not block on a human.
 */
export interface AppRequestOptions {
  readonly bridge?: string;
  onSuspended?(): void;
}

export interface AssistantErrorDetail {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  /**
   * The service's own refusal code, when it sent one — e.g. `daily_turn_budget_exhausted`.
   *
   * Additive beside `code` rather than replacing it: `code` is a published closed union that shipped
   * consumers already switch on, so remapping it would break them. This is how a renderer tells a
   * capacity decision apart from a fault.
   */
  readonly serviceCode?: string;
}

/** A 2xx response that is not one complete, well-formed assistant event stream. */
export class AssistantTransportError extends Error {
  readonly code = 'invalid_response' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AssistantTransportError';
  }
}

/**
 * Consume JSON-bearing server-sent events without buffering the whole assistant turn.
 *
 * `done` is the stream commit marker. It is delivered only after EOF proves that it was the one terminal
 * event, so truncated, duplicate-terminal, and post-terminal responses can never resolve a client turn.
 */
export async function consumeAssistantEvents(
  response: Response,
  onEvent: (event: AssistantEvent) => void,
): Promise<void> {
  const stream = new AssistantEventStream(onEvent);
  if (!response.body) {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw invalidStream('assistant event stream could not be read', error);
    }
    stream.push(text);
    stream.finish(response.headers.get('content-type') ?? '');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw invalidStream('assistant event stream ended unexpectedly', error);
    }

    let chunk: string;
    try {
      chunk = decoder.decode(result.value, { stream: !result.done });
    } catch (error) {
      throw invalidStream('assistant event stream contained invalid UTF-8', error);
    }
    stream.push(chunk);
    if (result.done) break;
  }
  stream.finish(response.headers.get('content-type') ?? '');
}

class AssistantEventStream {
  readonly #onEvent: (event: AssistantEvent) => void;
  #pending = '';
  #terminal: AssistantEvent | undefined;

  constructor(onEvent: (event: AssistantEvent) => void) {
    this.#onEvent = onEvent;
  }

  push(chunk: string): void {
    this.#pending += chunk;
    const protectedCarriageReturn = this.#pending.endsWith('\r');
    const normalizable = protectedCarriageReturn ? this.#pending.slice(0, -1) : this.#pending;
    const frames = normalizeLineEndings(normalizable).split('\n\n');
    this.#pending = `${frames.pop() ?? ''}${protectedCarriageReturn ? '\r' : ''}`;
    for (const frame of frames) this.#acceptFrame(frame);
  }

  finish(contentType: string): void {
    if (this.#pending.trim().length > 0) {
      throw invalidStream('assistant event stream ended with an unterminated frame');
    }
    if (!this.#terminal) {
      throw invalidStream(
        `assistant response did not contain a terminal done event (content-type: ${contentType || 'unknown'})`,
      );
    }
    this.#onEvent(this.#terminal);
  }

  #acceptFrame(frame: string): void {
    const event = parseFrame(frame);
    if (!event) return;
    if (this.#terminal) {
      throw invalidStream('assistant event stream contained an event after done');
    }
    if (event.event === 'done') {
      this.#terminal = event;
      return;
    }
    this.#onEvent(event);
  }
}

function parseFrame(frame: string): AssistantEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  let hasFields = false;
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    hasFields = true;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (!hasFields) return undefined;
  if (!event || data.length === 0) {
    throw invalidStream('assistant event stream contained a malformed frame');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch (error) {
    throw invalidStream('assistant event stream contained malformed JSON', error);
  }
  if (event === 'done' && !isValidDonePayload(parsed)) {
    throw invalidStream('assistant event stream contained an invalid done event');
  }
  return { event, data: isRecord(parsed) ? parsed : { value: parsed } };
}

function normalizeLineEndings(input: string): string {
  return input.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function isValidDonePayload(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    (value.turnId === undefined || (typeof value.turnId === 'string' && value.turnId.length > 0))
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidStream(message: string, cause?: unknown): AssistantTransportError {
  return new AssistantTransportError(message, cause === undefined ? undefined : { cause });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
