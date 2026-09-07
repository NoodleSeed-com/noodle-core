import type { AssistantThemeMode, ResolvedAssistantAppearance } from './appearance.js';
import {
  type ResolvedAssistantThemeMode,
  resolveAssistantTheme,
} from './element-theme-resolution.js';

interface AssistantElementHostEnvironmentOptions {
  readonly host: HTMLElement;
  readonly appearance: () => ResolvedAssistantAppearance;
  readonly applyTheme: () => void;
  readonly close: () => void;
}

/** Owns host-document signals that affect theme selection and dismiss behavior. */
export class AssistantElementHostEnvironmentController {
  readonly #host: HTMLElement;
  readonly #appearance: () => ResolvedAssistantAppearance;
  readonly #applyTheme: () => void;
  readonly #close: () => void;
  #media: MediaQueryList | undefined;
  #themeObserver: MutationObserver | undefined;

  constructor(options: AssistantElementHostEnvironmentOptions) {
    this.#host = options.host;
    this.#appearance = options.appearance;
    this.#applyTheme = options.applyTheme;
    this.#close = options.close;
  }

  get media(): MediaQueryList | undefined {
    return this.#media;
  }

  resolvedTheme(): ResolvedAssistantThemeMode {
    return resolveAssistantTheme({
      host: this.#host,
      configured:
        (this.#host.getAttribute('theme') as AssistantThemeMode | null) ??
        this.#appearance().theme.defaultMode,
      ...(this.#media ? { media: this.#media } : {}),
    });
  }

  connect(): void {
    this.disconnect();
    this.#media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    this.#media?.addEventListener('change', this.#applyTheme);
    this.#themeObserver = new MutationObserver(this.#applyTheme);
    for (let node = this.#host.parentElement; node; node = node.parentElement) {
      this.#themeObserver.observe(node, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'data-mode', 'style'],
      });
    }
    document.addEventListener('keydown', this.#handleDocumentKeydown);
    document.addEventListener('pointerdown', this.#handleDocumentPointerDown);
  }

  disconnect(): void {
    this.#media?.removeEventListener('change', this.#applyTheme);
    this.#media = undefined;
    this.#themeObserver?.disconnect();
    this.#themeObserver = undefined;
    document.removeEventListener('keydown', this.#handleDocumentKeydown);
    document.removeEventListener('pointerdown', this.#handleDocumentPointerDown);
  }

  #handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (
      event.key === 'Escape' &&
      this.#host.hasAttribute('open') &&
      this.#appearance().behavior.closeOnEscape
    ) {
      this.#close();
    }
  };

  #handleDocumentPointerDown = (event: PointerEvent): void => {
    if (
      this.#host.hasAttribute('open') &&
      this.#appearance().behavior.closeOnOutsideClick &&
      !event.composedPath().includes(this.#host)
    ) {
      this.#close();
    }
  };
}
