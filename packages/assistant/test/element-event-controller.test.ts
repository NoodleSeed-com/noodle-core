// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPEARANCE } from '../src/appearance.js';
import { AssistantElementEventController } from '../src/element-event-controller.js';

afterEach(() => {
  document.body.replaceChildren();
});

function controllerWithSpies() {
  const element = document.createElement('div');
  const messages = document.createElement('div');
  element.append(messages);
  document.body.append(element);
  const revealLatest = vi.fn();
  const revealInteraction = vi.fn();
  const controller = new AssistantElementEventController({
    element,
    messages: () => messages,
    appendMessage: (role, text) => {
      const body = document.createElement('div');
      body.className = `message ${role}`;
      body.textContent = text;
      messages.append(body);
      return body;
    },
    applyConfiguration: () => undefined,
    showConfirmationDetails: () => true,
    labels: () => DEFAULT_APPEARANCE.labels,
    respond: async () => undefined,
    dispatchError: () => undefined,
    revealLatest,
    revealInteraction,
    renderView: () => undefined,
  });
  return { controller, messages, revealLatest, revealInteraction };
}

describe('cards that block the conversation are always revealed', () => {
  // A visitor who scrolled up inside a tall widget form and pressed "Review and send" must see
  // the confirmation card that press raised: it is the only way forward, so it never stays
  // hidden below the fold the way an ordinary streamed reply may.
  it('reveals a confirmation card even when the visitor is not following the latest message', () => {
    const { controller, messages, revealInteraction } = controllerWithSpies();

    controller.handle({
      event: 'tool_proposed',
      data: { id: 'interaction_1', tool: 'submit_workflow_consultation', arguments: {} },
    });

    expect(messages.children).toHaveLength(1);
    expect(revealInteraction).toHaveBeenCalledTimes(1);
  });

  it('reveals an input request and a sign-in card the same way', () => {
    const { controller, revealInteraction } = controllerWithSpies();

    controller.handle({
      event: 'input_requested',
      data: { id: 'interaction_2', message: 'Which date?', requestedSchema: { type: 'object' } },
    });
    controller.handle({
      event: 'auth_requested',
      data: {
        id: 'interaction_3',
        tool: 'my_onboarding_status',
        signInTicket: 'ticket',
        expiresAt: '2030-01-01T00:00:00Z',
      },
    });

    expect(revealInteraction).toHaveBeenCalledTimes(2);
  });

  it('leaves ordinary messages on the follow-the-latest rule', () => {
    const { controller, revealLatest, revealInteraction } = controllerWithSpies();

    controller.handle({ event: 'message_started', data: { message: 'Hello' } });
    controller.handle({ event: 'content', data: { delta: 'Hi' } });

    expect(revealLatest).toHaveBeenCalled();
    expect(revealInteraction).not.toHaveBeenCalled();
  });
});
