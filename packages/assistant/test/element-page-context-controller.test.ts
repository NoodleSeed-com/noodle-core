// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantElementPageContextController } from '../src/element-page-context-controller.js';

function markdownResponse(url: string, content: string): Response {
  const response = new Response(content, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

afterEach(() => {
  history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('AssistantElementPageContextController', () => {
  it('keeps an automatic snapshot only while its page identity is current', async () => {
    const firstUrl = `${location.origin}/first`;
    const secondUrl = `${location.origin}/second`;
    history.replaceState({}, '', '/first');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        if (input === firstUrl) return markdownResponse(firstUrl, '# First');
        if (input === secondUrl) return markdownResponse(secondUrl, '# Second');
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const controller = new AssistantElementPageContextController(() => true);

    await controller.refresh();
    expect(controller.current()).toEqual({
      page: { url: firstUrl, contentType: 'text/markdown', content: '# First' },
    });

    history.replaceState({}, '', '/second?from=first#details');
    expect(controller.current()).toBeUndefined();

    await controller.refresh();
    expect(controller.current()).toEqual({
      page: { url: secondUrl, contentType: 'text/markdown', content: '# Second' },
    });
  });

  it('shares a pending load and drops it when automatic context is disabled', async () => {
    const url = `${location.origin}/pricing`;
    history.replaceState({}, '', '/pricing');
    let resolveFetch: ((response: Response) => void) | undefined;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pendingFetch);
    vi.stubGlobal('fetch', fetchMock);
    let enabled = true;
    const controller = new AssistantElementPageContextController(() => enabled);

    const firstRefresh = controller.refresh();
    const secondRefresh = controller.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    enabled = false;
    resolveFetch?.(markdownResponse(url, '# Pricing'));
    await Promise.all([firstRefresh, secondRefresh]);

    expect(controller.current()).toBeUndefined();
  });

  it('caches no context for a credential-shaped page URL without fetching it', async () => {
    const credentialPath = '/aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccccc';
    history.replaceState({}, '', credentialPath);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AssistantElementPageContextController(() => true);

    await controller.refresh();
    await controller.refresh();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(controller.current()).toBeUndefined();
  });
});
