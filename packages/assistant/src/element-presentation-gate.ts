/** Keeps session-backed panels out of the visual tree until their deployment appearance is resolved. */
export class AssistantElementPresentationGate {
  readonly #host: HTMLElement;
  readonly #primeSession: () => void;
  readonly #focusComposer: () => void;

  constructor(host: HTMLElement, primeSession: () => void, focusComposer: () => void) {
    this.#host = host;
    this.#primeSession = primeSession;
    this.#focusComposer = focusComposer;
  }

  syncOpenState(): void {
    const open = this.#host.hasAttribute('open');
    const presentationReady = this.#host.hasAttribute('data-presentation-ready');
    const publicConfigurationLoading = this.#host.hasAttribute('data-public-configuration-loading');
    const presentationBlocked = !presentationReady && (open || publicConfigurationLoading);
    const launcher = this.#host.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger');
    launcher?.setAttribute('aria-busy', String(presentationBlocked));
    if (launcher) launcher.disabled = presentationBlocked;
    this.#host.shadowRoot
      ?.querySelector<HTMLElement>('.panel')
      ?.setAttribute('aria-hidden', String(!(open && presentationReady)));
    if (open && this.#host.isConnected) this.#primeSession();
  }

  reveal(): void {
    if (this.#host.hasAttribute('data-presentation-ready')) return;
    this.#host.setAttribute('data-presentation-ready', '');
    this.syncOpenState();
    if (this.#host.hasAttribute('open')) queueMicrotask(this.#focusComposer);
  }
}
