import type { ResolvedAssistantAppearance } from './appearance.js';
import { queryRequired } from './element-helpers.js';

const COLLAPSED_LAUNCHER_WIDTH_PROPERTY = '--_ns-assistant-launcher-collapsed-width';

interface AssistantElementLauncherOptions {
  readonly host: HTMLElement;
  readonly appearance: () => ResolvedAssistantAppearance;
  readonly openPanel: () => void;
  readonly sendMessage: (message: string) => void;
}

/** Owns the accessible Halo pill/bubble morph without owning session or panel state. */
export class AssistantElementLauncherController {
  readonly #host: HTMLElement;
  readonly #appearance: () => ResolvedAssistantAppearance;
  readonly #openPanel: () => void;
  readonly #sendMessage: (message: string) => void;
  #root: ShadowRoot | undefined;
  #measurementFrame: number | undefined;

  constructor(options: AssistantElementLauncherOptions) {
    this.#host = options.host;
    this.#appearance = options.appearance;
    this.#openPanel = options.openPanel;
    this.#sendMessage = options.sendMessage;
  }

  connect(root: ShadowRoot): void {
    this.disconnect();
    this.#root = root;
    queryRequired<HTMLElement>(root, '.launcher').addEventListener(
      'click',
      this.#handleLauncherClick,
    );
    queryRequired<HTMLButtonElement>(root, '.launcher-trigger').addEventListener(
      'click',
      this.#handleTrigger,
    );
    queryRequired<HTMLFormElement>(root, '.launcher-form').addEventListener(
      'submit',
      this.#handleSubmit,
    );
    queryRequired<HTMLInputElement>(root, '.launcher-input').addEventListener(
      'keydown',
      this.#handleInputKeydown,
    );
    document.addEventListener('pointerdown', this.#handleDocumentPointerDown);
    this.sync();
  }

  disconnect(): void {
    document.removeEventListener('pointerdown', this.#handleDocumentPointerDown);
    this.#cancelWidthMeasurement();
    this.#host.style.removeProperty(COLLAPSED_LAUNCHER_WIDTH_PROPERTY);
    this.#root = undefined;
  }

  sync(): void {
    const root = this.#root;
    if (!root) return;
    const appearance = this.#appearance();
    const style = appearance.presentation.launcher.style;
    this.#host.dataset.launcherStyle = style;
    const trigger = queryRequired<HTMLButtonElement>(root, '.launcher-trigger');
    const label = queryRequired<HTMLElement>(root, '.launcher-label');
    const input = queryRequired<HTMLInputElement>(root, '.launcher-input');
    label.textContent = appearance.labels.launcherPlaceholder;
    input.placeholder = appearance.labels.launcherPlaceholder;
    input.setAttribute('aria-label', appearance.labels.launcherPlaceholder);
    trigger.setAttribute('aria-label', appearance.labels.open);
    queryRequired<HTMLButtonElement>(root, '.launcher-send').setAttribute(
      'aria-label',
      appearance.labels.send,
    );
    queryRequired<HTMLElement>(root, '.launcher').hidden = !appearance.behavior.showLauncher;
    queryRequired<HTMLElement>(root, '.powered-by-row').hidden = !appearance.behavior.showPoweredBy;
    if (style === 'bubble' || this.#host.hasAttribute('open')) {
      this.#cancelWidthMeasurement();
      this.#host.style.removeProperty(COLLAPSED_LAUNCHER_WIDTH_PROPERTY);
      this.collapse(true);
      return;
    }
    if (!this.#host.hasAttribute('launcher-expanded')) this.#scheduleWidthMeasurement();
  }

  collapse(force = false): void {
    const root = this.#root;
    if (!root) return;
    const input = queryRequired<HTMLInputElement>(root, '.launcher-input');
    if (!force && input.value.trim()) return;
    this.#host.removeAttribute('launcher-expanded');
    const form = queryRequired<HTMLFormElement>(root, '.launcher-form');
    const trigger = queryRequired<HTMLButtonElement>(root, '.launcher-trigger');
    form.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    input.tabIndex = -1;
    input.blur();
  }

  focusTrigger(): void {
    this.#root?.querySelector<HTMLButtonElement>('.launcher-trigger')?.focus();
  }

  #expand(): void {
    const root = this.#root;
    if (!root || this.#appearance().presentation.launcher.style === 'bubble') return;
    this.#cancelWidthMeasurement();
    this.#measureCollapsedWidth();
    void queryRequired<HTMLElement>(root, '.launcher').offsetWidth;
    this.#host.setAttribute('launcher-expanded', '');
    const form = queryRequired<HTMLFormElement>(root, '.launcher-form');
    const trigger = queryRequired<HTMLButtonElement>(root, '.launcher-trigger');
    const input = queryRequired<HTMLInputElement>(root, '.launcher-input');
    form.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    input.tabIndex = 0;
    requestAnimationFrame(() => {
      if (this.#host.hasAttribute('launcher-expanded')) input.focus();
    });
  }

  #scheduleWidthMeasurement(): void {
    this.#cancelWidthMeasurement();
    this.#host.style.removeProperty(COLLAPSED_LAUNCHER_WIDTH_PROPERTY);
    this.#measurementFrame = requestAnimationFrame(() => {
      this.#measurementFrame = undefined;
      this.#measureCollapsedWidth();
    });
  }

  #cancelWidthMeasurement(): void {
    if (this.#measurementFrame === undefined) return;
    cancelAnimationFrame(this.#measurementFrame);
    this.#measurementFrame = undefined;
  }

  #measureCollapsedWidth(): void {
    const root = this.#root;
    if (
      !root ||
      this.#host.hasAttribute('launcher-expanded') ||
      this.#appearance().presentation.launcher.style === 'bubble'
    ) {
      return;
    }
    const launcher = queryRequired<HTMLElement>(root, '.launcher');
    this.#host.style.removeProperty(COLLAPSED_LAUNCHER_WIDTH_PROPERTY);
    const collapsedWidth = launcher.offsetWidth;
    if (collapsedWidth > 0) {
      this.#host.style.setProperty(COLLAPSED_LAUNCHER_WIDTH_PROPERTY, `${collapsedWidth}px`);
    }
  }

  #handleTrigger = (): void => {
    if (this.#appearance().presentation.launcher.style === 'bubble') {
      this.#openPanel();
      return;
    }
    this.#expand();
  };

  #handleLauncherClick = (event: MouseEvent): void => {
    if (
      event
        .composedPath()
        .some(
          (target) =>
            target instanceof Element && target.matches('.launcher-trigger, .launcher-form'),
        )
    ) {
      return;
    }
    this.#handleTrigger();
  };

  #handleSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    const input = this.#root?.querySelector<HTMLInputElement>('.launcher-input');
    const message = input?.value.trim() ?? '';
    if (input) input.value = '';
    this.#openPanel();
    if (message) this.#sendMessage(message);
  };

  #handleInputKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      this.#root?.querySelector<HTMLFormElement>('.launcher-form')?.requestSubmit();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    const input = this.#root?.querySelector<HTMLInputElement>('.launcher-input');
    if (input) input.value = '';
    this.collapse(true);
    this.focusTrigger();
  };

  #handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.composedPath().includes(this.#host)) return;
    this.collapse(true);
  };
}
