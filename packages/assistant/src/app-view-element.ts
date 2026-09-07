import { mountAssistantApp, unmountAssistantApp, updateAssistantAppTheme } from './app-host.js';
import { ASSISTANT_APP_VIEW_STYLES } from './app-view-styles.js';
import type { AssistantClient, AssistantViewAvailableDetail } from './client.js';
import type { AssistantErrorDetail } from './transport.js';

export const APP_VIEW_TAG_NAME = 'noodle-app-view';

export interface AssistantAppViewErrorDetail {
  readonly code: 'view_render_timeout';
  readonly retryable: false;
}

declare global {
  interface HTMLElementTagNameMap {
    'noodle-app-view': NoodleAppViewElement;
  }

  interface HTMLElementEventMap {
    'assistant-error': CustomEvent<AssistantErrorDetail>;
  }
}

const HTMLElementBase: typeof HTMLElement =
  globalThis.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

function viewIdentity(view: AssistantViewAvailableDetail): string {
  return `${view.id}\u0000${view.resourceUri}`;
}

/**
 * Framework-neutral host for one service-resolved MCP App view.
 *
 * `client` and `view` are object properties, not serialized attributes. Vue, Angular, and plain DOM
 * renderers can therefore pass the same `data-view` payload without taking a React dependency.
 */
export class NoodleAppViewElement extends HTMLElementBase {
  static readonly observedAttributes = ['allow-fullscreen', 'theme'];

  #allowFullscreen = false;
  #client: AssistantClient | undefined;
  #view: AssistantViewAvailableDetail | undefined;
  #theme: 'light' | 'dark' = 'light';
  #container: HTMLElement | undefined;
  #mounted: HTMLElement | undefined;
  #mountedClient: AssistantClient | undefined;
  #mountedAllowFullscreen = false;
  #mountedIdentity: string | undefined;
  #requestedTeardown: { readonly client: AssistantClient; readonly identity: string } | undefined;

  get client(): AssistantClient | undefined {
    return this.#client;
  }

  /** Allow the hosted App to request fullscreen. Disabled by default. */
  get allowFullscreen(): boolean {
    return this.#allowFullscreen;
  }

  set allowFullscreen(value: boolean) {
    const next = value === true;
    if (next === this.#allowFullscreen) return;
    this.#allowFullscreen = next;
    this.toggleAttribute('allow-fullscreen', next);
    this.#reconcile();
  }

  set client(value: AssistantClient | undefined) {
    if (value === this.#client) return;
    this.#client = value;
    this.#reconcile();
  }

  get view(): AssistantViewAvailableDetail | undefined {
    return this.#view;
  }

  set view(value: AssistantViewAvailableDetail | undefined) {
    this.#view = value;
    this.#reconcile();
  }

  get theme(): 'light' | 'dark' {
    return this.#theme;
  }

  set theme(value: 'light' | 'dark') {
    const next = value === 'dark' ? 'dark' : 'light';
    const changed = next !== this.#theme;
    this.#theme = next;
    if (this.getAttribute('data-theme') !== next) this.setAttribute('data-theme', next);
    if (changed && this.#mounted) updateAssistantAppTheme(this.#mounted, next);
  }

  connectedCallback(): void {
    this.#ensureContainer();
    this.#upgradeProperty('allowFullscreen');
    this.#upgradeProperty('client');
    this.#upgradeProperty('theme');
    this.#upgradeProperty('view');
    this.#reconcile();
  }

  disconnectedCallback(): void {
    this.#requestedTeardown = undefined;
    this.#releaseMount();
  }

  attributeChangedCallback(name: string, _previous: string | null, value: string | null): void {
    if (name === 'allow-fullscreen') this.allowFullscreen = value !== null;
    if (name === 'theme') this.theme = value === 'dark' ? 'dark' : 'light';
  }

  #ensureContainer(): HTMLElement {
    if (this.#container) return this.#container;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = ASSISTANT_APP_VIEW_STYLES;
    const container = document.createElement('div');
    container.className = 'noodle-app-mount';
    container.setAttribute('part', 'mount');
    root.append(container);
    this.#container = container;
    return container;
  }

  #upgradeProperty(name: 'allowFullscreen' | 'client' | 'theme' | 'view'): void {
    const property = Object.getOwnPropertyDescriptor(this, name);
    if (!property) return;
    Reflect.deleteProperty(this, name);
    Reflect.set(this, name, property.value);
  }

  #releaseMount(): void {
    const mounted = this.#mounted;
    this.#mounted = undefined;
    this.#mountedClient = undefined;
    this.#mountedAllowFullscreen = false;
    this.#mountedIdentity = undefined;
    this.#container?.replaceChildren();
    if (mounted) void unmountAssistantApp(mounted);
  }

  #reconcile(): void {
    if (!this.isConnected) return;
    const client = this.#client;
    const detail = this.#view;
    const identity = detail ? viewIdentity(detail) : undefined;

    if (this.#mounted) {
      if (
        client === this.#mountedClient &&
        identity === this.#mountedIdentity &&
        this.#allowFullscreen === this.#mountedAllowFullscreen
      ) {
        return;
      }
      this.#releaseMount();
    }

    if (
      this.#requestedTeardown &&
      (client !== this.#requestedTeardown.client || identity !== this.#requestedTeardown.identity)
    ) {
      this.#requestedTeardown = undefined;
    }
    if (!client || !detail?.html || !identity || this.#requestedTeardown) return;

    const initialHtml = detail.html;
    const sandboxUrl = client.appSandboxUrl?.();
    let card: HTMLElement | undefined;
    card = mountAssistantApp(
      detail,
      {
        client,
        sendMessage: (message) => client.sendMessage(message),
        updateModelContext: (update) => client.updateModelContext(update),
        theme: this.#theme,
      },
      {
        allowFullscreen: this.#allowFullscreen,
        ...(sandboxUrl ? { sandboxUrl } : {}),
        getDetail: () => {
          const latest = this.#view;
          if (this.#client !== client || !latest || viewIdentity(latest) !== identity)
            return detail;
          return latest.html ? latest : { ...latest, html: initialHtml };
        },
        onRenderFailure: (failure) => {
          this.dispatchEvent(
            new CustomEvent<AssistantAppViewErrorDetail>('assistant-error', {
              detail: failure,
              bubbles: true,
              composed: true,
            }),
          );
        },
        onTeardownRequest: () => {
          if (this.#mounted !== card) return;
          this.#mounted = undefined;
          this.#mountedClient = undefined;
          this.#mountedIdentity = undefined;
          this.#requestedTeardown = { client, identity };
        },
      },
    );
    if (!card) return;
    this.#mounted = card;
    this.#mountedClient = client;
    this.#mountedAllowFullscreen = this.#allowFullscreen;
    this.#mountedIdentity = identity;
    this.#ensureContainer().replaceChildren(card);
  }
}
