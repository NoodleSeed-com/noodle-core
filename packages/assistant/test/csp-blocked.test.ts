import { describe, expect, it, vi } from 'vitest';
import { type AssistantClientError, createAssistantClient } from '../src/client.js';

/**
 * The detectable half of a Content-Security-Policy failure.
 *
 * A page whose `script-src` blocks the embed script cannot report it — no widget code runs at all, which
 * is why `noodle check` names those directives before deploy. But a page that loads the script and then
 * blocks `connect-src` fails inside the widget, as a bare network rejection with no status and no body.
 * "Assistant request failed" sends a developer hunting; naming the directive and the origin ends it.
 */

const blockedFetch = () =>
  vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));

describe('a mint the embedding page blocked', () => {
  it('names the directive and the origin the page must allow', async () => {
    const client = createAssistantClient({
      embedId: 'pub_abc',
      serviceUrl: 'https://cloud.test',
      fetch: blockedFetch(),
    });

    const error = (await client.connect().catch((e: unknown) => e)) as AssistantClientError;
    expect(error.detail.serviceCode).toBe('blocked_by_page');
    expect(error.message).toContain('connect-src');
    expect(error.message).toContain('https://cloud.test');
  });

  it('is retryable, because the page may simply have been offline', async () => {
    const client = createAssistantClient({ embedId: 'pub_abc', fetch: blockedFetch() });
    const error = (await client.connect().catch((e: unknown) => e)) as AssistantClientError;

    // A blocked request and a dropped connection are indistinguishable from here, so the message
    // covers both and the retry stays.
    expect(error.detail.retryable).toBe(true);
  });

  it('leaves the in-app backend exchange alone', async () => {
    const client = createAssistantClient({
      sessionEndpoint: '/api/assistant/session',
      fetch: blockedFetch(),
    });

    // Same-origin by construction: a CSP hint here would be a guess, and the customer's own backend
    // failing is an ordinary outage.
    const error = (await client.connect().catch((e: unknown) => e)) as AssistantClientError;
    expect(error.detail.serviceCode).toBeUndefined();
  });
});
