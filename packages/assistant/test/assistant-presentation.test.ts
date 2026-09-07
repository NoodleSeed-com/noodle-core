// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE, resolveAppearance } from '../src/appearance.js';
import { parseAssistantConfiguration } from '../src/assistant-configuration-schema.js';
import type { NoodleAssistantElement } from '../src/element.js';
import { ASSISTANT_TAG_NAME, registerNoodleAssistant } from '../src/element.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('declarative assistant presentation', () => {
  it('keeps the rounded Halo panel colors as the complete zero-configuration baseline', () => {
    expect(DEFAULT_APPEARANCE.presentation).toMatchObject({
      panel: {
        surface: 'solid',
        elevation: 'soft',
        border: 'subtle',
      },
      launcher: {
        icon: 'brand-mark',
        size: 'md',
        status: 'none',
        effect: 'none',
      },
      header: { mark: 'none' },
      composer: { leadingIcon: 'none', sendIcon: 'arrow-up', shape: 'pill' },
      messages: { userStyle: 'bubble', assistantStyle: 'plain' },
    });
    expect(DEFAULT_APPEARANCE.behavior.showConfirmationDetails).toBe(false);
  });

  it('keeps technical confirmation details opt-in and ignores invalid values', () => {
    expect(
      resolveAppearance({
        assistant: { behavior: { showConfirmationDetails: true } },
      }).behavior.showConfirmationDetails,
    ).toBe(true);
    expect(
      parseAssistantConfiguration({
        assistant: { behavior: { showConfirmationDetails: 'sometimes' } },
      }),
    ).toBeUndefined();
    expect(resolveAppearance().behavior.showConfirmationDetails).toBe(false);
  });

  it('applies exact host appearance roles above deployment branding and reports low contrast', async () => {
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    const warnings: unknown[] = [];
    element.addEventListener('assistant-appearance-warning', (event) => {
      warnings.push((event as CustomEvent).detail);
    });
    element.style.setProperty('--ns-assistant-panel', '#FAFAFA');
    element.appearance = {
      light: {
        panel: { surface: '#FFFFFF', text: '#F8F8F8', border: '#D0D5DD' },
        composer: { surface: '#F7F8FA', text: '#111827', border: '#CBD5E1' },
        primaryButton: { surface: '#635BFF', text: '#FFFFFF' },
      },
    };
    element.setAttribute('theme', 'light');
    document.body.append(element);

    expect(element.style.getPropertyValue('--ns-assistant-panel')).toBe('#FFFFFF');
    expect(element.style.getPropertyValue('--ns-assistant-composer-border')).toBe('#CBD5E1');
    expect(element.style.getPropertyValue('--ns-assistant-primary-button')).toBe('#635BFF');
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'low_contrast', role: 'panel', theme: 'light' }),
    ]);
    element.appearance = undefined;
    expect(element.style.getPropertyValue('--ns-assistant-panel')).toBe('#FAFAFA');
  });

  it('accepts inherited host token references without inventing contrast warnings', async () => {
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    const warnings: unknown[] = [];
    element.addEventListener('assistant-appearance-warning', (event) => {
      warnings.push((event as CustomEvent).detail);
    });
    element.style.setProperty('--app-surface', '#071426');
    element.style.setProperty('--app-text', '#F8FAFC');
    element.appearance = {
      dark: {
        panel: { surface: 'var(--app-surface)', text: 'var(--app-text)' },
        composer: { surface: 'var(--app-surface)', text: 'var(--app-text)' },
      },
    };
    element.setAttribute('theme', 'dark');
    document.body.append(element);

    expect(element.style.getPropertyValue('--ns-assistant-panel')).toBe('var(--app-surface)');
    expect(element.style.getPropertyValue('--ns-assistant-panel-text')).toBe('var(--app-text)');
    expect(element.style.getPropertyValue('--ns-assistant-composer')).toBe('var(--app-surface)');
    expect(warnings).toEqual([]);
  });

  it('resolves bounded presentation options without creating another brand-color source', () => {
    const appearance = resolveAppearance({
      branding: { accent: '#123456', theme: { dark: { focus: '#ABCDEF' } } },
      assistant: {
        layout: { edgeOffset: 28 },
        presentation: {
          panel: { radius: 30, elevation: 'dramatic', border: 'strong' },
          launcher: { icon: 'chat', size: 'lg', status: 'session', effect: 'pulse' },
          messages: { userStyle: 'accent', assistantStyle: 'bubble' },
        },
      },
    });

    expect(appearance.layout.edgeOffset).toBe(28);
    expect(appearance.presentation.panel).toMatchObject({
      radius: 30,
      elevation: 'dramatic',
      border: 'strong',
    });
    expect(appearance.presentation.launcher).toMatchObject({
      icon: 'chat',
      size: 'lg',
      status: 'session',
      effect: 'pulse',
    });
    expect(appearance.theme.light.accent).toBe('#123456');
    expect(appearance.theme.dark.focus).toBe('#ABCDEF');
  });

  it('renders the Atlas session configuration in place using safe built-in primitives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
          configuration: {
            branding: { name: 'Atlas Support', colorScheme: 'light', accent: '#675CFF' },
            assistant: {
              layout: { edgeOffset: 20 },
              labels: {
                welcomeHeading: '<img src=x onerror=alert(1)> Ask Atlas',
                welcomeMessage: 'Fast, tool-aware support.',
                sessionReady: 'Atlas support is online',
              },
              presentation: {
                panel: {
                  surface: 'solid',
                  elevation: 'dramatic',
                  border: 'strong',
                  radius: 20,
                },
                launcher: {
                  icon: 'chat',
                  size: 'lg',
                  status: 'session',
                  effect: 'pulse',
                },
                header: {
                  mark: 'status',
                  badge: { text: 'ONLINE', tone: 'success', indicator: true },
                },
                composer: {
                  leadingIcon: 'brand-mark',
                  sendIcon: 'paper-plane',
                  shape: 'rounded',
                },
                messages: { userStyle: 'accent', assistantStyle: 'bubble' },
              },
            },
          },
        }),
      ),
    );

    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    const panel = element.shadowRoot?.querySelector('.panel');
    const messages = element.shadowRoot?.querySelector('.messages');

    await vi.waitFor(() => {
      expect(element.shadowRoot?.querySelector('.header-badge')?.textContent).toContain('ONLINE');
    });

    expect(element.shadowRoot?.querySelector('.panel')).toBe(panel);
    expect(element.shadowRoot?.querySelector('.messages')).toBe(messages);
    expect(element.dataset.panelSurface).toBe('solid');
    expect(element.dataset.panelElevation).toBe('dramatic');
    expect(element.dataset.panelBorder).toBe('strong');
    expect(element.dataset.launcherEffect).toBe('pulse');
    expect(element.dataset.messageUserStyle).toBe('accent');
    expect(element.dataset.messageAssistantStyle).toBe('bubble');
    expect(element.style.getPropertyValue('--ns-assistant-default-edge-offset')).toBe('20px');
    expect(element.style.getPropertyValue('--ns-assistant-presentation-panel-radius')).toBe('20px');
    expect(element.shadowRoot?.querySelector('.header-mark[data-variant="status"]')).toBeTruthy();
    expect(element.shadowRoot?.querySelector('.empty-state img')).toBeNull();
    expect(element.shadowRoot?.querySelector('.empty-state')?.textContent).toContain(
      '<img src=x onerror=alert(1)> Ask Atlas',
    );
    expect(
      element.shadowRoot?.querySelector('.composer-leading[data-icon="brand-mark"]'),
    ).toBeTruthy();
    expect(element.shadowRoot?.querySelector('.composer')?.getAttribute('data-shape')).toBe(
      'rounded',
    );
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>('.send')?.dataset.icon).toBe(
      'paper-plane',
    );
    expect(element.dataset.sessionState).toBe('ready');
    expect(element.shadowRoot?.querySelector('[data-session-status]')?.textContent).toBe(
      'Atlas support is online',
    );
  });
});
