// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_TAG_NAME,
  type NoodleAssistantElement,
  registerNoodleAssistant,
} from '../src/element.js';

function stream(...frames: readonly string[]): Response {
  return new Response(`${frames.join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('managed assistant suggested prompts', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('loads generated initial prompts on open and replaces them with turn-specific follow-ups', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === '/api/assistant/session') {
        return Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: '/turns',
            toolConfirmations: '/confirmations',
            suggestions: '/suggestions',
          },
          configuration: { branding: { name: 'Acme' } },
        });
      }
      if (path === '/suggestions') {
        return stream(
          'event: suggested_prompts\ndata: {"phase":"initial","prompts":["Review billing","Show limits"]}',
          'event: done\ndata: {}',
        );
      }
      if (path === '/turns') {
        return stream(
          'event: content\ndata: {"delta":"Your plan is active."}',
          'event: suggested_prompts\ndata: {"phase":"follow_up","prompts":["Compare plans","Add seats"]}',
          'event: done\ndata: {}',
        );
      }
      throw new Error(`unexpected request: ${path}`);
    });
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    element.fetch = fetchMock;
    document.body.append(element);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    element.open();
    await vi.waitFor(() => {
      expect(
        [...(element.shadowRoot?.querySelectorAll('.suggested-prompts button') ?? [])].map(
          (button) => button.textContent,
        ),
      ).toEqual(['Review billing', 'Show limits']);
    });

    await element.sendMessage('What is included?');
    expect(
      [...(element.shadowRoot?.querySelectorAll('.suggested-prompts button') ?? [])].map(
        (button) => button.textContent,
      ),
    ).toEqual(['Compare plans', 'Add seats']);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
      message: 'What is included?',
      suggestions: true,
    });
    element.shadowRoot?.querySelector<HTMLButtonElement>('.suggested-prompts button')?.click();
    await vi.waitFor(() => {
      expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
        message: 'Compare plans',
        suggestions: true,
      });
    });
  });

  it('renders exact configured initial prompts and treats an explicit empty list as none', async () => {
    registerNoodleAssistant();
    for (const [configured, expected] of [
      [['Ask about orders'], ['Ask about orders']],
      [[], []],
    ] as const) {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        Response.json({
          token: `token-${expected.length}`,
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: '/turns',
            toolConfirmations: '/confirmations',
            suggestions: '/suggestions',
          },
          configuration: { assistant: { suggestedPrompts: configured } },
        }),
      );
      const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
      element.sessionEndpoint = `/session-${expected.length}`;
      element.fetch = fetchMock;
      const sessionStarted = new Promise<void>((resolve) => {
        element.addEventListener('assistant-session-started', () => resolve(), { once: true });
      });
      document.body.append(element);
      element.open();
      await sessionStarted;
      expect(
        [...(element.shadowRoot?.querySelectorAll('.suggested-prompts button') ?? [])].map(
          (button) => button.textContent,
        ),
      ).toEqual(expected);
      expect(fetchMock.mock.calls.some(([input]) => String(input) === '/suggestions')).toBe(false);
      element.remove();
    }
  });
});
