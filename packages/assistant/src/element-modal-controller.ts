import { ASSISTANT_MOBILE_FULLSCREEN_MAX_WIDTH } from './element-layout.js';

export const MODAL_ATTRIBUTES = ['data-presentation-ready', 'mobile-fullscreen', 'open'] as const;

interface AssistantElementModalControllerOptions {
  readonly host: HTMLElement;
  readonly panel: () => HTMLElement | undefined;
  readonly fallbackFocus: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'iframe',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Owns modality only while the responsive layout actually occupies the full viewport. */
export class AssistantElementModalController {
  readonly #host: HTMLElement;
  readonly #panel: () => HTMLElement | undefined;
  readonly #fallbackFocus: () => void;
  readonly #inerted = new Set<HTMLElement>();
  #media: MediaQueryList | undefined;
  #active = false;
  #closing = false;
  #returnFocus: HTMLElement | undefined;

  constructor(options: AssistantElementModalControllerOptions) {
    this.#host = options.host;
    this.#panel = options.panel;
    this.#fallbackFocus = options.fallbackFocus;
  }

  connect(): void {
    this.disconnect();
    this.#media = globalThis.matchMedia?.(
      `(max-width: ${ASSISTANT_MOBILE_FULLSCREEN_MAX_WIDTH}px)`,
    );
    this.#media?.addEventListener('change', this.#handleMediaChange);
    globalThis.addEventListener?.('resize', this.#handleMediaChange);
    this.#panel()
      ?.querySelector<HTMLElement>('[data-focus-start]')
      ?.addEventListener('focus', this.#focusLast);
    this.#panel()
      ?.querySelector<HTMLElement>('[data-focus-end]')
      ?.addEventListener('focus', this.#focusFirst);
    this.sync();
  }

  disconnect(): void {
    this.#media?.removeEventListener('change', this.#handleMediaChange);
    globalThis.removeEventListener?.('resize', this.#handleMediaChange);
    this.#panel()
      ?.querySelector<HTMLElement>('[data-focus-start]')
      ?.removeEventListener('focus', this.#focusLast);
    this.#panel()
      ?.querySelector<HTMLElement>('[data-focus-end]')
      ?.removeEventListener('focus', this.#focusFirst);
    this.#deactivate();
    this.#media = undefined;
    this.#returnFocus = undefined;
  }

  captureFocus(): void {
    if (this.#returnFocus?.isConnected) return;
    const focused = composedActiveElement(this.#host.ownerDocument);
    if (
      focused &&
      focused !== this.#host.ownerDocument.body &&
      focused !== this.#host.ownerDocument.documentElement &&
      focused !== this.#host &&
      focused.getRootNode() !== this.#host.shadowRoot &&
      !this.#host.contains(focused)
    ) {
      this.#returnFocus = focused;
    }
  }

  handleAttributeChange(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'open' && oldValue === null && newValue !== null) this.captureFocus();
    if (name === 'open' || name === 'mobile-fullscreen' || name === 'data-presentation-ready') {
      this.sync();
    }
    if (name === 'open' && oldValue !== null && newValue === null && !this.#closing) {
      this.restoreFocus();
    }
  }

  close(removeOpenAttribute: () => void): void {
    this.#closing = true;
    try {
      removeOpenAttribute();
    } finally {
      this.#closing = false;
    }
    this.restoreFocus();
  }

  restoreFocus(): void {
    const target = this.#returnFocus;
    this.#returnFocus = undefined;
    if (target?.isConnected && !target.closest('[inert]')) {
      target.focus();
      return;
    }
    this.#fallbackFocus();
  }

  sync(): void {
    const panel = this.#panel();
    const shouldActivate =
      panel !== undefined &&
      this.#host.hasAttribute('open') &&
      this.#host.hasAttribute('data-presentation-ready') &&
      this.#host.hasAttribute('mobile-fullscreen') &&
      this.#media?.matches === true;
    if (shouldActivate) this.#activate(panel);
    else this.#deactivate();
  }

  #activate(panel: HTMLElement): void {
    panel.setAttribute('aria-modal', 'true');
    for (const sentinel of panel.querySelectorAll<HTMLElement>(
      '[data-focus-start], [data-focus-end]',
    )) {
      sentinel.tabIndex = 0;
    }
    if (this.#active) return;
    this.#active = true;
    for (const sibling of backgroundSiblings(this.#host)) {
      if (sibling.hasAttribute('inert')) continue;
      sibling.inert = true;
      this.#inerted.add(sibling);
    }
  }

  #deactivate(): void {
    const panel = this.#panel();
    panel?.removeAttribute('aria-modal');
    for (const sentinel of panel?.querySelectorAll<HTMLElement>(
      '[data-focus-start], [data-focus-end]',
    ) ?? []) {
      sentinel.tabIndex = -1;
    }
    for (const element of this.#inerted) element.inert = false;
    this.#inerted.clear();
    this.#active = false;
  }

  readonly #handleMediaChange = (): void => this.sync();

  readonly #focusFirst = (): void => {
    this.#focusable()[0]?.focus();
  };

  readonly #focusLast = (): void => {
    this.#focusable().at(-1)?.focus();
  };

  #focusable(): HTMLElement[] {
    const panel = this.#panel();
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (candidate) =>
        !candidate.matches('[data-focus-start], [data-focus-end]') &&
        !candidate.closest('[hidden]') &&
        candidate.getAttribute('aria-hidden') !== 'true',
    );
  }
}

function composedActiveElement(document: Document): HTMLElement | undefined {
  let active = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : undefined;
}

function backgroundSiblings(host: HTMLElement): HTMLElement[] {
  const siblings = new Set<HTMLElement>();
  let branch: Node = host;
  while (branch.parentNode) {
    const parent = branch.parentNode;
    for (const candidate of parent.childNodes) {
      if (candidate !== branch && candidate instanceof HTMLElement) siblings.add(candidate);
    }
    if (parent === host.ownerDocument.body) break;
    branch = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return [...siblings];
}
