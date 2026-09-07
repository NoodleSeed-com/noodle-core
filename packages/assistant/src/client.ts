import { type AssistantChatState, AssistantChatStateStore } from './chat-state.js';
import type {
  AssistantClient,
  AssistantClientContext,
  AssistantContext,
  AssistantInteractionResponse,
  AssistantSessionResponse,
  CreateAssistantClientOptions,
} from './client-contract.js';
import {
  type AssistantClientError,
  clientError,
  parseSession,
  readStableErrorCode,
  refusalCode,
  UNRETRYABLE_SERVICE_CODES,
} from './client-errors.js';
import {
  appInteractionStopped,
  appToolResult,
  authorizedHeaders,
  parseAppInteraction,
} from './client-request-helpers.js';
import { type AssistantClientEvent, toAssistantClientEvent } from './events.js';
import {
  type AssistantJsonValue,
  type AssistantModelContextUpdate,
  type AssistantPageContext,
  copyAssistantModelContext,
  copyAssistantPageContext,
} from './model-context.js';
import {
  type AssistantSessionSource,
  resolveSessionSource,
  sessionSourceKey,
} from './session-source.js';
import {
  type AppRequestOptions,
  type AssistantErrorDetail,
  AssistantTransportError,
  consumeAssistantEvents,
} from './transport.js';
import { visitorIdForSource } from './visitor-id.js';

const CONTINUATION_MESSAGE = 'Continued securely with your account.';

export type {
  AssistantChatError,
  AssistantChatState,
  AssistantConfirmationData,
  AssistantContinuationData,
  AssistantInputRequestData,
  AssistantInteractionStatus,
  AssistantToolResultData,
  AssistantUIDataTypes,
  AssistantUIMessage,
  AssistantViewData,
} from './chat-state.js';
export type * from './client-contract.js';
export { AssistantClientError } from './client-errors.js';
export type {
  AssistantClientEvent,
  AssistantClientLifecycleEvent,
  AssistantContentDetail,
  AssistantContentEvent,
  AssistantDoneEvent,
  AssistantErrorEvent,
  AssistantErrorEventDetail,
  AssistantInputRequestedDetail,
  AssistantInputRequestedEvent,
  AssistantInteractionResolvedDetail,
  AssistantInteractionResolvedEvent,
  AssistantSuggestedPromptsDetail,
  AssistantSuggestedPromptsEvent,
  AssistantToolCompletedDetail,
  AssistantToolCompletedEvent,
  AssistantToolProposedDetail,
  AssistantToolProposedEvent,
  AssistantToolStartedDetail,
  AssistantToolStartedEvent,
  AssistantUnrecognizedEvent,
  AssistantViewAvailableDetail,
  AssistantViewAvailableEvent,
} from './events.js';
export type {
  AssistantJsonValue,
  AssistantModelContextUpdate,
  AssistantPageContext,
} from './model-context.js';

interface PendingAppInteraction {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

class DefaultAssistantClient<TPageContext extends AssistantPageContext>
  implements AssistantClient<TPageContext>
{
  readonly #source: AssistantSessionSource;
  readonly #fetch: typeof fetch;
  readonly #listeners = new Set<(event: AssistantClientEvent) => void>();
  readonly #chat = new AssistantChatStateStore();
  readonly #clientContext:
    | AssistantClientContext
    | (() => AssistantClientContext | undefined)
    | undefined;
  #pageContext: TPageContext | (() => TPageContext | undefined) | undefined;
  #session: AssistantSessionResponse | undefined;
  #context: AssistantContext | undefined;
  #modelContext: AssistantModelContextUpdate | undefined;
  #active: AbortController | undefined;
  #initialSuggestions:
    | { readonly controller: AbortController; readonly promise: Promise<void> }
    | undefined;
  readonly #pendingAppInteractions = new Map<string, PendingAppInteraction>();

  constructor(options: CreateAssistantClientOptions<TPageContext>) {
    this.#source = resolveSessionSource(options);
    // Some browsers require `window.fetch` to be invoked with its global receiver. Keep the default
    // behind a closure instead of storing the unbound host method; injected test/server fetches remain exact.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#context = options.context ? { ...options.context } : undefined;
    this.#modelContext = options.modelContext
      ? copyAssistantModelContext(options.modelContext)
      : undefined;
    this.#clientContext = options.clientContext;
    this.#pageContext = options.pageContext;
  }

  subscribe(listener: (event: AssistantClientEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeChat(listener: (state: AssistantChatState) => void): () => void {
    return this.#chat.subscribe(listener);
  }

  getChatState(): AssistantChatState {
    return this.#chat.getState();
  }

  /** Whether a session already exists, so a caller can avoid re-entering its loading state. */
  hasSession(): boolean {
    return this.#session !== undefined;
  }

  /** Whether a request holds the single-flight slot, so callers can refuse before mutating UI. */
  isBusy(): boolean {
    return this.#active !== undefined;
  }

  async connect(): Promise<void> {
    if (this.#session) return;
    await this.#singleFlight(async (signal) => {
      if (this.#session) return;
      const session = await this.#createSession(signal);
      // Repaint the visible transcript before anything streams: only the backend-exchanged path —
      // an anonymous embed page holds no token across a navigation, so it never re-attaches. A
      // failure renders as no replay; the session is healthy either way.
      let restoredPendingInteraction = false;
      let continuationEmitted = false;
      const emitContinuation = async (): Promise<void> => {
        if (continuationEmitted) return;
        continuationEmitted = true;
        this.#emit({ event: 'session_continued', data: { message: CONTINUATION_MESSAGE } });
        await this.#chat.flush();
      };
      if (this.#source.kind !== 'public' && session.endpoints.transcript) {
        try {
          restoredPendingInteraction = await this.#replayTranscript(
            session,
            signal,
            emitContinuation,
          );
        } catch {
          // Replay is an enhancement; the assistant still remembers server-side.
        }
      }
      if (session.continuedAfterAuthentication) await emitContinuation();
      // The armed post-sign-in resume: one client attempt, inside the same single-flight so a
      // queued sendMessage cannot race it. A failure never fails connect() — the session is
      // healthy and listeners saw the error event; the hint is never read again.
      if (session.resume && !restoredPendingInteraction) {
        try {
          await this.#runChatOperation(signal, () => this.#resumeTurn(session, signal));
        } catch {
          // Rendered by the emitted events; the conversation continues normally.
        }
      }
    });
  }

  /** Fetch and re-emit the bounded visible transcript through the standard event path. */
  async #replayTranscript(
    session: AssistantSessionResponse,
    signal: AbortSignal,
    emitContinuation: () => Promise<void>,
  ): Promise<boolean> {
    const endpoint = session.endpoints.transcript;
    if (!endpoint) return false;
    const response = await this.#request(
      endpoint,
      {
        method: 'POST',
        headers: authorizedHeaders(session.token, 'application/json'),
        body: '{}',
        signal,
      },
      'turn_failed',
    );
    if (!response.ok) return false;
    const events: AssistantClientEvent[] = [];
    await consumeAssistantEvents(response, (event) => {
      const lifecycle =
        (event.event === 'message_started' && typeof event.data.message === 'string') ||
        (event.event === 'resume_started' && typeof event.data.tool === 'string') ||
        (event.event === 'message_completed' && Object.keys(event.data).length === 0);
      events.push(lifecycle ? (event as AssistantClientEvent) : toAssistantClientEvent(event));
    });
    const visualIndex = events.findIndex(
      (event) =>
        !['message_started', 'resume_started', 'content', 'message_completed'].includes(
          event.event,
        ),
    );
    const continuationAt = visualIndex < 0 ? events.length : visualIndex;
    for (let index = 0; index <= events.length; index += 1) {
      if (session.continuedAfterAuthentication && index === continuationAt) {
        await emitContinuation();
      }
      const event = events[index];
      if (!event) continue;
      if (event.event === 'done') continue;
      this.#emit(event);
      // The chat store consumes each replayed turn through the same async UIMessage stream as a
      // live one; flushing at each turn boundary keeps the synchronous replay from outrunning it.
      if (
        event.event === 'message_completed' ||
        event.event === 'view_available' ||
        event.event === 'tool_proposed' ||
        event.event === 'input_requested'
      ) {
        await this.#chat.flush();
      }
    }
    return events.some(
      (event) => event.event === 'tool_proposed' || event.event === 'input_requested',
    );
  }

  /** POST the one-shot resume trigger; a 409 means nothing was pending, which renders as silence. */
  async #resumeTurn(session: AssistantSessionResponse, signal: AbortSignal): Promise<void> {
    const response = await this.#request(
      session.endpoints.turns,
      {
        method: 'POST',
        headers: authorizedHeaders(session.token, 'text/event-stream'),
        body: JSON.stringify({
          resume: true,
          ...(session.endpoints.suggestions ? { suggestions: true } : {}),
        }),
        signal,
      },
      'turn_failed',
    );
    if (response.status === 409) return;
    if (!response.ok) {
      throw clientError(
        'turn_failed',
        `Assistant turn failed (${response.status})`,
        false,
        response.status,
        undefined,
        await refusalCode(response),
      );
    }
    this.#emit({ event: 'resume_started', data: { tool: session.resume?.tool ?? '' } });
    await this.#consume(response);
    this.#emit({ event: 'message_completed', data: {} });
  }

  async sendMessage(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    this.#cancelInitialSuggestions();
    await this.#singleFlight(async (signal) => {
      await this.#runChatOperation(signal, () =>
        this.#sendTurn(message, true, signal, this.#modelContext),
      );
    });
  }

  async loadInitialSuggestions(): Promise<void> {
    if (!this.#session) await this.connect();
    const session = this.#session;
    if (!session?.endpoints.suggestions) return;
    if (this.#initialSuggestions) return this.#initialSuggestions.promise;
    const controller = new AbortController();
    const clientContext = this.#resolveClientContext();
    const pageContext = this.#resolvePageContext();
    const promise = this.#request(
      session.endpoints.suggestions,
      {
        method: 'POST',
        headers: authorizedHeaders(session.token, 'text/event-stream'),
        body: JSON.stringify({
          ...(clientContext ? { clientContext } : {}),
          ...(pageContext === undefined ? {} : { pageContext }),
          ...(this.#modelContext ? { modelContext: this.#modelContext } : {}),
        }),
        signal: controller.signal,
      },
      'turn_failed',
    )
      .then(async (response) => {
        if (response.ok) await this.#consume(response);
      })
      .finally(() => {
        if (this.#initialSuggestions?.controller === controller) {
          this.#initialSuggestions = undefined;
        }
      });
    this.#initialSuggestions = { controller, promise };
    return promise;
  }

  async respond(id: string, resolution: AssistantInteractionResponse): Promise<void> {
    if (!id) {
      throw clientError('invalid_request', 'interaction id is required', false);
    }
    this.#cancelInitialSuggestions();
    await this.#singleFlight(async (signal) => {
      await this.#runChatOperation(signal, async () => {
        const pendingApp = this.#pendingAppInteractions.get(id);
        const session = this.#session;
        if (!session) {
          throw clientError('confirmation_expired', 'assistant session is not active', false);
        }
        const modernEndpoint = session.endpoints.interactions;
        if (!modernEndpoint && resolution.action !== 'accept') {
          throw clientError(
            'unsupported_service',
            'the assistant service does not support declining or cancelling interactions',
            false,
          );
        }
        const endpoint = modernEndpoint ?? session.endpoints.toolConfirmations;
        const body = modernEndpoint
          ? {
              id,
              action: resolution.action,
              ...(session.endpoints.suggestions ? { suggestions: true } : {}),
              ...(resolution.action === 'accept' && resolution.content !== undefined
                ? { content: resolution.content }
                : {}),
            }
          : { id };
        this.#emit({ event: 'interaction_started', data: { id, action: resolution.action } });
        try {
          const response = await this.#request(
            endpoint,
            {
              method: 'POST',
              headers: authorizedHeaders(session.token, 'text/event-stream'),
              body: JSON.stringify(body),
              signal,
            },
            'confirmation_failed',
          );
          if (response.status === 401) {
            this.#session = undefined;
            this.#emit({ event: 'session_expired', data: {} });
          }
          if (!response.ok) {
            const serverCode = await readStableErrorCode(response);
            const expired = response.status === 401 || response.status === 409;
            throw clientError(
              serverCode ?? (expired ? 'confirmation_expired' : 'confirmation_failed'),
              `Assistant interaction failed (${response.status})`,
              false,
              response.status,
            );
          }
          let completedResult: AssistantJsonValue | undefined;
          let nextInteractionId: string | undefined;
          await this.#consume(response, (event) => {
            if (event.event === 'tool_completed' && event.data.id === id) {
              completedResult = event.data.result;
            }
            if (
              (event.event === 'tool_proposed' || event.event === 'input_requested') &&
              event.data.id !== id
            ) {
              nextInteractionId = event.data.id;
            }
          });
          this.#emit({ event: 'interaction_completed', data: { id, action: resolution.action } });
          if (pendingApp) {
            this.#pendingAppInteractions.delete(id);
            if (nextInteractionId) {
              this.#pendingAppInteractions.set(nextInteractionId, pendingApp);
            } else if (resolution.action !== 'accept') {
              pendingApp.resolve(appInteractionStopped(resolution.action));
            } else if (completedResult !== undefined) {
              pendingApp.resolve(appToolResult(completedResult));
            } else {
              pendingApp.reject(
                clientError(
                  'invalid_response',
                  'Assistant app interaction completed without a tool result',
                  false,
                ),
              );
            }
          }
        } catch (error) {
          if (pendingApp && this.#pendingAppInteractions.get(id) === pendingApp) {
            this.#pendingAppInteractions.delete(id);
            pendingApp.reject(error);
          }
          throw error;
        }
      });
    });
  }

  updateContext(context: AssistantContext): void {
    this.#context = { ...context };
    this.#emit({ event: 'context_changed', data: { context: this.#context } });
  }

  updatePageContext(context: TPageContext): void {
    this.#pageContext = copyAssistantPageContext(context) as TPageContext;
  }

  updateModelContext(update: AssistantModelContextUpdate): void {
    this.#modelContext = copyAssistantModelContext(update);
    this.#emit({ event: 'model_context_changed', data: { modelContext: this.#modelContext } });
  }

  async requestApp(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: AppRequestOptions,
  ): Promise<unknown> {
    const session = this.#session;
    if (!session?.endpoints.apps) {
      throw clientError(
        'unsupported_service',
        'the assistant service does not support MCP Apps',
        false,
      );
    }
    const response = await this.#request(
      session.endpoints.apps,
      {
        method: 'POST',
        headers: authorizedHeaders(session.token, 'application/json'),
        body: JSON.stringify({
          ...(options?.bridge ? { bridge: options.bridge } : {}),
          method,
          params,
        }),
      },
      'app_request_failed',
    );
    if (!response.ok) {
      throw clientError(
        'app_request_failed',
        `Assistant app request failed (${response.status})`,
        false,
        response.status,
      );
    }
    const value = await response.json();
    const interaction = parseAppInteraction(value);
    if (!interaction) return value;
    // This request, and only this request, parked. Watching the event stream instead would also match
    // an interaction raised by another bridge call or by the visitor's own conversation.
    options?.onSuspended?.();
    return new Promise<unknown>((resolve, reject) => {
      const id = interaction.data.id;
      const replaced = this.#pendingAppInteractions.get(id);
      if (replaced) {
        replaced.reject(
          clientError('invalid_response', 'Assistant returned a duplicate app interaction', false),
        );
      }
      this.#pendingAppInteractions.set(id, { resolve, reject });
      this.#emit(interaction);
      void this.#chat.flush();
    });
  }

  appSandboxUrl(): string | undefined {
    return this.#session?.endpoints.sandbox;
  }

  resetSession(): void {
    this.#cancelInitialSuggestions();
    this.#rejectPendingAppInteractions(
      clientError('confirmation_expired', 'assistant session is not active', false),
    );
    this.#session = undefined;
    this.#emit({ event: 'session_reset', data: {} });
  }

  abort(): void {
    this.#active?.abort();
    this.#cancelInitialSuggestions();
  }

  async #sendTurn(
    message: string,
    mayRetry: boolean,
    signal: AbortSignal,
    modelContext: AssistantModelContextUpdate | undefined,
  ): Promise<void> {
    const session = this.#session ?? (await this.#createSession(signal));
    if (mayRetry) this.#emit({ event: 'message_started', data: { message } });
    const clientContext = this.#resolveClientContext();
    const pageContext = this.#resolvePageContext();
    const response = await this.#request(
      session.endpoints.turns,
      {
        method: 'POST',
        headers: authorizedHeaders(session.token, 'text/event-stream'),
        body: JSON.stringify({
          message,
          ...(clientContext ? { clientContext } : {}),
          ...(pageContext === undefined ? {} : { pageContext }),
          ...(modelContext ? { modelContext } : {}),
          ...(session.endpoints.suggestions ? { suggestions: true } : {}),
        }),
        signal,
      },
      'turn_failed',
    );
    if (response.status === 401 && mayRetry) {
      this.#session = undefined;
      this.#emit({ event: 'session_expired', data: {} });
      await this.#sendTurn(message, false, signal, modelContext);
      return;
    }
    if (!response.ok) {
      const serviceCode = await refusalCode(response);
      throw clientError(
        'turn_failed',
        `Assistant turn failed (${response.status})`,
        false,
        response.status,
        undefined,
        serviceCode,
      );
    }
    await this.#consume(response);
    this.#emit({ event: 'message_completed', data: {} });
  }

  #resolveClientContext(): AssistantClientContext | undefined {
    let value: AssistantClientContext | undefined;
    try {
      value =
        typeof this.#clientContext === 'function' ? this.#clientContext() : this.#clientContext;
    } catch (error) {
      throw clientError(
        'turn_failed',
        'Assistant client context provider failed',
        false,
        undefined,
        {
          cause: error,
        },
      );
    }
    if (!value) return undefined;
    const context = {
      ...(typeof value.locale === 'string' && value.locale ? { locale: value.locale } : {}),
      ...(typeof value.timeZone === 'string' && value.timeZone ? { timeZone: value.timeZone } : {}),
    };
    return Object.keys(context).length > 0 ? context : undefined;
  }

  #resolvePageContext(): TPageContext | undefined {
    try {
      const value =
        typeof this.#pageContext === 'function'
          ? (this.#pageContext as () => TPageContext | undefined)()
          : this.#pageContext;
      return value === undefined ? undefined : (copyAssistantPageContext(value) as TPageContext);
    } catch (error) {
      throw clientError('turn_failed', 'Assistant page context provider failed', false, undefined, {
        cause: error,
      });
    }
  }

  async #createSession(signal: AbortSignal): Promise<AssistantSessionResponse> {
    const source = this.#source;
    // A public mint carries the embed id and nothing else: the route reads nothing else, and page
    // context would be untrusted data sent cross-origin for no reader. It still reaches the model on
    // every turn, where it is actually used. `omit` because the mint response grants no credentialed
    // CORS — a credentialed request would have its response rejected by the browser outright.
    // The visitor identifier is the one thing a public mint sends beyond the embed id, and it is
    // deliberately not a credential: it exists so admission can be fair to each person behind a
    // shared address rather than to the address. Absent when storage is unavailable, which costs a
    // fairness tier and nothing else. See `visitor-id.ts`.
    const visitorId =
      source.kind === 'public'
        ? visitorIdForSource(sessionSourceKey({ embedId: source.embedId, serviceUrl: source.url }))
        : undefined;
    const response = await this.#requestSession(source, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(
        source.kind === 'public'
          ? { embedId: source.embedId, ...(visitorId ? { visitorId } : {}) }
          : this.#context
            ? { context: this.#context }
            : {},
      ),
      credentials: source.kind === 'public' ? 'omit' : 'same-origin',
      signal,
    });
    if (!response.ok) {
      const serviceCode = await refusalCode(response);
      throw clientError(
        'session_failed',
        `Assistant session failed (${response.status})`,
        serviceCode === undefined || !UNRETRYABLE_SERVICE_CODES.has(serviceCode),
        response.status,
        undefined,
        serviceCode,
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw clientError(
        'session_failed',
        'Assistant session returned invalid JSON',
        true,
        undefined,
        {
          cause: error,
        },
      );
    }
    const session = parseSession(value);
    this.#session = session;
    this.#emit({
      event: 'session_started',
      data: {
        expiresAt: session.expiresAt,
        ...(session.configuration ? { configuration: session.configuration } : {}),
      },
    });
    return session;
  }

  async #consume(
    response: Response,
    observe?: (event: AssistantClientEvent) => void,
  ): Promise<void> {
    let streamError: AssistantErrorDetail | undefined;
    try {
      await consumeAssistantEvents(response, (event) => {
        const clientEvent = toAssistantClientEvent(event);
        this.#emit(clientEvent);
        observe?.(clientEvent);
        if (clientEvent.event !== 'error' || typeof clientEvent.data.code !== 'string') return;
        streamError = {
          code: clientEvent.data.code,
          ...(typeof clientEvent.data.status === 'number'
            ? { status: clientEvent.data.status }
            : {}),
          retryable: clientEvent.data.retryable === true,
        };
      });
    } catch (error) {
      if (error instanceof AssistantTransportError) {
        throw clientError(error.code, error.message, false, undefined, { cause: error });
      }
      throw error;
    }
    if (streamError) {
      throw clientError(
        streamError.code,
        `Assistant stream failed (${streamError.code})`,
        streamError.retryable,
        streamError.status,
      );
    }
  }

  /**
   * The mint, with the one failure a public page hits that an in-app embed cannot.
   *
   * A page that loads the embed script and then blocks `connect-src` fails here as a bare network
   * rejection — no status, no body, nothing to read. "Assistant request failed" sends a developer
   * hunting through their own code; naming the directive and the origin ends the search. The message
   * covers a plain outage too, because from inside the browser the two are indistinguishable.
   */
  async #requestSession(source: AssistantSessionSource, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(source.url, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (source.kind !== 'public') {
        throw clientError('session_failed', 'Assistant request failed', true, undefined, {
          cause: error,
        });
      }
      throw clientError(
        'session_failed',
        `Assistant could not reach ${new URL(source.url).origin}. If the page sets a Content-Security-Policy, allow that origin in connect-src (and in script-src and frame-src).`,
        true,
        undefined,
        { cause: error },
        'blocked_by_page',
      );
    }
  }

  async #request(input: string, init: RequestInit, failureCode: string): Promise<Response> {
    try {
      return await this.#fetch(input, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw clientError(failureCode, 'Assistant request failed', true, undefined, { cause: error });
    }
  }

  async #singleFlight(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#active) {
      throw clientError('request_in_progress', 'an assistant request is already in progress', true);
    }
    const controller = new AbortController();
    this.#active = controller;
    try {
      await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw clientError('request_aborted', 'assistant request was aborted', true, undefined, {
          cause: error,
        });
      }
      throw error;
    } finally {
      this.#active = undefined;
    }
  }

  #cancelInitialSuggestions(): void {
    this.#initialSuggestions?.controller.abort();
  }

  async #runChatOperation(signal: AbortSignal, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
      await this.#chat.flush();
    } catch (error) {
      this.#chat.fail(error, signal.aborted);
      await this.#chat.flush();
      throw error;
    }
  }

  #emit(event: AssistantClientEvent): void {
    this.#chat.handle(event);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Renderers are independent observers; one subscriber cannot change a completed request.
      }
    }
  }

  #rejectPendingAppInteractions(error: AssistantClientError): void {
    for (const pending of this.#pendingAppInteractions.values()) pending.reject(error);
    this.#pendingAppInteractions.clear();
  }
}

export function createAssistantClient<TPageContext extends AssistantPageContext = AssistantContext>(
  options: CreateAssistantClientOptions<TPageContext>,
): AssistantClient<TPageContext> {
  return new DefaultAssistantClient(options);
}
