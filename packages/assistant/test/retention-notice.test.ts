// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AssistantClientEvent, createAssistantClient } from '../src/client.js';
import { NoodleAssistantElement } from '../src/index.js';

/** The retention notice every recorded conversation states (ADR 0241 decision 17). */
const session = (extra: Record<string, unknown> = {}) =>
  Response.json({
    token: 'token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: { turns: '/turns', toolConfirmations: '/confirm' },
    ...extra,
  });

async function mounted(extra: Record<string, unknown>) {
  const element = new NoodleAssistantElement();
  element.sessionEndpoint = '/session';
  element.fetch = vi.fn<typeof fetch>().mockResolvedValue(session(extra));
  document.body.append(element);
  await vi.waitFor(() => expect(element.hasAttribute('data-presentation-ready')).toBe(true));
  return element;
}

const footer = (element: HTMLElement) =>
  element.shadowRoot?.querySelector('.legal .history-notice')?.textContent;

afterEach(() => {
  document.body.replaceChildren();
});

describe('conversation retention notice', () => {
  it.each([
    [{ history: { retentionDays: 30 } }, { retentionDays: 30 }],
    [{ history: { retentionDays: 0 } }, undefined],
    [{ history: { retentionDays: '30' } }, undefined],
    [{}, undefined],
  ])('carries only a well-formed notice on session_started: %j', async (extra, expected) => {
    const events: AssistantClientEvent[] = [];
    const client = createAssistantClient({
      sessionEndpoint: '/session',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(session(extra)),
    });
    client.subscribe((event) => events.push(event));
    await client.connect();
    const started = events.find((event) => event.event === 'session_started');
    expect(started?.data).toEqual({
      expiresAt: '2030-01-01T00:00:00Z',
      ...(expected ? { history: expected } : {}),
    });
  });

  it('states the window in the footer beside the legal links', async () => {
    const element = await mounted({
      history: { retentionDays: 30 },
      configuration: { assistant: { privacyUrl: 'https://acme.example/privacy' } },
    });
    await vi.waitFor(() => expect(footer(element)).toBe('Chats are kept for 30 days'));
    expect(element.shadowRoot?.querySelector<HTMLAnchorElement>('.legal a')?.href).toBe(
      'https://acme.example/privacy',
    );
  });

  it('uses the singular for a one-day window, even without any configuration', async () => {
    const element = await mounted({ history: { retentionDays: 1 } });
    await vi.waitFor(() => expect(footer(element)).toBe('Chats are kept for 1 day'));
  });

  it('states nothing when the conversation is not recorded', async () => {
    const element = await mounted({});
    expect(footer(element)).toBeUndefined();
    expect(element.shadowRoot?.querySelector('.legal')?.childElementCount).toBe(0);
  });

  it('opens the panel before accepting input so the notice is seen first', async () => {
    const element = await mounted({ history: { retentionDays: 30 } });
    element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger')?.click();
    expect(element.hasAttribute('open')).toBe(true);
    expect(element.hasAttribute('launcher-expanded')).toBe(false);
  });

  it('keeps the inline launcher when there is no notice to show first', async () => {
    const element = await mounted({});
    element.shadowRoot?.querySelector<HTMLButtonElement>('.launcher-trigger')?.click();
    expect(element.hasAttribute('launcher-expanded')).toBe(true);
    expect(element.hasAttribute('open')).toBe(false);
  });
});
