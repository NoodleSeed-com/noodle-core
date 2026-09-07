import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAssistantEmbedScript } from '../src/routes/assistant-embed-script.js';

/**
 * The script a marketing page loads.
 *
 * Unauthenticated and cross-origin by construction: it carries no tenant material, and which origins may
 * actually talk to the assistant is decided at mint time against the surface's allowlist — never by who
 * was allowed to download this file.
 */

let http: Server;
let base: string;

beforeEach(async () => {
  http = createServer(handleAssistantEmbedScript);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/assistant/embed.js`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

describe('GET /v1/assistant/embed.js', () => {
  it('serves the browser bundle to any origin', async () => {
    const response = await fetch(base);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect((await response.text()).length).toBeGreaterThan(1000);
  });

  it('ships no secret and no tenant identity', async () => {
    const body = await (await fetch(base)).text();

    // The embed id that selects a tenant travels as a data- attribute on the customer's own page; the
    // script itself is the same bytes for every customer.
    expect(body).not.toContain('pub_');
    expect(body.toLowerCase()).not.toContain('secret_hash');
  });

  /**
   * Content-derived, so a service redeploy that did not change the bundle keeps every visitor's cache
   * warm instead of re-shipping 650 KB to each of them.
   */
  it('revalidates against a content ETag', async () => {
    const first = await fetch(base);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await fetch(base, { headers: { 'if-none-match': etag as string } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('refuses a method that could only be a mistake', async () => {
    const response = await fetch(base, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
