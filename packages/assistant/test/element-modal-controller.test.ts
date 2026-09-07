// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantElementModalController } from '../src/element-modal-controller.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('AssistantElementModalController', () => {
  it('applies modality only at the fullscreen breakpoint and preserves host-owned inert state', () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: true,
      addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
    } as MediaQueryList;
    vi.stubGlobal('matchMedia', () => media);

    const ordinaryBackground = document.createElement('main');
    const preexistingInert = document.createElement('aside');
    preexistingInert.inert = true;
    const host = document.createElement('div');
    host.toggleAttribute('open', true);
    host.toggleAttribute('mobile-fullscreen', true);
    host.toggleAttribute('data-presentation-ready', true);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<section class="panel"><span data-focus-start tabindex="-1"></span><button>Close</button><span data-focus-end tabindex="-1"></span></section>`;
    document.body.append(ordinaryBackground, preexistingInert, host);
    const panel = root.querySelector<HTMLElement>('.panel');
    const controller = new AssistantElementModalController({
      host,
      panel: () => panel ?? undefined,
      fallbackFocus: () => {},
    });

    controller.connect();
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(ordinaryBackground.inert).toBe(true);
    expect(preexistingInert.inert).toBe(true);

    Object.defineProperty(media, 'matches', { value: false });
    for (const listener of listeners) listener();
    expect(panel?.hasAttribute('aria-modal')).toBe(false);
    expect(ordinaryBackground.inert).toBe(false);
    expect(preexistingInert.inert).toBe(true);

    controller.disconnect();
    expect(preexistingInert.inert).toBe(true);
  });
});
