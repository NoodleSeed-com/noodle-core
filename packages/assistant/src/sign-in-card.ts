/**
 * The card a visitor sees when a capability needs them signed in (ADR 0201, 5.6b).
 *
 * It has **no login of its own, and never will**: the host application is the identity authority
 * (ADR 0141), so this renders a prompt and raises an event, and the page does the rest. A sign-in form
 * here would be a second identity provider that the customer did not ask for and cannot govern.
 * Sign-up is the same host-routed moment; the ticket spend does not care whether the visitor
 * registered or signed in.
 *
 * The sign-in ticket reaches the page because the page's own backend has to spend it. That is safe only
 * because spending also requires the customer's client credentials, which never leave their server.
 */

type SignInCardIntent = 'sign-in' | 'sign-up';

export interface SignInCardOptions {
  readonly tool: string;
  readonly signInTicket: string;
  readonly expiresAt: string;
  readonly labels: {
    readonly heading: string;
    readonly body: string;
    readonly action: string;
    readonly signUpAction: string;
  };
  readonly onAction: (intent: SignInCardIntent) => void;
}

export function createSignInCard(options: SignInCardOptions): HTMLElement {
  const card = document.createElement('div');
  card.className = 'tool-proposal sign-in';
  card.dataset.tool = options.tool;
  // Announced, because a visitor using a screen reader has to learn the conversation is waiting on them.
  card.setAttribute('role', 'status');

  const badge = document.createElement('span');
  badge.className = 'sign-in-badge';
  badge.setAttribute('aria-hidden', 'true');
  card.append(badge);

  const heading = document.createElement('h3');
  heading.textContent = options.labels.heading;
  card.append(heading);

  if (options.labels.body) {
    const body = document.createElement('p');
    body.className = 'proposal-description';
    body.textContent = options.labels.body;
    card.append(body);
  }

  const actions = document.createElement('div');
  actions.className = 'proposal-actions';
  const buttons: HTMLButtonElement[] = [];
  const act = (intent: SignInCardIntent): void => {
    // Single-use in the UI as well as in the store: one card yields one host routing, so either
    // press disables both buttons and a second press cannot open a second login.
    for (const button of buttons) button.disabled = true;
    options.onAction(intent);
  };

  const signIn = document.createElement('button');
  signIn.type = 'button';
  signIn.className = 'sign-in-action';
  signIn.textContent = options.labels.action;
  signIn.addEventListener('click', () => act('sign-in'));
  buttons.push(signIn);
  actions.append(signIn);

  if (options.labels.signUpAction) {
    const signUp = document.createElement('button');
    signUp.type = 'button';
    signUp.className = 'sign-up-action';
    signUp.textContent = options.labels.signUpAction;
    signUp.addEventListener('click', () => act('sign-up'));
    buttons.push(signUp);
    actions.append(signUp);
  }

  card.append(actions);
  return card;
}
