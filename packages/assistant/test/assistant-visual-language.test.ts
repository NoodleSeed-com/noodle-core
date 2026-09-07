// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE } from '../src/appearance.js';
import {
  ASSISTANT_TAG_NAME,
  type NoodleAssistantElement,
  registerNoodleAssistant,
} from '../src/element.js';
import { AssistantElementEventController } from '../src/element-event-controller.js';
import { AssistantElementScrollController } from '../src/element-scroll-controller.js';
import { ASSISTANT_ELEMENT_STYLES } from '../src/element-styles.js';
import { presentationStyles } from '../src/presentation-styles.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('assistant visual language', () => {
  it('uses the original rounded Halo panel colors as the zero-configuration baseline', () => {
    expect(DEFAULT_APPEARANCE.presentation.panel).toMatchObject({
      surface: 'solid',
      elevation: 'soft',
      border: 'subtle',
    });
    expect(DEFAULT_APPEARANCE.theme.light).toMatchObject({
      panel: '#F8F8F8',
      panelRadius: 24,
      cardRadius: 16,
      inputRadius: 999,
      buttonRadius: 999,
    });
    expect(DEFAULT_APPEARANCE.theme.dark).toMatchObject({
      panel: '#0C0A09',
      panelRadius: 24,
      cardRadius: 16,
      inputRadius: 999,
      buttonRadius: 999,
    });
  });

  it('renders a layered conversation viewport with accessible icon controls', () => {
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    document.body.append(element);

    const root = element.shadowRoot;
    const region = root?.querySelector('.messages-region');
    const messages = root?.querySelector('.messages');
    const close = root?.querySelector<HTMLButtonElement>('.close');
    const newMessages = root?.querySelector<HTMLButtonElement>('.new-messages');

    expect(region?.contains(messages ?? null)).toBe(true);
    expect(region?.contains(newMessages ?? null)).toBe(true);
    expect(close?.getAttribute('aria-label')).toBe(DEFAULT_APPEARANCE.labels.close);
    expect(close?.textContent).toBe('');
    expect(newMessages?.getAttribute('aria-label')).toBe(DEFAULT_APPEARANCE.labels.newMessages);
    expect(newMessages?.textContent).toBe('');
  });

  it('ships frosted surfaces, rounded controls, scroll fades, and mobile safe areas', () => {
    expect(presentationStyles).toContain('backdrop-filter: blur(var(--ns-assistant-backdrop-blur');
    expect(ASSISTANT_ELEMENT_STYLES).toContain('.messages-region::before');
    expect(ASSISTANT_ELEMENT_STYLES).toContain('.messages-region::after');
    expect(ASSISTANT_ELEMENT_STYLES).toMatch(
      /\.suggested-prompts button \{[^}]*border-radius: 999px/,
    );
    expect(ASSISTANT_ELEMENT_STYLES).toMatch(
      /\.tool-proposal button \{[^}]*--ns-assistant-default-button-radius/,
    );
    expect(ASSISTANT_ELEMENT_STYLES).toMatch(/\.send \{[^}]*border-radius: 999px/);
    expect(ASSISTANT_ELEMENT_STYLES).toMatch(
      /\.send:hover::after \{[^}]*background: var\(--ns-assistant-hover/,
    );
    expect(ASSISTANT_ELEMENT_STYLES).toContain('env(safe-area-inset-bottom)');
    expect(ASSISTANT_ELEMENT_STYLES).toContain('.message.assistant.streaming .markdown::after');
  });

  it('renders customer launcher images without muting their authored colors', () => {
    expect(presentationStyles).toMatch(
      /\.launcher-visual \.launcher-glyph:is\(img\) \{[^}]*width: 28px;[^}]*height: 28px;/,
    );
    expect(presentationStyles).not.toContain('filter: grayscale(100%)');
    expect(presentationStyles).not.toContain(
      '.launcher:hover .launcher-glyph:is(img), :host([launcher-expanded]) .launcher-glyph:is(img)',
    );
  });

  it('uses the public launcher text role for the collapsed launcher label', () => {
    expect(ASSISTANT_ELEMENT_STYLES).toMatch(
      /\.launcher-trigger \{[^}]*color: var\(--ns-assistant-launcher-text,/,
    );
  });

  it('shows scroll fades and the jump control only when content exists beyond that edge', () => {
    const region = document.createElement('div');
    const messages = document.createElement('div');
    const control = document.createElement('button');
    region.append(messages, control);
    Object.defineProperties(messages, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    const scroll = new AssistantElementScrollController();

    scroll.connect({ region, messages, control });
    expect(region.hasAttribute('data-can-scroll-up')).toBe(false);
    expect(region.hasAttribute('data-can-scroll-down')).toBe(true);
    expect(control.hidden).toBe(false);

    messages.scrollTop = 180;
    messages.dispatchEvent(new Event('scroll'));
    expect(region.hasAttribute('data-can-scroll-up')).toBe(true);
    expect(region.hasAttribute('data-can-scroll-down')).toBe(true);

    messages.scrollTop = 700;
    messages.dispatchEvent(new Event('scroll'));
    expect(region.hasAttribute('data-can-scroll-up')).toBe(true);
    expect(region.hasAttribute('data-can-scroll-down')).toBe(false);
    expect(control.hidden).toBe(true);

    scroll.disconnect();
  });

  it('shows the streaming caret only while assistant content is active', () => {
    const element = document.createElement('div');
    const messages = document.createElement('div');
    const controller = new AssistantElementEventController({
      element,
      messages: () => messages,
      appendMessage: (role, text) => {
        const message = document.createElement('div');
        message.className = `message ${role}`;
        const body = document.createElement(role === 'assistant' ? 'div' : 'span');
        body.textContent = text;
        message.append(body);
        messages.append(message);
        return body;
      },
      applyConfiguration: () => undefined,
      showConfirmationDetails: () => true,
      labels: () => DEFAULT_APPEARANCE.labels,
      respond: async () => undefined,
      dispatchError: () => undefined,
      revealLatest: () => undefined,
      renderView: () => undefined,
    });

    controller.handle({ event: 'message_started', data: { message: 'Hello' } });
    controller.handle({ event: 'content', data: { delta: 'Hi there' } });

    expect(messages.querySelector('.message.assistant')?.classList).toContain('streaming');

    controller.handle({ event: 'message_completed', data: {} });

    expect(messages.querySelector('.message.assistant')?.classList).not.toContain('streaming');
  });

  it('keeps the sign-in card on the shared themed chrome', () => {
    // The identity moment can never silently regress to an unstyled block again: the primary
    // selector must cover the sign-in action, and the badge must have real styles.
    expect(ASSISTANT_ELEMENT_STYLES).toContain(
      '.tool-proposal .proposal-accept, .tool-proposal .sign-in-action {',
    );
    expect(ASSISTANT_ELEMENT_STYLES).toContain('.sign-in .sign-in-badge');
  });

  it('renders authored sign-in labels and routes each intent through one event', () => {
    const element = document.createElement('div');
    const messages = document.createElement('div');
    const controller = new AssistantElementEventController({
      element,
      messages: () => messages,
      appendMessage: () => undefined,
      applyConfiguration: () => undefined,
      showConfirmationDetails: () => true,
      labels: () => ({
        ...DEFAULT_APPEARANCE.labels,
        signInHeading: 'Continue with your Acme account',
        signInBody: 'Order history needs an account.',
        signInAction: 'Sign in to Acme',
        signUpAction: 'Create free account',
      }),
      respond: async () => undefined,
      dispatchError: () => undefined,
      revealLatest: () => undefined,
      renderView: () => undefined,
    });
    const details: { intent?: string; signInTicket?: string }[] = [];
    element.addEventListener('assistant-sign-in-requested', (event) => {
      details.push((event as CustomEvent).detail);
    });

    controller.handle({
      event: 'auth_requested',
      data: {
        id: 'elev_1',
        tool: 'my_orders',
        signInTicket: 'elv_abc',
        expiresAt: '2030-01-01T00:10:00.000Z',
      },
    });

    const card = messages.querySelector('.tool-proposal.sign-in');
    expect(card?.querySelector('h3')?.textContent).toBe('Continue with your Acme account');
    expect(card?.querySelector('.proposal-description')?.textContent).toBe(
      'Order history needs an account.',
    );
    card?.querySelector<HTMLButtonElement>('.sign-up-action')?.click();
    expect(details).toEqual([
      {
        id: 'elev_1',
        tool: 'my_orders',
        signInTicket: 'elv_abc',
        expiresAt: '2030-01-01T00:10:00.000Z',
        intent: 'sign-up',
      },
    ]);
  });

  it('renders an app-initiated confirmation without an assistant message stream', () => {
    const element = document.createElement('div');
    const messages = document.createElement('div');
    const controller = new AssistantElementEventController({
      element,
      messages: () => messages,
      appendMessage: () => undefined,
      applyConfiguration: () => undefined,
      showConfirmationDetails: () => true,
      labels: () => DEFAULT_APPEARANCE.labels,
      respond: async () => undefined,
      dispatchError: () => undefined,
      revealLatest: () => undefined,
      renderView: () => undefined,
    });

    controller.handle({
      event: 'tool_proposed',
      data: {
        id: 'app_int_1',
        tool: 'update_account',
        title: 'Update account',
        arguments: { name: 'Widget name' },
        requiresConfirmation: true,
      },
    });

    expect(messages.querySelector('.tool-proposal')?.textContent).toContain('Update account');
    expect(messages.querySelector('.tool-proposal')?.textContent).toContain('Widget name');
  });
});
