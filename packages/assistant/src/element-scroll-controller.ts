interface AssistantScrollElements {
  readonly region: HTMLElement;
  readonly messages: HTMLElement;
  readonly control: HTMLButtonElement;
}

/** Keeps transcript anchoring, edge fades, and the jump-to-latest affordance in sync. */
export class AssistantElementScrollController {
  #region: HTMLElement | undefined;
  #messages: HTMLElement | undefined;
  #control: HTMLButtonElement | undefined;
  #mutationObserver: MutationObserver | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #syncScheduled = false;
  #followingLatest = true;
  #lastScrollTop = 0;

  connect(elements: AssistantScrollElements): void {
    this.disconnect();
    this.#region = elements.region;
    this.#messages = elements.messages;
    this.#control = elements.control;
    this.#lastScrollTop = elements.messages.scrollTop;
    this.#followingLatest = this.#distanceFromBottom() <= 30;
    elements.messages.addEventListener('scroll', this.#handleScroll, { passive: true });
    elements.control.addEventListener('click', this.#handleControlClick);

    if (globalThis.MutationObserver) {
      this.#mutationObserver = new MutationObserver(() => this.#scheduleContentSync());
      this.#mutationObserver.observe(elements.messages, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
      });
    }
    if (globalThis.ResizeObserver) {
      this.#resizeObserver = new ResizeObserver(() => this.#scheduleContentSync());
      this.#resizeObserver.observe(elements.messages);
    }
    this.sync();
  }

  disconnect(): void {
    this.#messages?.removeEventListener('scroll', this.#handleScroll);
    this.#control?.removeEventListener('click', this.#handleControlClick);
    this.#mutationObserver?.disconnect();
    this.#resizeObserver?.disconnect();
    this.#region?.removeAttribute('data-can-scroll-up');
    this.#region?.removeAttribute('data-can-scroll-down');
    this.#region = undefined;
    this.#messages = undefined;
    this.#control = undefined;
    this.#mutationObserver = undefined;
    this.#resizeObserver = undefined;
    this.#syncScheduled = false;
    this.#followingLatest = true;
    this.#lastScrollTop = 0;
  }

  revealLatest(): void {
    if (!this.#messages) return;
    if (this.#followingLatest || this.#distanceFromBottom() <= 160) {
      this.scrollToBottom();
      return;
    }
    this.sync();
  }

  scrollToBottom(): void {
    if (!this.#messages) return;
    this.#followingLatest = true;
    this.#messages.scrollTop = this.#messages.scrollHeight;
    this.sync();
  }

  sync(): void {
    if (!this.#messages || !this.#region || !this.#control) return;
    const distance = this.#distanceFromBottom();
    this.#region.toggleAttribute('data-can-scroll-up', this.#messages.scrollTop > 20);
    this.#region.toggleAttribute('data-can-scroll-down', distance > 20);
    this.#control.hidden = distance <= 100;
  }

  readonly #handleScroll = (): void => {
    if (!this.#messages) return;
    const distance = this.#distanceFromBottom();
    const movedUp = this.#messages.scrollTop < this.#lastScrollTop - 5;
    this.#lastScrollTop = this.#messages.scrollTop;
    if (movedUp && distance > 50) this.#followingLatest = false;
    if (distance < 30) this.#followingLatest = true;
    this.sync();
  };

  readonly #handleControlClick = (): void => {
    this.scrollToBottom();
  };

  #distanceFromBottom(): number {
    if (!this.#messages) return 0;
    return this.#messages.scrollHeight - this.#messages.scrollTop - this.#messages.clientHeight;
  }

  #scheduleContentSync(): void {
    if (this.#syncScheduled) return;
    this.#syncScheduled = true;
    queueMicrotask(() => {
      this.#syncScheduled = false;
      if (this.#followingLatest) {
        this.#pinToBottom();
      } else {
        this.sync();
      }
    });
  }

  #pinToBottom(): void {
    if (!this.#messages) return;
    this.#followingLatest = true;
    if (typeof this.#messages.scrollTo === 'function') {
      this.#messages.scrollTo({
        top: this.#messages.scrollHeight,
        behavior: 'instant',
      } as ScrollToOptions);
    } else {
      this.#messages.scrollTop = this.#messages.scrollHeight;
    }
    this.sync();
  }
}
