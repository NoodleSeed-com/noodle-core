import type { AssistantConfiguration, AssistantLabels } from './appearance.js';
import type {
  AssistantClientEvent,
  AssistantInteractionResponse,
  AssistantToolCompletedDetail,
  AssistantViewAvailableDetail,
} from './client.js';
import { createInputRequestCard } from './input-request-card.js';
import { createInteractionCard, createResultCard } from './interaction-card.js';
import { renderMarkdown } from './markdown.js';
import { createSignInCard } from './sign-in-card.js';
import type { AssistantErrorDetail } from './transport.js';

interface AssistantElementEventHost {
  readonly element: HTMLElement;
  readonly messages: () => HTMLElement | undefined;
  readonly appendMessage: (role: 'user' | 'assistant', text: string) => HTMLElement | undefined;
  readonly applyConfiguration: (configuration: AssistantConfiguration) => void;
  readonly labels: () => AssistantLabels;
  readonly showConfirmationDetails: () => boolean;
  readonly respond: (id: string, response: AssistantInteractionResponse) => Promise<void>;
  readonly dispatchError: (detail: AssistantErrorDetail) => void;
  readonly revealLatest: () => void;
  readonly renderView: (detail: AssistantViewAvailableDetail) => void;
}

/** Owns streamed client-event state and its translation into the standard element renderer. */
export class AssistantElementEventController {
  readonly #host: AssistantElementEventHost;
  #assistantBody: HTMLElement | undefined;
  #assistantText = '';
  #completedTool: AssistantToolCompletedDetail | undefined;
  #streamKind: 'message' | 'interaction' | undefined;
  readonly #proposalCards = new Map<string, HTMLElement>();

  constructor(host: AssistantElementEventHost) {
    this.#host = host;
  }

  handle(event: AssistantClientEvent): void {
    if (event.event === 'view_available') {
      this.#host.renderView(event.data);
      this.#host.element.dispatchEvent(
        new CustomEvent<AssistantViewAvailableDetail>('assistant-view-available', {
          detail: event.data,
        }),
      );
      return;
    }
    if (event.event === 'unrecognized') return;
    const { event: name, data } = event;
    if (name === 'session_started') {
      if (isRecord(data.configuration)) {
        this.#host.applyConfiguration(data.configuration as AssistantConfiguration);
      }
      this.#host.element.dispatchEvent(
        new CustomEvent('assistant-session-started', {
          detail: { expiresAt: String(data.expiresAt ?? '') },
        }),
      );
      return;
    }
    if (name === 'session_expired') {
      this.#host.element.dispatchEvent(new CustomEvent('assistant-session-expired'));
      return;
    }
    if (name === 'session_reset') {
      this.resetConversation();
      return;
    }
    if (name === 'session_continued') {
      const messages = this.#host.messages();
      if (!messages) return;
      const status = messages.appendChild(document.createElement('div'));
      status.className = 'conversation-status';
      status.setAttribute('role', 'status');
      status.textContent = String(data.message ?? 'Continued securely with your account.');
      this.#host.element.setAttribute('has-messages', '');
      this.#host.revealLatest();
      this.#host.element.dispatchEvent(new CustomEvent('assistant-session-continued'));
      return;
    }
    if (name === 'context_changed') {
      this.#host.element.dispatchEvent(
        new CustomEvent('assistant-context-changed', { detail: { context: data.context } }),
      );
      return;
    }
    if (name === 'model_context_changed') {
      this.#host.element.dispatchEvent(
        new CustomEvent('assistant-model-context-changed', {
          detail: { modelContext: data.modelContext },
        }),
      );
      return;
    }
    if (name === 'message_started') {
      this.#startStream('message');
      const body = this.#host.appendMessage('user', String(data.message ?? ''));
      if (body) this.#host.revealLatest();
      this.#host.element.dispatchEvent(new CustomEvent('assistant-message-started'));
      return;
    }
    if (name === 'message_completed') {
      if (this.#streamKind !== 'message') return;
      this.#clearStream();
      this.#host.element.dispatchEvent(new CustomEvent('assistant-message-completed'));
      return;
    }
    if (name === 'interaction_started') {
      this.#startStream('interaction');
      this.#completedTool = undefined;
      return;
    }
    if (name === 'resume_started') {
      // The post-sign-in resume streams like a message turn, minus the user bubble: the visitor
      // already asked before signing in, and echoing our platform message would read as them.
      this.#startStream('message');
      this.#host.element.dispatchEvent(new CustomEvent('assistant-message-started'));
      return;
    }
    if (name === 'interaction_completed') {
      if (this.#streamKind !== 'interaction') return;
      this.#finishInteraction(String(data.id ?? ''), String(data.action ?? 'accept'));
      return;
    }
    if (name === 'content') {
      this.#appendContent(String(data.delta ?? ''));
      return;
    }
    if (name === 'tool_proposed' || name === 'interaction_proposed') {
      this.#appendToolProposal(
        String(data.id ?? ''),
        String(data.tool ?? 'action'),
        isRecord(data.arguments) ? data.arguments : undefined,
        typeof data.title === 'string' ? data.title : undefined,
        'description' in data && typeof data.description === 'string'
          ? data.description
          : undefined,
        'reviewSchema' in data && isRecord(data.reviewSchema) ? data.reviewSchema : undefined,
      );
      return;
    }
    if (name === 'auth_requested' && typeof data.signInTicket === 'string') {
      // Event normalization already folded the legacy `continuation` key into `signInTicket`.
      this.#appendSignInRequest(
        String(data.id ?? ''),
        String(data.tool ?? 'this'),
        data.signInTicket,
        String(data.expiresAt ?? ''),
      );
      return;
    }
    if (name === 'input_requested' && isRecord(data.requestedSchema)) {
      this.#appendInputRequest(
        String(data.id ?? ''),
        String(data.message ?? 'More information is required'),
        data.requestedSchema,
      );
      return;
    }
    if (name === 'tool_completed') {
      this.#completedTool = data;
      return;
    }
    if (name === 'error') {
      this.#clearStream();
      this.#host.dispatchError({
        code: String(data.code ?? 'stream_failed'),
        ...(typeof data.status === 'number' ? { status: data.status } : {}),
        retryable: data.retryable === true,
      });
    }
  }

  resetConversation(): void {
    const messages = this.#host.messages();
    messages?.replaceChildren();
    if (messages) messages.scrollTop = 0;
    this.#proposalCards.clear();
    this.#clearStream();
    this.#completedTool = undefined;
    this.#host.element.removeAttribute('has-messages');
    this.#host.revealLatest();
    this.#host.element.dispatchEvent(new CustomEvent('assistant-session-reset'));
  }

  #finishInteraction(id: string, action: string): void {
    if (this.#completedTool && !this.#assistantBody) {
      const messages = this.#host.messages();
      if (messages) {
        const labels = this.#host.labels();
        messages.append(
          createResultCard(this.#completedTool.result, labels.completed, labels.redacted),
        );
        this.#host.revealLatest();
      }
    }
    this.#proposalCards.get(id)?.remove();
    this.#proposalCards.delete(id);
    if (action === 'accept') {
      this.#host.element.dispatchEvent(
        new CustomEvent('assistant-tool-completed', { detail: { id } }),
      );
    }
    this.#host.element.dispatchEvent(
      new CustomEvent('assistant-interaction-resolved', { detail: { id, action } }),
    );
    this.#clearStream();
    this.#completedTool = undefined;
  }

  #appendToolProposal(
    id: string,
    tool: string,
    arguments_: Readonly<Record<string, unknown>> | undefined,
    title: string | undefined,
    description: string | undefined,
    reviewSchema: Readonly<Record<string, unknown>> | undefined,
  ): void {
    const messages = this.#host.messages();
    if (!messages || !id) return;
    this.#proposalCards.get(id)?.remove();
    const labels = this.#host.labels();
    const card = createInteractionCard({
      tool,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(arguments_ ? { arguments: arguments_ } : {}),
      ...(reviewSchema ? { reviewSchema } : {}),
      showDetails: this.#host.showConfirmationDetails(),
      labels: {
        heading: labels.confirmationHeading,
        accept: labels.confirm,
        decline: labels.decline,
        details: labels.additionalDetails,
        redacted: labels.redacted,
      },
      respond: (action) => this.#host.respond(id, { action }),
    });
    messages.append(card);
    this.#proposalCards.set(id, card);
    this.#host.revealLatest();
    this.#host.element.dispatchEvent(
      new CustomEvent('assistant-tool-proposed', {
        detail: { id, tool, title, description, arguments: arguments_, reviewSchema },
      }),
    );
  }

  /**
   * The host application owns the login. This renders the prompt and raises
   * `assistant-sign-in-requested`; the page signs the visitor in however it already does, then its
   * backend spends the sign-in ticket. Nothing here talks to an identity provider.
   */
  #appendSignInRequest(id: string, tool: string, signInTicket: string, expiresAt: string): void {
    const messages = this.#host.messages();
    if (!messages) return;
    this.#proposalCards.get(id)?.remove();
    const labels = this.#host.labels();
    const card = createSignInCard({
      tool,
      signInTicket,
      expiresAt,
      labels: {
        heading: labels.signInHeading,
        body: labels.signInBody,
        action: labels.signInAction,
        signUpAction: labels.signUpAction,
      },
      onAction: (intent) =>
        this.#host.element.dispatchEvent(
          new CustomEvent('assistant-sign-in-requested', {
            detail: { id, tool, signInTicket, expiresAt, intent },
            bubbles: true,
            composed: true,
          }),
        ),
    });
    messages.append(card);
    this.#proposalCards.set(id, card);
    this.#host.revealLatest();
    this.#host.element.dispatchEvent(
      new CustomEvent('assistant-sign-in-required', {
        detail: { id, tool, signInTicket, expiresAt },
      }),
    );
  }

  #appendInputRequest(
    id: string,
    message: string,
    requestedSchema: Readonly<Record<string, unknown>>,
  ): void {
    const messages = this.#host.messages();
    if (!messages || !id) return;
    this.#proposalCards.get(id)?.remove();
    const labels = this.#host.labels();
    const card = createInputRequestCard({
      message,
      requestedSchema,
      labels: {
        submit: labels.confirm,
        decline: 'Decline',
        cancel: labels.cancel,
      },
      respond: (response) => this.#host.respond(id, response),
    });
    messages.append(card);
    this.#proposalCards.set(id, card);
    this.#host.revealLatest();
    this.#host.element.dispatchEvent(
      new CustomEvent('assistant-input-requested', {
        detail: { id, message, requestedSchema },
      }),
    );
  }

  #startStream(kind: 'message' | 'interaction'): void {
    this.#assistantBody = undefined;
    this.#assistantText = '';
    this.#streamKind = kind;
  }

  #clearStream(): void {
    this.#assistantBody?.parentElement?.classList.remove('streaming');
    this.#assistantBody = undefined;
    this.#assistantText = '';
    this.#streamKind = undefined;
  }

  #appendContent(delta: string): void {
    // A reset invalidates the active stream before its AbortSignal necessarily reaches the reader.
    // Ignore any frames that arrive after that boundary, and never create a bubble for empty output.
    if (!this.#streamKind || !delta) return;
    this.#assistantText += delta;
    const html = renderMarkdown(this.#assistantText);
    if (!html) return;
    const body = this.#assistantBody ?? this.#host.appendMessage('assistant', '');
    this.#assistantBody = body;
    if (!body) return;
    body.parentElement?.classList.add('streaming');
    body.innerHTML = html;
    this.#host.element.setAttribute('has-messages', '');
    this.#host.revealLatest();
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
