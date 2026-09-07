import type { ResolvedAssistantAppearance } from './appearance.js';
import type { AssistantClient } from './client.js';
import type { AssistantClientEvent, AssistantSuggestedPromptsDetail } from './events.js';
import type { AssistantPageContext } from './model-context.js';

interface AssistantElementSuggestionsHost {
  readonly root: () => ShadowRoot | null;
  readonly appearance: () => ResolvedAssistantAppearance;
  readonly client: () => AssistantClient<AssistantPageContext> | undefined;
  readonly hasMessages: () => boolean;
  readonly isOpen: () => boolean;
  readonly send: (prompt: string) => void;
}

/** Owns initial-generation idempotence and the one visible suggestion set for the managed element. */
export class AssistantElementSuggestionsController {
  readonly #host: AssistantElementSuggestionsHost;
  #initialRequested = false;
  #dynamic: AssistantSuggestedPromptsDetail | undefined;

  constructor(host: AssistantElementSuggestionsHost) {
    this.#host = host;
  }

  reset(): void {
    this.#initialRequested = false;
    this.clear();
  }

  clear(): void {
    this.#dynamic = undefined;
    this.render();
  }

  handle(event: AssistantClientEvent): void {
    if (event.event === 'message_started' || event.event === 'interaction_started') {
      this.clear();
      return;
    }
    if (event.event !== 'suggested_prompts') return;
    this.#dynamic = event.data;
    this.render();
  }

  maybeLoadInitial(): void {
    const appearance = this.#host.appearance();
    if (
      this.#initialRequested ||
      appearance.suggestedPromptsSource !== 'model' ||
      this.#host.hasMessages() ||
      !this.#host.isOpen()
    ) {
      return;
    }
    const client = this.#host.client();
    if (!client?.loadInitialSuggestions) return;
    this.#initialRequested = true;
    void client.loadInitialSuggestions().catch(() => {
      // Initial prompts are optional; composer input remains the complete fallback.
    });
  }

  render(): void {
    const container = this.#host.root()?.querySelector<HTMLElement>('.suggested-prompts');
    if (!container) return;
    const appearance = this.#host.appearance();
    const hasMessages = this.#host.hasMessages();
    const prompts =
      (this.#dynamic?.phase === 'follow_up' || !hasMessages ? this.#dynamic?.prompts : undefined) ??
      (!hasMessages && appearance.suggestedPromptsSource === 'configured'
        ? appearance.suggestedPrompts
        : []);
    container.replaceChildren();
    for (const prompt of prompts) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = prompt;
      button.addEventListener('click', () => this.#host.send(prompt));
      container.append(button);
    }
  }
}
