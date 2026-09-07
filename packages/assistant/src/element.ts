import { mountAssistantApp, updateAssistantAppTheme } from './app-host.js';
import { type AssistantConfiguration, resolveAppearance } from './appearance.js';
import { browserClientContext } from './browser-context.js';
import {
  type AssistantClient,
  AssistantClientError,
  type AssistantClientEvent,
  type AssistantContext,
  type AssistantInteractionResponse,
  type AssistantModelContextUpdate,
  type AssistantPageContext,
  createAssistantClient,
} from './client.js';
import { renderConversationError } from './element-error-recovery.js';
import { AssistantElementEventController } from './element-event-controller.js';
import {
  appendConversationStatus,
  appendLegalLinks,
  assistantElementMarkup,
  queryRequired,
} from './element-helpers.js';
import { AssistantElementHostEnvironmentController } from './element-host-environment-controller.js';
import { AssistantElementLauncherController } from './element-launcher-controller.js';
import { AssistantElementModalController, MODAL_ATTRIBUTES } from './element-modal-controller.js';
import { AssistantElementPageContextController } from './element-page-context-controller.js';
import { AssistantElementPresentationGate } from './element-presentation-gate.js';
import { AssistantElementPublicConfigurationController } from './element-public-configuration-controller.js';
import { AssistantElementScrollController } from './element-scroll-controller.js';
import { ASSISTANT_ELEMENT_STYLES } from './element-styles.js';
import { AssistantElementSuggestionsController } from './element-suggestions-controller.js';
import { applyAssistantElementTheme } from './element-theme.js';
import { AssistantElementWebMcpController } from './element-webmcp-controller.js';
import type { AssistantAppearance, AssistantAppearanceWarning } from './host-appearance.js';
import { renderMarkdown } from './markdown.js';
import { copyAssistantModelContext } from './model-context.js';
import {
  type AssistantSessionVisualState,
  syncAssistantSessionVisualState,
} from './presentation.js';
import { presentationStyles } from './presentation-styles.js';
import { sessionSourceKey } from './session-source.js';
import type { AssistantErrorDetail } from './transport.js';

export const ASSISTANT_TAG_NAME = 'noodle-assistant';
const HTMLElementBase: typeof HTMLElement =
  globalThis.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

export class NoodleAssistantElement extends HTMLElementBase {
  static readonly observedAttributes = [...MODAL_ATTRIBUTES, 'theme'];
  #appearance = resolveAppearance();
  #client: AssistantClient<AssistantPageContext> | undefined;
  #clientEndpoint = '';
  #unsubscribeClient: (() => void) | undefined;
  #sessionBootstrap: Promise<void> | undefined;
  #conversationGeneration = 0;
  #messages: HTMLElement | undefined;
  #thinking: HTMLElement | undefined;
  #context: AssistantContext | undefined;
  #modelContext: AssistantModelContextUpdate | undefined;
  #pageContext: AssistantPageContext | undefined;
  readonly #automaticPageContext = new AssistantElementPageContextController(
    () => !this.#pageContext,
  );
  readonly #presentationGate = new AssistantElementPresentationGate(
    this,
    () => this.#primeSession(),
    () => this.focusComposer(),
  );
  readonly #publicConfiguration = new AssistantElementPublicConfigurationController(
    () => ({ embedId: this.embedId, serviceUrl: this.serviceUrl, fetch: this.#fetch }),
    (configuration) => this.#applyConfiguration(configuration),
    (loading) => this.#setPublicConfigurationLoading(loading),
  );
  #pendingUserEcho: string | undefined;
  #sessionState: AssistantSessionVisualState = 'idle';
  #startOpenApplied = false;
  #readyDispatched = false;
  #turnInFlight = false;
  #fetch: typeof fetch | undefined;
  #hostAppearance: AssistantAppearance | undefined;
  readonly #webmcp = new AssistantElementWebMcpController();
  readonly #appearanceWarningKeys = new Set<string>();
  readonly #appearanceStyleSnapshot = new Map<
    string,
    { readonly value: string; readonly priority: string }
  >();
  readonly #scroll = new AssistantElementScrollController();
  readonly #suggestions = new AssistantElementSuggestionsController({
    root: () => this.shadowRoot,
    appearance: () => this.#appearance,
    client: () => this.#client,
    hasMessages: () => this.hasAttribute('has-messages'),
    isOpen: () => this.hasAttribute('open'),
    send: (prompt) => this.#sendGuarded(prompt),
  });
  sessionEndpoint = '';
  /** Public mount: the non-secret embed id `noodle deploy` printed. Mutually exclusive with the above. */
  embedId = '';
  /** Only for a dev or self-hosted service; the published snippet needs no origin. */
  serviceUrl = '';

  get fetch(): typeof fetch | undefined {
    return this.#fetch;
  }

  set fetch(value: typeof fetch | undefined) {
    if (this.#fetch === value) return;
    this.#fetch = value;
    if (this.#client) this.resetSession();
    if (!this.isConnected) return;
    if (this.embedId) this.#publicConfiguration.refresh();
    else this.#primeSession();
  }

  get appearance(): AssistantAppearance | undefined {
    return this.#hostAppearance;
  }

  set appearance(value: AssistantAppearance | undefined) {
    this.#hostAppearance = value;
    this.#appearanceWarningKeys.clear();
    if (this.isConnected) this.#applyTheme();
  }
  readonly #events = new AssistantElementEventController({
    element: this,
    messages: () => this.#messages,
    appendMessage: (role, text) => {
      if (role === 'user' && text === this.#pendingUserEcho) {
        this.#pendingUserEcho = undefined;
        return undefined;
      }
      return this.#appendMessage(role, text);
    },
    applyConfiguration: (configuration) => this.#applyConfiguration(configuration),
    labels: () => this.#appearance.labels,
    showConfirmationDetails: () => this.#appearance.behavior.showConfirmationDetails,
    respond: (id, response) => this.respond(id, response),
    dispatchError: (detail) => this.#dispatchError(detail),
    revealLatest: () => this.#revealLatest(),
    renderView: (detail) => {
      const messages = this.#messages;
      const client = this.#client;
      if (!messages || !client) return;
      const sandboxUrl = client.appSandboxUrl?.();
      const view = mountAssistantApp(
        detail,
        {
          client,
          sendMessage: (message) => this.sendMessage(message),
          updateModelContext: (update) => this.updateModelContext(update),
          theme: this.#environment.resolvedTheme(),
        },
        {
          ...(sandboxUrl === undefined ? {} : { sandboxUrl }),
          onRenderFailure: (failure) => this.#dispatchError(failure),
        },
      );
      if (!view) return;
      messages.append(view);
      this.setAttribute('has-messages', '');
      this.#revealLatest();
    },
  });
  readonly #launcher = new AssistantElementLauncherController({
    host: this,
    appearance: () => this.#appearance,
    openPanel: () => this.open(),
    sendMessage: (message) => this.#sendGuarded(message),
  });
  readonly #modal = new AssistantElementModalController({
    host: this,
    panel: () => this.shadowRoot?.querySelector<HTMLElement>('.panel') ?? undefined,
    fallbackFocus: () => this.#launcher.focusTrigger(),
  });
  readonly #environment = new AssistantElementHostEnvironmentController({
    host: this,
    appearance: () => this.#appearance,
    applyTheme: () => this.#applyTheme(),
    close: () => this.close(),
  });

  connectedCallback(): void {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    if (!this.sessionEndpoint) this.sessionEndpoint = this.getAttribute('session-endpoint') ?? '';
    if (!this.embedId) this.embedId = this.getAttribute('embed-id') ?? '';
    if (!this.serviceUrl) this.serviceUrl = this.getAttribute('service-url') ?? '';
    if (!this.sessionEndpoint && !this.embedId) this.#presentationGate.reveal();
    this.#environment.connect();
    if (this.#appearance.behavior.startOpen) this.#applyStartOpenPolicy();
    this.#render();
    this.#modal.connect();
    if (this.embedId) this.#publicConfiguration.connect();
    // Once per element lifetime: `assistant-ready` means the shadow DOM and imperative API exist.
    // It is not `session_started`; integrators rely on one dispatch across reparenting.
    if (!this.#readyDispatched) {
      this.#readyDispatched = true;
      this.dispatchEvent(new CustomEvent('assistant-ready'));
    }
    // A **public** embed mints against the surface's admission budget, so it must not open a session
    // merely because a page rendered: the pilot burned 300 mints against 38 turns that way and went
    // dark for everyone. A mint should mean a conversation, which is what the operator's "mints/day"
    // claims to count. Public surfaces therefore mint on first open.
    //
    // An **authenticated** embed exchanges a session through the customer's own backend and spends no
    // public budget, so it primes at mount exactly as before — the problem this solves is not one it
    // has, and changing it would alter behaviour for embeds already shipped.
    //
    // `start-open` is declared on the element rather than read from the authored appearance, because
    // that appearance arrives *with* a session: honouring it here would need the very mint being
    // avoided. An assistant that starts open is one conversation per page view by definition.
    if (this.hasAttribute('start-open')) {
      this.setAttribute('open', '');
      this.#startOpenApplied = true;
    } else if (!this.embedId) {
      this.#primeSession();
    }
    // Attribute callbacks can run before connection, so reconcile an already-open declarative mount
    // after its session source is known and its renderer exists.
    this.#presentationGate.syncOpenState();
  }

  disconnectedCallback(): void {
    this.#conversationGeneration += 1;
    this.#client?.abort();
    this.#unsubscribeClient?.();
    this.#client = undefined;
    this.#clientEndpoint = '';
    this.#unsubscribeClient = undefined;
    this.#sessionBootstrap = undefined;
    this.#publicConfiguration.disconnect();
    this.#scroll.disconnect();
    this.#launcher.disconnect();
    this.#modal.disconnect();
    this.#setBusy(false);
    this.#environment.disconnect();
    this.#webmcp.stop();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'theme') this.#applyTheme();
    if (name === 'open') this.#presentationGate.syncOpenState();
    this.#modal.handleAttributeChange(name, oldValue, newValue);
  }

  open(): void {
    this.#modal.captureFocus();
    this.#launcher.collapse(true);
    this.setAttribute('open', '');
    if (this.hasAttribute('data-presentation-ready')) queueMicrotask(() => this.focusComposer());
    this.dispatchEvent(new CustomEvent('assistant-open'));
  }

  close(): void {
    this.#launcher.collapse(true);
    this.#modal.close(() => this.removeAttribute('open'));
    this.dispatchEvent(new CustomEvent('assistant-close'));
  }

  toggle(): void {
    this.hasAttribute('open') ? this.close() : this.open();
  }

  focusComposer(): void {
    this.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }

  /** Stop the active stream without discarding the current composer draft or session. */
  stop(): void {
    if (!this.hasAttribute('busy')) return;
    this.#conversationGeneration += 1;
    this.#client?.abort();
    this.#setBusy(false);
    appendConversationStatus(this.#messages, this.#appearance.labels.stopped);
    this.dispatchEvent(new CustomEvent('assistant-stopped'));
  }

  resetSession(): void {
    this.#conversationGeneration += 1;
    // Before the client goes: these paths unsubscribe from it, so no `session_reset` event can reach
    // the handler that would otherwise withdraw the bridge, and a live registration would keep the
    // retired session callable by a browser agent.
    this.#webmcp.stop();
    this.#client?.abort();
    this.#unsubscribeClient?.();
    this.#client = undefined;
    this.#clientEndpoint = '';
    this.#unsubscribeClient = undefined;
    this.#sessionBootstrap = undefined;
    this.#events.resetConversation();
    this.#pendingUserEcho = undefined;
    this.removeAttribute('has-messages');
    this.#suggestions.reset();
    this.#setBusy(false);
    this.#setSessionState('idle');
  }

  /** Re-establish the session without replaying a message or interaction decision. */
  reconnect(): void {
    this.#conversationGeneration += 1;
    this.#webmcp.stop();
    this.#client?.abort();
    this.#unsubscribeClient?.();
    this.#client = undefined;
    this.#clientEndpoint = '';
    this.#unsubscribeClient = undefined;
    this.#sessionBootstrap = undefined;
    this.#setBusy(false);
    this.#setSessionState('loading');
    this.#primeSession();
    this.dispatchEvent(new CustomEvent('assistant-reconnecting'));
  }

  updateContext(context: AssistantContext): void {
    this.#context = { ...context };
    if (this.#client) {
      this.#client.updateContext(this.#context);
    } else {
      this.dispatchEvent(
        new CustomEvent('assistant-context-changed', { detail: { context: this.#context } }),
      );
    }
  }

  /** Replace the compact renderer summary attached to subsequent message turns. */
  updateModelContext(update: AssistantModelContextUpdate): void {
    this.#modelContext = copyAssistantModelContext(update);
    if (this.#client) {
      this.#client.updateModelContext(this.#modelContext);
    } else {
      this.dispatchEvent(
        new CustomEvent('assistant-model-context-changed', {
          detail: { modelContext: this.#modelContext },
        }),
      );
    }
  }

  /** Replace typed application context attached as untrusted data to subsequent turns. */
  updatePageContext(context: AssistantPageContext): void {
    this.#pageContext = context;
    this.#client?.updatePageContext(context);
    this.dispatchEvent(
      new CustomEvent('assistant-page-context-changed', {
        detail: { pageContext: context },
      }),
    );
  }

  async sendMessage(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    // Refuse BEFORE mutating any UI state: a concurrent send used to append its bubble, clobber
    // the echo dedupe, and clear busy mid-stream before the client's single-flight rejected it.
    // Only a turn/response in flight refuses — an in-flight eager session exchange is awaited
    // below, which is the documented "never a second session, no queue" contract.
    if (this.#turnInFlight) {
      throw new AssistantClientError(
        { code: 'request_in_progress', retryable: true },
        'an assistant request is already in progress',
      );
    }
    const generation = this.#conversationGeneration;
    this.#turnInFlight = true;
    this.#pendingUserEcho = message;
    this.#appendMessage('user', message);
    this.#suggestions.clear();
    this.#setBusy(true);
    if (this.#sessionState !== 'ready') this.#setSessionState('loading');
    try {
      await this.#sessionBootstrap;
      if (generation !== this.#conversationGeneration) return;
      if (this.embedId && !this.#pageContext) await this.#automaticPageContext.refresh();
      if (generation !== this.#conversationGeneration) return;
      await this.#ensureClient().sendMessage(message);
    } catch (error) {
      if (generation !== this.#conversationGeneration) return;
      if (error instanceof AssistantClientError && error.detail.code === 'request_aborted') return;
      this.#dispatchClientError(error, 'turn_failed');
      throw error;
    } finally {
      this.#turnInFlight = false;
      if (this.#pendingUserEcho === message) this.#pendingUserEcho = undefined;
      if (generation === this.#conversationGeneration) this.#setBusy(false);
    }
  }

  /** DOM listeners swallow after the failing path dispatches its typed assistant-error event. */
  #sendGuarded(text: string): void {
    void this.sendMessage(text).catch(() => {});
  }

  async confirmTool(id: string): Promise<void> {
    await this.respond(id, { action: 'accept' });
  }

  async respond(id: string, response: AssistantInteractionResponse): Promise<void> {
    const generation = this.#conversationGeneration;
    this.#setBusy(true);
    try {
      await this.#ensureClient().respond(id, response);
    } catch (error) {
      if (generation !== this.#conversationGeneration) return;
      this.#dispatchClientError(error, 'confirmation_failed');
      throw error;
    } finally {
      if (generation === this.#conversationGeneration) this.#setBusy(false);
    }
  }

  #ensureClient(): AssistantClient<AssistantPageContext> {
    const key = sessionSourceKey(this);
    if (this.#client && this.#clientEndpoint === key) return this.#client;
    this.#client?.abort();
    this.#unsubscribeClient?.();
    this.#sessionBootstrap = undefined;
    const behavior = {
      ...(this.#context ? { context: this.#context } : {}),
      clientContext: browserClientContext,
      ...(this.#pageContext
        ? { pageContext: this.#pageContext }
        : this.embedId
          ? { pageContext: () => this.#automaticPageContext.current() }
          : {}),
      ...(this.#modelContext ? { modelContext: this.#modelContext } : {}),
    };
    // Spelled out per mount rather than spread from one object: the exclusive union is the guard
    // against passing both, and a spread would collapse it back into an ambiguous shape.
    const client = this.embedId
      ? createAssistantClient({
          embedId: this.embedId,
          ...(this.serviceUrl ? { serviceUrl: this.serviceUrl } : {}),
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
          ...behavior,
        })
      : createAssistantClient({
          sessionEndpoint: this.sessionEndpoint,
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
          ...behavior,
        });
    this.#client = client;
    this.#clientEndpoint = key;
    this.#unsubscribeClient = client.subscribe((event) => {
      if (this.#client === client) this.#handleClientEvent(event);
    });
    return client;
  }

  #primeSession(): void {
    if (!this.sessionEndpoint && !this.embedId) return;
    // Opening an already-open conversation must not re-enter the loading state. `connect()` is
    // idempotent underneath, so without this the second open would only flicker the UI.
    if (this.#sessionBootstrap) return;
    if (this.#client?.hasSession()) {
      this.#suggestions.maybeLoadInitial();
      return;
    }
    // An in-flight send is already minting the session inside its own turn; racing connect() into
    // the client's single-flight here injected a spurious error card into a healthy transcript.
    if (this.#client?.isBusy?.() === true) return;
    if (this.embedId && !this.#pageContext) void this.#automaticPageContext.refresh();
    const client = this.#ensureClient();
    const generation = this.#conversationGeneration;
    this.#setSessionState('loading');
    const bootstrap = client
      .connect()
      .then(() => {
        if (generation === this.#conversationGeneration && this.#client === client) {
          this.#suggestions.maybeLoadInitial();
        }
      })
      .catch((error: unknown) => {
        if (generation !== this.#conversationGeneration || this.#client !== client) return;
        this.#dispatchClientError(error, 'session_failed');
        this.#presentationGate.reveal();
      })
      .finally(() => {
        if (this.#sessionBootstrap === bootstrap) this.#sessionBootstrap = undefined;
      });
    this.#sessionBootstrap = bootstrap;
  }

  #handleClientEvent(event: AssistantClientEvent): void {
    this.dispatchEvent(new CustomEvent<AssistantClientEvent>('assistant-event', { detail: event }));
    this.#events.handle(event);
    this.#suggestions.handle(event);
    if (event.event === 'session_started') {
      this.#publicConfiguration.disconnect();
      this.removeAttribute('data-public-configuration-loading');
      this.#presentationGate.reveal();
      this.#setSessionState('ready');
      this.#launcher.sync();
      this.#messages?.querySelector('.conversation-error')?.remove();
      this.#webmcp.start(this.#client);
    }
    if (event.event === 'session_expired' || event.event === 'session_reset') {
      this.#setSessionState('idle');
      this.#webmcp.stop();
    }
    if (
      event.event === 'tool_proposed' ||
      event.event === 'interaction_proposed' ||
      event.event === 'input_requested'
    ) {
      this.#removeThinking();
      this.setAttribute('has-messages', '');
    }
    if (
      event.event === 'content' ||
      event.event === 'message_completed' ||
      event.event === 'interaction_completed' ||
      event.event === 'error'
    ) {
      this.#removeThinking();
    }
    // The auto-resume is client-initiated: no sendMessage call holds busy, its events do.
    if (event.event === 'resume_started') this.#setBusy(true);
    if (event.event === 'message_completed' || event.event === 'error') this.#setBusy(false);
  }

  #setBusy(busy: boolean): void {
    this.toggleAttribute('busy', busy);
    const textarea = this.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
    const send = this.shadowRoot?.querySelector<HTMLButtonElement>('.send');
    if (textarea) textarea.disabled = false;
    if (send) {
      send.dataset.action = busy ? 'stop' : 'send';
      send.textContent = busy ? this.#appearance.labels.stop : this.#appearance.labels.send;
      send.setAttribute('aria-label', send.textContent);
    }
    if (!busy) {
      this.#removeThinking();
      return;
    }
    if (!this.#messages || this.#thinking) return;
    const thinking = document.createElement('div');
    thinking.className = 'message assistant thinking';
    const label = document.createElement('span');
    label.textContent = this.#appearance.labels.thinking;
    thinking.append(label);
    this.#messages.append(thinking);
    this.#thinking = thinking;
    this.#scrollToBottom();
  }

  #removeThinking(): void {
    this.#thinking?.remove();
    this.#thinking = undefined;
  }

  #appendMessage(role: 'user' | 'assistant', text: string): HTMLElement | undefined {
    if (!this.#messages) return undefined;
    const message = document.createElement('div');
    message.className = `message ${role}`;
    if (
      role === 'assistant' &&
      this.#appearance.behavior.showAvatars &&
      this.#appearance.brand.avatar[this.#environment.resolvedTheme()]
    ) {
      const avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = this.#appearance.brand.avatar[this.#environment.resolvedTheme()] ?? '';
      avatar.alt = '';
      message.append(avatar);
    }
    const body = document.createElement(role === 'assistant' ? 'div' : 'span');
    if (role === 'assistant') {
      body.className = 'markdown';
      body.innerHTML = renderMarkdown(text);
    } else {
      body.textContent = text;
    }
    message.append(body);
    if (role === 'assistant' && text) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'message-copy';
      copy.textContent = this.#appearance.labels.copy;
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(text);
      });
      message.append(copy);
    }
    if (this.#appearance.behavior.showTimestamps) {
      const timestamp = document.createElement('time');
      timestamp.dateTime = new Date().toISOString();
      timestamp.textContent = new Intl.DateTimeFormat(this.#appearance.locale, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date());
      message.append(timestamp);
    }
    this.#messages.append(message);
    this.setAttribute('has-messages', '');
    this.#revealLatest();
    return body;
  }

  #scrollToBottom(): void {
    this.#scroll.scrollToBottom();
  }

  #revealLatest(): void {
    this.#scroll.revealLatest();
  }

  #dispatchError(detail: AssistantErrorDetail): void {
    this.dispatchEvent(new CustomEvent('assistant-error', { detail }));
  }

  #dispatchClientError(error: unknown, fallbackCode: string): void {
    if (error instanceof AssistantClientError && error.detail.code === 'session_failed') {
      this.#setSessionState('error');
    }
    this.#dispatchError(
      renderConversationError({
        messages: this.#messages,
        appearance: this.#appearance,
        error,
        fallbackCode,
        startNewConversation: () => this.#startNewConversation(),
        reconnect: () => this.reconnect(),
        revealLatest: () => this.#revealLatest(),
      }),
    );
  }

  #startNewConversation(): void {
    this.resetSession();
    this.#setSessionState('loading');
    this.#primeSession();
    this.dispatchEvent(new CustomEvent('assistant-new-conversation'));
  }

  #applyTheme(): void {
    const mode = this.#environment.resolvedTheme();
    for (const warning of applyAssistantElementTheme({
      host: this,
      root: this.shadowRoot,
      appearance: this.#appearance,
      hostAppearance: this.#hostAppearance,
      mode,
      sessionState: this.#sessionState,
      styleSnapshot: this.#appearanceStyleSnapshot,
    })) {
      const key = `${warning.theme}:${warning.role}:${warning.foreground}:${warning.background}`;
      if (this.#appearanceWarningKeys.has(key)) continue;
      this.#appearanceWarningKeys.add(key);
      this.dispatchEvent(
        new CustomEvent<AssistantAppearanceWarning>('assistant-appearance-warning', {
          detail: warning,
        }),
      );
    }
    for (const app of this.shadowRoot?.querySelectorAll<HTMLElement>('.noodle-app-card') ?? []) {
      updateAssistantAppTheme(app, mode);
    }
  }

  #applyConfiguration(configuration: AssistantConfiguration): void {
    this.#webmcp.configure(configuration.assistant?.webmcp?.enabled === true);
    this.#appearance = resolveAppearance(configuration);
    this.#suggestions.render();
    this.#syncAppearance();
    this.#applyStartOpenPolicy();
  }
  #setPublicConfigurationLoading(loading: boolean): void {
    this.toggleAttribute('data-public-configuration-loading', loading);
    if (loading) this.#presentationGate.syncOpenState();
    else this.#presentationGate.reveal();
    if (!loading) this.#launcher.sync();
  }

  #setSessionState(state: AssistantSessionVisualState): void {
    this.#sessionState = state;
    syncAssistantSessionVisualState(this, this.shadowRoot, state, this.#appearance);
  }

  #applyStartOpenPolicy(): void {
    if (this.#startOpenApplied) return;
    this.#startOpenApplied = true;
    if (this.#appearance.behavior.startOpen) this.setAttribute('open', '');
  }

  #syncAppearance(): void {
    if (!this.shadowRoot) return;
    const appearance = this.#appearance;
    this.setAttribute('aria-label', appearance.brand.name);
    this.setAttribute('lang', appearance.locale);
    this.setAttribute('dir', appearance.direction);
    this.dataset.mode = appearance.layout.mode;
    this.dataset.position = appearance.layout.position;
    this.dataset.density = appearance.layout.density;
    this.toggleAttribute('mobile-fullscreen', appearance.layout.mobileFullscreen);
    queryRequired<HTMLElement>(this.shadowRoot, '.panel').setAttribute(
      'aria-label',
      appearance.brand.name,
    );
    queryRequired<HTMLElement>(this.shadowRoot, 'header strong').textContent =
      appearance.brand.name;
    const textarea = queryRequired<HTMLTextAreaElement>(this.shadowRoot, 'textarea');
    textarea.placeholder = appearance.labels.composerPlaceholder;
    textarea.setAttribute('aria-label', appearance.labels.composerPlaceholder);
    queryRequired<HTMLElement>(this.shadowRoot, '.send').textContent = appearance.labels.send;
    queryRequired<HTMLElement>(this.shadowRoot, '.close').setAttribute(
      'aria-label',
      appearance.labels.close,
    );
    this.#suggestions.render();
    queryRequired<HTMLElement>(this.shadowRoot, 'header').hidden = !appearance.behavior.showHeader;
    const legal = queryRequired<HTMLElement>(this.shadowRoot, '.legal');
    legal.replaceChildren();
    appendLegalLinks(legal, this.#appearance);
    this.#launcher.sync();
    this.#applyTheme();
    this.#modal.sync();
  }

  #render(): void {
    if (!this.shadowRoot) return;
    this.#scroll.disconnect();
    const conversation = this.#messages ? [...this.#messages.childNodes] : [];
    const appearance = this.#appearance;
    this.setAttribute('role', 'complementary');
    this.setAttribute('aria-label', appearance.brand.name);
    this.setAttribute('lang', appearance.locale);
    this.setAttribute('dir', appearance.direction);
    this.dataset.mode = appearance.layout.mode;
    this.dataset.position = appearance.layout.position;
    this.dataset.density = appearance.layout.density;
    this.toggleAttribute('mobile-fullscreen', appearance.layout.mobileFullscreen);
    this.shadowRoot.innerHTML = assistantElementMarkup(
      appearance,
      `${ASSISTANT_ELEMENT_STYLES}${presentationStyles}`,
    );
    queryRequired<HTMLElement>(this.shadowRoot, 'strong').textContent = appearance.brand.name;
    const logo = queryRequired<HTMLImageElement>(this.shadowRoot, '.brand-logo');
    const logoUrl = appearance.brand.logo[this.#environment.resolvedTheme()];
    if (logoUrl) {
      logo.src = logoUrl;
      logo.alt = appearance.brand.name;
    } else {
      logo.hidden = true;
    }
    const textarea = queryRequired<HTMLTextAreaElement>(this.shadowRoot, 'textarea');
    textarea.placeholder = appearance.labels.composerPlaceholder;
    textarea.setAttribute('aria-label', appearance.labels.composerPlaceholder);
    queryRequired<HTMLElement>(this.shadowRoot, '.send').textContent = appearance.labels.send;
    this.#suggestions.render();
    if (!appearance.behavior.showLauncher)
      queryRequired<HTMLElement>(this.shadowRoot, '.launcher').hidden = true;
    if (!appearance.behavior.showHeader)
      queryRequired<HTMLElement>(this.shadowRoot, 'header').hidden = true;
    const legal = queryRequired<HTMLElement>(this.shadowRoot, '.legal');
    appendLegalLinks(legal, this.#appearance);
    this.#messages = this.shadowRoot.querySelector('.messages') ?? undefined;
    this.#messages?.append(...conversation);
    this.#thinking = this.#messages?.querySelector('.thinking') ?? undefined;
    this.#launcher.connect(this.shadowRoot);
    this.shadowRoot.querySelector('.close')?.addEventListener('click', () => this.close());
    const form = queryRequired<HTMLFormElement>(this.shadowRoot, '.composer');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.hasAttribute('busy')) {
        this.stop();
        return;
      }
      const value = textarea.value;
      textarea.value = '';
      textarea.style.height = 'auto';
      this.#sendGuarded(value);
    });
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      form.requestSubmit();
    });
    const newMessages = queryRequired<HTMLButtonElement>(this.shadowRoot, '.new-messages');
    newMessages.setAttribute('aria-label', appearance.labels.newMessages);
    this.#scroll.connect({
      region: queryRequired<HTMLElement>(this.shadowRoot, '.messages-region'),
      messages: queryRequired<HTMLElement>(this.shadowRoot, '.messages'),
      control: newMessages,
    });
    this.#applyTheme();
  }
}

export function registerNoodleAssistant(): void {
  if (globalThis.customElements && !customElements.get(ASSISTANT_TAG_NAME)) {
    customElements.define(ASSISTANT_TAG_NAME, NoodleAssistantElement);
  }
}
