// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE, resolveAppearance } from '../src/appearance.js';
import {
  ASSISTANT_TAG_NAME,
  type NoodleAssistantElement,
  registerNoodleAssistant,
} from '../src/element.js';
import { ASSISTANT_ELEMENT_STYLES } from '../src/element-styles.js';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
  document.documentElement.style.removeProperty('color-scheme');
  vi.restoreAllMocks();
});

describe('Halo assistant baseline', () => {
  it('makes the original Halo geometry and pill launcher the zero-configuration contract', () => {
    expect(DEFAULT_APPEARANCE.theme.light.panel).toBe('#F8F8F8');
    expect(DEFAULT_APPEARANCE.theme.dark.panel).toBe('#0C0A09');
    expect(DEFAULT_APPEARANCE.presentation.panel.surface).toBe('solid');
    expect(DEFAULT_APPEARANCE.layout).toMatchObject({
      mode: 'floating',
      position: 'bottom-center',
      panelWidth: 970,
      panelMaxHeight: 1025,
      mobileFullscreen: true,
    });
    expect(DEFAULT_APPEARANCE.presentation.launcher).toMatchObject({
      style: 'pill',
      icon: 'brand-mark',
    });
    expect(DEFAULT_APPEARANCE.behavior.showPoweredBy).toBe(true);
    expect(DEFAULT_APPEARANCE.labels).toMatchObject({
      welcomeHeading: '',
      launcherPlaceholder: 'Chat with us',
    });
    expect(DEFAULT_APPEARANCE.suggestedPrompts).toEqual([]);
    expect(DEFAULT_APPEARANCE.suggestedPromptsSource).toBe('model');
    expect(ASSISTANT_ELEMENT_STYLES).toContain('height: min(85dvh');
    expect(ASSISTANT_ELEMENT_STYLES).toContain('max-width: 970px');
    expect(ASSISTANT_ELEMENT_STYLES).toContain('width: calc(100% - 40px)');
    expect(ASSISTANT_ELEMENT_STYLES).toContain(
      'width: var(--_ns-assistant-launcher-collapsed-width, max-content)',
    );
    expect(ASSISTANT_ELEMENT_STYLES).toMatch(/:host \{[^}]*box-sizing: border-box/);
  });

  it('uses the business name in the launcher while retaining every existing override', () => {
    const appearance = resolveAppearance({
      branding: {
        name: 'Acme',
        colorScheme: 'dark',
        surface: '#EEF2FF',
        surfaceDark: '#111827',
      },
      assistant: {
        theme: 'invert',
        layout: { position: 'bottom-right', panelWidth: 640 },
        behavior: { showPoweredBy: false, showTimestamps: true },
        labels: { launcherPlaceholder: 'Ask Acme anything' },
        presentation: {
          launcher: { style: 'bubble', icon: 'chat', size: 'lg', effect: 'pulse' },
          panel: { surface: 'solid', radius: 20 },
          messages: { userStyle: 'accent', assistantStyle: 'bubble' },
        },
      },
    });

    expect(appearance.theme.defaultMode).toBe('invert');
    expect(appearance.theme.light.panel).toBe('#EEF2FF');
    expect(appearance.theme.dark.panel).toBe('#111827');
    expect(appearance.layout).toMatchObject({ position: 'bottom-right', panelWidth: 640 });
    expect(appearance.behavior).toMatchObject({ showPoweredBy: false, showTimestamps: true });
    expect(appearance.labels.launcherPlaceholder).toBe('Ask Acme anything');
    expect(appearance.presentation.launcher).toMatchObject({
      style: 'bubble',
      icon: 'chat',
      size: 'lg',
      effect: 'pulse',
    });

    const brandedDefaults = resolveAppearance({ branding: { name: 'Acme' } });
    expect(brandedDefaults.labels.launcherPlaceholder).toBe('Chat with Acme');
    expect(brandedDefaults.suggestedPrompts).toEqual([]);
    expect(brandedDefaults.suggestedPromptsSource).toBe('model');
    expect(
      resolveAppearance({ assistant: { suggestedPrompts: ['Ask Acme'] } }).suggestedPromptsSource,
    ).toBe('configured');
  });

  it('morphs a pill into an input without opening, then opens with the typed first message', () => {
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    document.body.append(element);
    const send = vi.spyOn(element, 'sendMessage').mockResolvedValue();
    const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger');
    const input = element.shadowRoot?.querySelector<HTMLInputElement>('.launcher-input');

    trigger?.click();
    expect(element.hasAttribute('launcher-expanded')).toBe(true);
    expect(element.hasAttribute('open')).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    if (!input) throw new Error('missing Halo launcher input');
    input.value = 'Show me the latest logs';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(element.hasAttribute('open')).toBe(true);
    expect(send).toHaveBeenCalledWith('Show me the latest logs');
    expect(input.value).toBe('');
  });

  it('measures an animatable pill width and collapses outside without discarding a draft', () => {
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    document.body.append(element);
    const launcher = element.shadowRoot?.querySelector<HTMLElement>('.launcher');
    const trigger = element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger');
    const input = element.shadowRoot?.querySelector<HTMLInputElement>('.launcher-input');
    if (!launcher || !trigger || !input) throw new Error('missing Halo launcher controls');
    Object.defineProperty(launcher, 'offsetWidth', { configurable: true, value: 216 });

    trigger.click();

    expect(element.style.getPropertyValue('--_ns-assistant-launcher-collapsed-width')).toBe(
      '216px',
    );
    expect(element.hasAttribute('launcher-expanded')).toBe(true);
    input.value = 'Keep this draft';

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));

    expect(element.hasAttribute('launcher-expanded')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(input.value).toBe('Keep this draft');
  });

  it('renders the baseline powered-by row', () => {
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    document.body.append(element);

    const poweredBy = element.shadowRoot?.querySelector<HTMLAnchorElement>('.powered-by');
    expect(poweredBy?.textContent).toContain('Powered by');
    expect(poweredBy?.textContent).toContain('Noodle Seed');
    expect(poweredBy?.href).toBe('https://noodleseed.com/');
  });

  it('opens a configured bubble directly and can hide the powered-by row', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
        configuration: {
          assistant: {
            behavior: { showPoweredBy: false },
            presentation: { launcher: { style: 'bubble' } },
          },
        },
      }),
    );
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.fetch = fetchMock;
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await vi.waitFor(() => expect(element.dataset.launcherStyle).toBe('bubble'));
    element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger')?.click();

    expect(element.hasAttribute('open')).toBe(true);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.activeElement).toBe(
        element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea'),
      ),
    );
    expect(element.shadowRoot?.querySelector<HTMLElement>('.powered-by-row')?.hidden).toBe(true);
  });

  it('resolves auto from the host page and invert to the opposite host mode', () => {
    registerNoodleAssistant();
    document.documentElement.setAttribute('data-theme', 'dark');
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    document.body.append(element);

    expect(element.getAttribute('data-theme')).toBe('dark');
    element.setAttribute('theme', 'invert');
    expect(element.getAttribute('data-theme')).toBe('light');
  });

  it('inherits the host document color scheme when no theme attribute is present', () => {
    registerNoodleAssistant();
    document.documentElement.style.colorScheme = 'dark';
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    document.body.append(element);

    expect(element.getAttribute('data-theme')).toBe('dark');
  });

  it('uses an injected fetch implementation for authenticated managed embeds', async () => {
    registerNoodleAssistant();
    const globalFetch = vi.fn<typeof fetch>();
    const injectedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
      }),
    );
    vi.stubGlobal('fetch', globalFetch);
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.fetch = injectedFetch;
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await vi.waitFor(() => expect(injectedFetch).toHaveBeenCalledTimes(1));
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
