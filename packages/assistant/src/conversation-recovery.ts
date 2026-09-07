export interface ConversationRecoveryAction {
  readonly label: string;
  readonly run: () => void;
}

/** Replace the one transcript recovery card while preserving accessible refusal semantics. */
export function appendConversationRecovery(input: {
  readonly messages: HTMLElement | undefined;
  readonly message: string;
  readonly action?: ConversationRecoveryAction;
  readonly revealLatest: () => void;
}): void {
  if (!input.messages) return;
  input.messages.querySelector('.conversation-error')?.remove();
  const error = document.createElement('section');
  error.className = 'conversation-error';
  // A capacity limit is expected state, so announce it politely unless there is a recovery action.
  error.setAttribute('role', input.action ? 'alert' : 'status');
  const text = document.createElement('p');
  text.textContent = input.message;
  error.append(text);
  if (input.action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = input.action.label;
    button.addEventListener('click', input.action.run);
    error.append(button);
  }
  input.messages.append(error);
  input.revealLatest();
}
