// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAssistantClientEvent } from '../src/events.js';
import { createSignInCard } from '../src/sign-in-card.js';

afterEach(() => {
  document.body.replaceChildren();
});

const card = (
  onAction = vi.fn(),
  labels: Partial<Parameters<typeof createSignInCard>[0]['labels']> = {},
) => {
  const element = createSignInCard({
    tool: 'my_orders',
    signInTicket: 'elv_abc',
    expiresAt: '2030-01-01T00:10:00.000Z',
    labels: {
      heading: 'Sign in to continue',
      body: '',
      action: 'Sign in',
      signUpAction: '',
      ...labels,
    },
    onAction,
  });
  document.body.append(element);
  return { element, onAction };
};

describe('sign-in card', () => {
  it('renders on the themed proposal chrome, not the retired unstyled classes', () => {
    const { element } = card();
    // The card must visually belong beside its sibling proposal cards: same chrome, plus a
    // sign-in modifier. The old noodle-assistant-* classes had no stylesheet and must not return.
    expect(element.classList.contains('tool-proposal')).toBe(true);
    expect(element.classList.contains('sign-in')).toBe(true);
    expect(element.outerHTML).not.toContain('noodle-assistant');
    expect(element.querySelector('.sign-in-badge')?.getAttribute('aria-hidden')).toBe('true');
    expect(element.querySelector('h3')?.textContent).toBe('Sign in to continue');
    expect(element.getAttribute('role')).toBe('status');
    expect(element.dataset.tool).toBe('my_orders');
  });

  it('renders the body only when authored', () => {
    const { element } = card();
    expect(element.querySelector('.proposal-description')).toBeNull();

    const withBody = card(vi.fn(), { body: 'Your order history needs an account.' });
    expect(withBody.element.querySelector('.proposal-description')?.textContent).toBe(
      'Your order history needs an account.',
    );
  });

  it('asks the host to sign the visitor in, and never collects credentials itself', () => {
    const { element, onAction } = card();

    element.querySelector('button')?.click();
    expect(onAction).toHaveBeenCalledExactlyOnceWith('sign-in');

    // The host application is the identity authority (ADR 0141). A field here would be a second
    // identity provider the customer never agreed to operate.
    expect(element.querySelector('input')).toBeNull();
    expect(element.querySelector('form')).toBeNull();
    expect(element.innerHTML).not.toContain('password');
  });

  it('renders no sign-up button unless the label is authored', () => {
    const { element } = card();
    expect(element.querySelector('.sign-up-action')).toBeNull();
  });

  it('renders an authored sign-up button after the primary action and routes its intent', () => {
    const onAction = vi.fn();
    const { element } = card(onAction, { signUpAction: 'Create free account' });

    const buttons = [...element.querySelectorAll('button')];
    expect(buttons.map((button) => button.className)).toEqual(['sign-in-action', 'sign-up-action']);
    expect(buttons[1]?.textContent).toBe('Create free account');

    buttons[1]?.click();
    expect(onAction).toHaveBeenCalledExactlyOnceWith('sign-up');
  });

  it('cannot open two logins from one prompt, whichever button was pressed', () => {
    const onAction = vi.fn();
    const { element } = card(onAction, { signUpAction: 'Create free account' });
    const [signIn, signUp] = [...element.querySelectorAll('button')];

    signIn?.click();
    // The sign-in ticket is single-use in the store; one card yields one host routing, so either
    // press disables both buttons.
    expect(signIn?.disabled).toBe(true);
    expect(signUp?.disabled).toBe(true);
    signIn?.click();
    signUp?.click();
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('does not print the sign-in ticket where a visitor can read it', () => {
    const { element } = card();
    // It is not a secret, but it is not for the visitor either: surfacing it invites a paste into a
    // support chat, and the page already receives it through the event.
    expect(element.textContent).not.toContain('elv_abc');
  });
});

describe('auth_requested on the wire', () => {
  it('parses a complete event and rejects an incomplete one', () => {
    const complete = toAssistantClientEvent({
      event: 'auth_requested',
      data: {
        id: 'elev_1',
        tool: 'my_orders',
        signInTicket: 'elv_abc',
        expiresAt: '2030-01-01T00:10:00.000Z',
      },
    });
    expect(complete.event).toBe('auth_requested');
    expect(complete.event === 'auth_requested' && complete.data.signInTicket).toBe('elv_abc');

    // A prompt with no ticket is a dead end for the page, so it must not render as one.
    const partial = toAssistantClientEvent({
      event: 'auth_requested',
      data: { id: 'elev_1', tool: 'my_orders' },
    });
    expect(partial.event).toBe('unrecognized');
  });

  it('accepts the legacy `continuation` key from services published before the rename', () => {
    const legacy = toAssistantClientEvent({
      event: 'auth_requested',
      data: {
        id: 'elev_1',
        tool: 'my_orders',
        continuation: 'elv_abc',
        expiresAt: '2030-01-01T00:10:00.000Z',
      },
    });
    expect(legacy.event).toBe('auth_requested');
    // Normalized: a listener written today reads `signInTicket` regardless of the service's age.
    expect(legacy.event === 'auth_requested' && legacy.data.signInTicket).toBe('elv_abc');
  });
});
