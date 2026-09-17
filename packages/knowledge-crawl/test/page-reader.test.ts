import { describe, expect, it, vi } from 'vitest';
import { PublicPageReader } from '../src/page-reader.js';

const origin = 'https://example.com';
function fixture(
  page: Response = new Response('<title>Example</title><p>Hello</p>', {
    headers: { 'content-type': 'text/html' },
  }),
) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith('/robots.txt') ? new Response('User-agent: *\nAllow: /') : page,
  );
  return { reader: new PublicPageReader({ fetchImpl }), fetchImpl };
}
function request(url = `${origin}/about`) {
  return { url, signal: new AbortController().signal, beforeRequest: () => {}, maxBytes: 1024 };
}

describe('bounded public-page acquisition', () => {
  it('returns plain text, a real final URL, and bounded unfetched same-origin links', async () => {
    const { reader, fetchImpl } = fixture(
      new Response(
        '<title>Example</title><script>secret()</script><p>Hello &amp; welcome</p>' +
          '<a href="/contact">Contact</a><a href="https://other.example/a">Other</a>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    );
    const page = await reader.read(request());
    expect(page.url).toBe(`${origin}/about`);
    expect(page.text).toContain('Hello & welcome');
    expect(page.text).not.toContain('secret()');
    expect(page.links).toEqual([{ url: `${origin}/contact`, label: 'Contact' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });

  it.each([
    'http://example.com',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://2130706433/',
    'https://169.254.169.254/',
    'https://localhost/',
    'https://metadata.google.internal/',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'https://example.com/?token=secret',
  ])('refuses unsafe input before any request: %s', async (url) => {
    const { reader, fetchImpl } = fixture();
    await expect(reader.read(request(url))).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces an exact-host restriction before I/O', async () => {
    const { reader, fetchImpl } = fixture();
    await expect(reader.read({ ...request(), domains: ['allowed.example'] })).rejects.toMatchObject(
      { code: 'capability_source_rejected' },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500, 503])('fails closed on robots HTTP %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status }));
    await expect(new PublicPageReader({ fetchImpl }).read(request())).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honors specific bot rules and wildcard/end-anchor rules', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('User-agent: *\nAllow: /\nUser-agent: NoodleSeedBot\nDisallow: /a*out$\n'),
    );
    await expect(new PublicPageReader({ fetchImpl }).read(request())).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('permits a missing robots file, but not a failed request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/robots.txt')
        ? new Response('', { status: 404 })
        : new Response('<p>Readable</p>', { headers: { 'content-type': 'text/html' } }),
    );
    expect((await new PublicPageReader({ fetchImpl }).read(request())).text).toBe('Readable');
    fetchImpl.mockRejectedValue(new Error('network details must not escape'));
    await expect(new PublicPageReader({ fetchImpl }).read(request())).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
  });

  it('validates a redirect before requesting its destination', async () => {
    const { reader, fetchImpl } = fixture(
      new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/admin' },
      }),
    );
    await expect(reader.read(request())).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not follow off-scope redirects', async () => {
    const { reader, fetchImpl } = fixture(
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.example/' },
      }),
    );
    await expect(reader.read({ ...request(), domains: ['example.com'] })).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('counts robots and redirects against the same outbound budget', async () => {
    const beforeRequest = vi.fn(() => {
      throw new Error('budget refused');
    });
    const { reader, fetchImpl } = fixture();
    await expect(reader.read({ ...request(), beforeRequest })).rejects.toThrow();
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels an oversized streaming response before reading the whole body', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(800));
      },
      cancel,
    });
    const { reader } = fixture(new Response(stream, { headers: { 'content-type': 'text/html' } }));
    await expect(reader.read(request())).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
    expect(cancel).toHaveBeenCalled();
    expect(pulls).toBeLessThan(6);
  });

  it('refuses unsupported content and cancels its body', async () => {
    const cancel = vi.fn();
    const { reader } = fixture(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    await expect(reader.read(request())).rejects.toMatchObject({
      code: 'capability_source_rejected',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('does no work after cancellation', async () => {
    const { reader, fetchImpl } = fixture();
    const signal = AbortSignal.abort();
    await expect(reader.read({ ...request(), signal })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handles invalid numeric HTML entities without throwing or executing markup', async () => {
    const { reader } = fixture(
      new Response('<p>Good &#9999999999999999999; &#xD800;</p>', {
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect((await reader.read(request())).text).toContain('Good');
  });
});
