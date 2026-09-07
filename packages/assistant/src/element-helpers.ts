import type { AssistantThemeTokens, ResolvedAssistantAppearance } from './appearance.js';

export function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function tokenValue(
  name: string,
  value: AssistantThemeTokens[keyof AssistantThemeTokens],
): string {
  if (typeof value !== 'number') return value;
  if (name === 'lineHeight' || name === 'motionScale') return String(value);
  return `${value}px`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

export function queryRequired<T extends Element>(root: ShadowRoot, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`assistant renderer is missing ${selector}`);
  return element;
}

/** The element's complete shadow-root markup, a pure function of appearance and open state. */
export function assistantElementMarkup(
  appearance: ResolvedAssistantAppearance,
  styles: string,
): string {
  return `${styles}
      <div class="launcher">
        <slot name="launcher-icon"></slot>
        <span class="launcher-loader" aria-hidden="true"></span>
        <button class="launcher-trigger" type="button" aria-label="${escapeAttribute(appearance.labels.open)}" aria-controls="assistant-launcher-form" aria-expanded="false">
          <span class="launcher-label">${escapeAttribute(appearance.labels.launcherPlaceholder)}</span>
          <span class="launcher-arrow" aria-hidden="true"></span>
        </button>
        <form class="launcher-form" id="assistant-launcher-form" aria-hidden="true" autocomplete="off">
          <input class="launcher-input" type="text" aria-label="${escapeAttribute(appearance.labels.launcherPlaceholder)}" placeholder="${escapeAttribute(appearance.labels.launcherPlaceholder)}" tabindex="-1">
          <button class="launcher-send" type="submit" aria-label="${escapeAttribute(appearance.labels.send)}"></button>
        </form>
        <span class="visually-hidden" data-session-status aria-live="polite" hidden></span>
      </div>
      <section class="panel" id="assistant-panel" role="dialog" aria-label="${escapeAttribute(appearance.brand.name)}">
        <span class="visually-hidden" data-focus-start tabindex="-1"></span>
        <header><slot name="header-leading"></slot><img class="brand-logo" alt=""><strong></strong><slot name="header-actions"></slot><button class="close" type="button" aria-label="${escapeAttribute(appearance.labels.close)}"></button></header>
        <div class="welcome"><slot name="empty-state"></slot></div>
        <div class="messages-region">
          <div class="messages" aria-live="polite"></div>
          <button class="new-messages" type="button" aria-label="${escapeAttribute(appearance.labels.newMessages)}" hidden></button>
        </div>
        <div class="input-section">
          <div class="suggested-prompts"></div>
          <form class="composer"><slot name="composer-leading"></slot><textarea rows="1"></textarea><button class="send" type="submit"></button><slot name="composer-trailing"></slot></form>
        </div>
        <nav class="legal" aria-label="Legal"></nav>
        <div class="powered-by-row">
          <a class="powered-by" href="https://noodleseed.com" target="_blank" rel="noopener noreferrer">
            <span>Powered by</span>
            <span class="powered-by-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" rx="8" fill="currentColor" fill-opacity="0.12"></rect><path d="M8.58023 12.8485C6.27833 12.8463 4.41315 11.0141 4.42117 8.75681L4.43588 4.61714L8.66254 4.62118C10.9644 4.62339 12.8296 6.45561 12.8216 8.71287C12.8135 10.9975 10.9128 12.8507 8.58023 12.8485Z" fill="currentColor"></path><path d="M8.82627 4.76869C11.1282 4.7709 12.9933 6.60312 12.9853 8.86038L12.9706 13L8.74395 12.996C6.44206 12.9938 4.57687 11.1616 4.5849 8.90432C4.59302 6.6197 6.49364 4.76646 8.82627 4.76869Z" fill="currentColor"></path><ellipse cx="3.69536" cy="3.68106" rx="0.695363" ry="0.681056" fill="currentColor"></ellipse></svg></span>
            <span class="powered-by-name">Noodle Seed</span>
          </a>
        </div>
        <slot name="conversation-footer"></slot>
        <span class="visually-hidden" data-focus-end tabindex="-1"></span>
      </section>`;
}

/** Append the privacy/terms links the appearance declares; absent URLs render nothing. */
export function appendLegalLinks(
  legal: HTMLElement,
  appearance: Pick<ResolvedAssistantAppearance, 'privacyUrl' | 'termsUrl'>,
): void {
  for (const [label, href] of [
    ['Privacy', appearance.privacyUrl],
    ['Terms', appearance.termsUrl],
  ] as const) {
    if (!href) continue;
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    legal.append(link);
  }
}
