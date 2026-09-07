import { type ChatStatus, readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import type {
  AssistantAuthRequestedDetail,
  AssistantClientEvent,
  AssistantInputRequestedDetail,
  AssistantToolCompletedDetail,
  AssistantToolProposedDetail,
  AssistantViewAvailableDetail,
} from './events.js';
import type { AssistantJsonValue } from './model-context.js';
import type { AssistantErrorDetail } from './transport.js';

export type AssistantInteractionStatus =
  | 'pending'
  | 'submitting'
  | 'accepted'
  | 'declined'
  | 'cancelled';

export interface AssistantConfirmationData {
  readonly id: string;
  readonly tool?: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: AssistantJsonValue;
  readonly reviewSchema?: Readonly<Record<string, unknown>>;
  readonly expiresAt?: string;
  readonly requiresConfirmation?: true;
  readonly turnId?: string;
  readonly status: AssistantInteractionStatus;
}

export type AssistantInputRequestData = AssistantInputRequestedDetail & {
  readonly status: AssistantInteractionStatus;
};

export type AssistantToolResultData = AssistantToolCompletedDetail;
export type AssistantViewData = AssistantViewAvailableDetail;
export type AssistantContinuationData = Readonly<{ message: string }>;

/**
 * The sign-in moment as a transcript part for headless renderers (ADR 0201, 5.6b). It carries no
 * `status` field because it is not respondable through `client.respond`: resolution is the elevated
 * session — the host page spends the ticket with its backend, and the conversation continues via
 * `resume_started` under the new principal.
 */
type AssistantSignInRequestData = AssistantAuthRequestedDetail;

export type AssistantUIDataTypes = {
  readonly confirmation: AssistantConfirmationData;
  readonly 'input-request': AssistantInputRequestData;
  readonly 'tool-result': AssistantToolResultData;
  readonly view: AssistantViewData;
  readonly continuation: AssistantContinuationData;
  readonly 'sign-in': AssistantSignInRequestData;
};

/** AI SDK UI message shape used by the DOM-free client and customer-owned renderers. */
export type AssistantUIMessage = UIMessage<undefined, AssistantUIDataTypes>;

export interface AssistantChatError {
  readonly name: string;
  readonly message: string;
  readonly detail?: AssistantErrorDetail;
}

export interface AssistantChatState {
  readonly status: ChatStatus;
  readonly messages: readonly AssistantUIMessage[];
  readonly suggestions?: Extract<AssistantClientEvent, { event: 'suggested_prompts' }>['data'];
  readonly error?: AssistantChatError;
}

type ChatStateListener = (state: AssistantChatState) => void;
type InteractionAction = 'accept' | 'decline' | 'cancel';

interface ActiveOperation {
  readonly interactionId?: string;
  readonly controller: ReadableStreamDefaultController<UIMessageChunk>;
  consumer: Promise<void>;
  finalization?: Promise<void>;
  processingError?: AssistantChatError;
  textId: string | undefined;
  textOpen: boolean;
  closed: boolean;
}

export class AssistantChatStateStore {
  readonly #listeners = new Set<ChatStateListener>();
  #messages: AssistantUIMessage[] = [];
  #status: ChatStatus = 'ready';
  #error: AssistantChatError | undefined;
  #suggestions: AssistantChatState['suggestions'];
  #operation: ActiveOperation | undefined;
  #nextId = 0;

  subscribe(listener: ChatStateListener): () => void {
    this.#listeners.add(listener);
    this.#notifyListener(listener);
    return () => this.#listeners.delete(listener);
  }

  getState(): AssistantChatState {
    return structuredClone({
      status: this.#status,
      messages: this.#messages,
      ...(this.#suggestions ? { suggestions: this.#suggestions } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    });
  }

  handle(event: AssistantClientEvent): void {
    switch (event.event) {
      case 'message_started':
        this.#suggestions = undefined;
        this.#beginMessage(event.data.message);
        return;
      case 'interaction_started':
        this.#suggestions = undefined;
        this.#beginInteraction(event.data.id);
        return;
      case 'resume_started':
        // The post-sign-in resume: an assistant-side operation with no user bubble — the visitor
        // already asked, before signing in.
        this.#status = 'submitted';
        this.#error = undefined;
        this.#suggestions = undefined;
        this.#startOperation();
        this.#notify();
        return;
      case 'session_continued':
        this.#writeStandaloneData(() =>
          this.#writeData('continuation', 'continued-after-authentication', event.data),
        );
        return;
      case 'content':
        this.#writeText(event.data.delta);
        return;
      case 'tool_proposed':
        this.#writeStandaloneData(() => this.#writeConfirmation(event.data));
        return;
      case 'interaction_proposed':
        this.#writeData('confirmation', event.data.id, {
          ...event.data,
          status: 'pending',
        });
        return;
      case 'input_requested':
        this.#writeStandaloneData(() =>
          this.#writeData('input-request', event.data.id, {
            ...event.data,
            status: 'pending',
          }),
        );
        return;
      case 'auth_requested':
        this.#writeStandaloneData(() => this.#writeData('sign-in', event.data.id, event.data));
        return;
      case 'tool_completed':
        this.#writeData('tool-result', event.data.id, event.data);
        return;
      case 'view_available':
        this.#writeStandaloneData(() => this.#writeData('view', event.data.id, event.data));
        return;
      case 'suggested_prompts':
        this.#suggestions = {
          phase: event.data.phase,
          prompts: [...event.data.prompts],
        };
        this.#notify();
        return;
      case 'message_completed':
        this.#closeOperation('ready');
        return;
      case 'interaction_completed':
        this.#patchInteraction(event.data.id, completedStatus(event.data.action));
        this.#closeOperation('ready');
        return;
      case 'session_reset':
        this.#reset();
        return;
      default:
        return;
    }
  }

  fail(error: unknown, aborted: boolean): void {
    const operation = this.#operation;
    if (operation?.interactionId) {
      this.#patchInteraction(operation.interactionId, 'pending');
    }
    this.#closeOperation(aborted ? 'ready' : 'error', aborted ? undefined : toChatError(error));
    if (!operation) {
      this.#status = aborted ? 'ready' : 'error';
      this.#error = aborted ? undefined : toChatError(error);
      this.#notify();
    }
  }

  async flush(): Promise<void> {
    const operation = this.#operation;
    if (!operation) return;
    await (operation.finalization ?? operation.consumer);
  }

  #beginMessage(text: string): void {
    const userMessage: AssistantUIMessage = {
      id: this.#id('user'),
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    this.#messages = [...this.#messages, userMessage];
    this.#status = 'submitted';
    this.#error = undefined;
    this.#suggestions = undefined;
    this.#startOperation();
    this.#notify();
  }

  #beginInteraction(id: string): void {
    this.#patchInteraction(id, 'submitting');
    this.#status = 'submitted';
    this.#error = undefined;
    this.#startOperation(id);
    this.#notify();
  }

  #startOperation(interactionId?: string): void {
    const messageId = this.#id('assistant');
    let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
    const stream = new ReadableStream<UIMessageChunk>({
      start(value) {
        controller = value;
      },
    });
    if (!controller) throw new Error('AI SDK message stream did not initialize');

    const operation: ActiveOperation = {
      ...(interactionId ? { interactionId } : {}),
      controller,
      consumer: Promise.resolve(),
      textId: undefined,
      textOpen: false,
      closed: false,
    };
    this.#operation = operation;
    operation.consumer = this.#consume(operation, stream).catch((error: unknown) => {
      operation.processingError = toChatError(error);
    });
    controller.enqueue({ type: 'start', messageId });
  }

  async #consume(
    operation: ActiveOperation,
    stream: ReadableStream<UIMessageChunk>,
  ): Promise<void> {
    for await (const message of readUIMessageStream<AssistantUIMessage>({ stream })) {
      if (this.#operation !== operation || message.parts.length === 0) continue;
      const index = this.#messages.findIndex((candidate) => candidate.id === message.id);
      this.#messages =
        index < 0
          ? [...this.#messages, message]
          : this.#messages.map((candidate, candidateIndex) =>
              candidateIndex === index ? message : candidate,
            );
      this.#status = 'streaming';
      this.#notify();
    }
  }

  #writeText(delta: string): void {
    const operation = this.#operation;
    if (!operation || operation.closed || !delta) return;
    if (!operation.textOpen) {
      operation.textOpen = true;
      operation.textId = this.#id('text');
      operation.controller.enqueue({ type: 'text-start', id: operation.textId });
    }
    const textId = operation.textId;
    if (!textId) return;
    operation.controller.enqueue({ type: 'text-delta', id: textId, delta });
  }

  #writeConfirmation(data: AssistantToolProposedDetail): void {
    this.#writeData('confirmation', data.id, { ...data, status: 'pending' });
  }

  #writeStandaloneData(write: () => void): void {
    const standalone = this.#operation === undefined;
    if (standalone) this.#startOperation();
    write();
    if (standalone) this.#closeOperation('ready');
  }

  #writeData<Name extends keyof AssistantUIDataTypes>(
    name: Name,
    id: string,
    data: AssistantUIDataTypes[Name],
  ): void {
    const operation = this.#operation;
    if (!operation || operation.closed) return;
    this.#endText(operation);
    operation.controller.enqueue({
      type: `data-${name}`,
      id,
      data,
    } as UIMessageChunk<undefined, AssistantUIDataTypes>);
  }

  #closeOperation(status: 'ready' | 'error', error?: AssistantChatError): void {
    const operation = this.#operation;
    if (!operation || operation.closed) return;
    operation.closed = true;
    try {
      this.#endText(operation);
      operation.controller.enqueue({
        type: 'finish',
        finishReason: status === 'error' ? 'error' : 'stop',
      });
      operation.controller.close();
    } catch (streamError) {
      operation.processingError = toChatError(streamError);
    }

    operation.finalization = operation.consumer.then(() => {
      if (this.#operation !== operation) return;
      this.#operation = undefined;
      const finalError = error ?? operation.processingError;
      this.#status = finalError ? 'error' : status;
      this.#error = finalError;
      this.#notify();
    });
  }

  #endText(operation: ActiveOperation): void {
    const textId = operation.textId;
    if (!operation.textOpen || !textId) return;
    operation.controller.enqueue({ type: 'text-end', id: textId });
    operation.textOpen = false;
    operation.textId = undefined;
  }

  #patchInteraction(id: string, status: AssistantInteractionStatus): void {
    let changed = false;
    this.#messages = this.#messages.map((message) => {
      let messageChanged = false;
      const parts = message.parts.map((part) => {
        if (part.type === 'data-confirmation' && part.id === id) {
          changed = true;
          messageChanged = true;
          return { ...part, data: { ...part.data, status } };
        }
        if (part.type === 'data-input-request' && part.id === id) {
          changed = true;
          messageChanged = true;
          return { ...part, data: { ...part.data, status } };
        }
        return part;
      });
      return messageChanged ? { ...message, parts } : message;
    });
    if (changed) this.#notify();
  }

  #reset(): void {
    const operation = this.#operation;
    this.#operation = undefined;
    if (operation && !operation.closed) {
      operation.closed = true;
      try {
        operation.controller.close();
      } catch {
        // A completed stream is already detached from the reset transcript.
      }
    }
    this.#messages = [];
    this.#status = 'ready';
    this.#error = undefined;
    this.#notify();
  }

  #id(prefix: string): string {
    this.#nextId += 1;
    return `${prefix}-${this.#nextId}`;
  }

  #notify(): void {
    for (const listener of this.#listeners) this.#notifyListener(listener);
  }

  #notifyListener(listener: ChatStateListener): void {
    try {
      listener(this.getState());
    } catch {
      // State observers cannot interrupt transport or other renderers.
    }
  }
}

function completedStatus(action: InteractionAction): AssistantInteractionStatus {
  switch (action) {
    case 'accept':
      return 'accepted';
    case 'decline':
      return 'declined';
    case 'cancel':
      return 'cancelled';
  }
}

function toChatError(error: unknown): AssistantChatError {
  if (error instanceof Error) {
    const detail = readErrorDetail(error);
    return {
      name: error.name,
      message: error.message,
      ...(detail ? { detail } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

function readErrorDetail(error: Error): AssistantErrorDetail | undefined {
  const detail = Reflect.get(error, 'detail');
  if (!isRecord(detail) || typeof detail.code !== 'string') return undefined;
  return {
    code: detail.code,
    ...(typeof detail.status === 'number' ? { status: detail.status } : {}),
    retryable: detail.retryable === true,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
